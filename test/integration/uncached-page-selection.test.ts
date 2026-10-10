import { describe, expect, inject, it, vi } from "vitest";
import puppeteer, { type Browser, type Dialog, type Page } from "puppeteer-core";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";

function within<T>(operation: Promise<T>, ms = 1500): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    operation,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${ms}ms 内未返回`)), ms); })
  ]).finally(() => clearTimeout(timer));
}

function pageId(page: Page): string {
  return (page.target() as unknown as { _targetId: string })._targetId;
}

interface ForeignAlert {
  page: Page;
  context?: Awaited<ReturnType<Browser["createBrowserContext"]>>;
  dialog: Dialog;
  evaluation: Promise<unknown>;
  isOpen: () => boolean;
}

async function foreignAlert(browser: Browser, separateContext = false): Promise<ForeignAlert> {
  const context = separateContext ? await browser.createBrowserContext() : undefined;
  const page = context ? await context.newPage() : await browser.newPage();
  const opened = new Promise<Dialog>((resolve) => page.once("dialog", resolve));
  let open = true;
  const evaluation = page.evaluate(() => alert("foreign cold alert")).then(() => { open = false; });
  return { page, context, dialog: await opened, evaluation, isOpen: () => open };
}

async function dismiss(alert: ForeignAlert | undefined): Promise<void> {
  await alert?.dialog.dismiss().catch(() => {});
  await alert?.evaluation.catch(() => {});
}

describe("未缓存页面的选择", () => {
  it("首次连接不等待外来冷页面弹窗", async () => {
    const external = await puppeteer.connect({ browserURL: inject("browserURL"), defaultViewport: null });
    let alert: ForeignAlert | undefined, connecting: Promise<BrowserSession> | undefined, session: BrowserSession | undefined;
    try {
      alert = await foreignAlert(external);
      connecting = BrowserSession.connect(inject("browserURL"));
      session = await within(connecting);
      expect(alert.isOpen()).toBe(true);
      expect(session.handleCount()).toBe(0);
    } finally {
      await dismiss(alert);
      session ??= await connecting?.catch(() => undefined);
      await session?.close();
      await alert?.page.close().catch(() => {});
      await alert?.context?.close().catch(() => {});
      external.disconnect();
    }
  });

  for (const firstConnect of [false, true]) {
    it.each(["explicit", "selected", "implicit", "list_pages"] as const)(
      `${firstConnect ? "首次连接" : "已连接"} %s：只访问所需目标，保持外来冷 alert`,
      async (mode) => {
        const external = await puppeteer.connect({ browserURL: inject("browserURL"), defaultViewport: null });
        const normal = await external.newPage();
        const initial = (await external.pages())[0];
        const normalId = pageId(normal), initialId = pageId(initial);
        const session = firstConnect ? BrowserSession.lazy(inject("browserURL")) : await BrowserSession.connect(inject("browserURL"));
        let alert: ForeignAlert | undefined, selecting: Promise<PageHandle> | undefined;
        let listing: ReturnType<BrowserSession["listPages"]> | undefined;
        try {
          alert = await foreignAlert(external, mode === "implicit");
          expect(session.handleCount()).toBe(0);
          if (mode === "list_pages") {
            session.selectPage(normalId);
            listing = session.listPages();
            const pages = await within(listing);
            expect(pages.some((entry) => entry.pageId === pageId(alert!.page))).toBe(true);
            expect(pages.some((entry) => entry.pageId === normalId)).toBe(true);
            expect(session.handleCount()).toBe(0);
            // 首次连接重置旧选择；已连接列表则不能改写选择。
            if (!firstConnect) expect(session.currentPageId()).toBe(normalId);
          } else {
            if (mode === "selected") {
              // firstConnect 的连接必须先完成，否则建立连接会重置未绑定连接的选择。
              if (firstConnect) await within(session.listPages());
              session.selectPage(normalId);
            }
            selecting = session.getPage(mode === "explicit" ? normalId : undefined);
            const handle = await within(selecting);
            if (mode === "implicit") expect([initialId, normalId]).toContain(handle.pageId);
            else expect(handle.pageId).toBe(normalId);
            expect(session.currentPageId()).toBe(handle.pageId);
            expect(session.allHandles()).toEqual([handle]);
            const { result } = await handle.cdp.send("Runtime.evaluate", { expression: "1 + 1", returnByValue: true });
            expect(result.value).toBe(2);
          }
          expect(alert.isOpen()).toBe(true);
        } finally {
          // RED 时页面初始化正在等待 alert；先释放弹窗再等待原调用，保证失败不会污染后续测试。
          await dismiss(alert);
          await selecting?.catch(() => {});
          await listing?.catch(() => {});
          await session.close();
          await alert?.page.close().catch(() => {});
          await alert?.context?.close().catch(() => {});
          await normal.close().catch(() => {});
          external.disconnect();
        }
      }
    );
  }
});


describe("冷目标初始化预算", () => {
  it("目标自己的冷 alert 超时后释放选择队列，迟到初始化不能改选或登记句柄", async () => {
    const external = await puppeteer.connect({ browserURL: inject("browserURL"), defaultViewport: null });
    const normal = await external.newPage();
    const session = await BrowserSession.connect(inject("browserURL"), { pageTimeoutMs: 1000 });
    let alert: ForeignAlert | undefined, selecting: Promise<PageHandle> | undefined;
    try {
      alert = await foreignAlert(external);
      const coldId = pageId(alert.page), normalId = pageId(normal);
      selecting = session.getPage(coldId);
      const failure = await within(selecting).catch((error) => error);
      expect(failure.message).toMatch(/初始化.*1000.*弹窗/);
      expect(failure).toMatchObject({ code: "page-initialization-deadline", retryBlocked: true, timeoutMs: 1000 });
      expect(alert.isOpen()).toBe(true);
      expect(session.handleCount()).toBe(0);
      expect(session.currentPageId()).toBeUndefined();
      const handle = await within(session.getPage(normalId));
      expect(handle.pageId).toBe(normalId);
      expect(alert.isOpen()).toBe(true);
      await dismiss(alert);
      // 显式重试等待同一 Puppeteer pagePromise；早先取消的调用先恢复，仍不能登记/改选。
      const recovered = await within(session.getPage(coldId));
      expect(recovered.pageId).toBe(coldId);
      expect(session.handleCount()).toBe(2);
      expect(session.currentPageId()).toBe(coldId);
      expect((await session.listPages()).some((entry) => entry.pageId === coldId)).toBe(true);
    } finally {
      await dismiss(alert);
      await selecting?.catch(() => {});
      await session.close();
      await alert?.page.close().catch(() => {});
      await alert?.context?.close().catch(() => {});
      await normal.close().catch(() => {});
      external.disconnect();
    }
  });

  it.each([0, 99, 300001, NaN, Infinity, 100.5])("拒绝无效 pageTimeoutMs=%s", (pageTimeoutMs) => {
    expect(() => BrowserSession.lazy(inject("browserURL"), { pageTimeoutMs })).toThrow(/pageTimeoutMs/);
  });
});


describe("迟到页面装配的隔离", () => {
  it.each(["timeout", "reconnect"] as const)("%s：迟到 CDP session 被释放，不登记句柄或改写新选择", async (mode) => {
    const session = await BrowserSession.connect(inject("browserURL"), { pageTimeoutMs: 1000 });
    const base = await session.newPage();
    const delayed = await base.page.browser().newPage();
    await session.getPage(base.pageId);
    let entered!: () => void, release!: () => void;
    const entering = new Promise<void>((resolve) => { entered = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    let cdp: Awaited<ReturnType<Page["createCDPSession"]>> | undefined;
    const original = delayed.createCDPSession.bind(delayed);
    const spy = vi.spyOn(delayed, "createCDPSession").mockImplementation(async () => {
      cdp = await original();
      entered();
      await released;
      return cdp;
    });
    const selecting = session.getPage(pageId(delayed));
    const rejected = expect(within(selecting)).rejects.toThrow(/初始化|连接.*取消/);
    try {
      await entering;
      if (mode === "reconnect") await session.close();
      await rejected;
      const chosen = await within(session.getPage(base.pageId));
      expect(chosen.pageId).toBe(base.pageId);
      release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await expect(cdp!.send("Target.getTargetInfo")).rejects.toThrow(/closed|detached|session/i);
      expect(session.allHandles()).toEqual([chosen]);
      expect(session.currentPageId()).toBe(base.pageId);
      expect((await session.listPages()).some((entry) => entry.pageId === pageId(delayed))).toBe(true);
    } finally {
      release();
      await selecting.catch(() => {});
      spy.mockRestore();
      await session.close();
      await delayed.close().catch(() => {});
      await base.page.close().catch(() => {});
    }
  });
});


describe("迟到首次连接的隔离", () => {
  it.each(["timeout", "reconnect"] as const)("%s：旧连接迟到返回时断开，不污染重连后的句柄与选择", async (mode) => {
    const external = await puppeteer.connect({ browserURL: inject("browserURL"), defaultViewport: null });
    const normal = await external.newPage();
    const normalId = pageId(normal);
    let entered!: () => void, release!: () => void;
    const entering = new Promise<void>((resolve) => { entered = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    let oldBrowser: Browser | undefined;
    const original = puppeteer.connect.bind(puppeteer);
    const spy = vi.spyOn(puppeteer, "connect").mockImplementationOnce(async (options) => {
      oldBrowser = await original(options);
      entered();
      await released;
      return oldBrowser;
    });
    const session = BrowserSession.lazy(inject("browserURL"), { pageTimeoutMs: 1000 });
    const selecting = session.getPage(normalId);
    const rejected = expect(within(selecting)).rejects.toThrow(/初始化|连接.*取消/);
    try {
      await entering;
      if (mode === "reconnect") await session.close();
      await rejected;
      const chosen = await within(session.getPage(normalId));
      release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(oldBrowser!.connected).toBe(false);
      expect(session.allHandles()).toEqual([chosen]);
      expect(session.currentPageId()).toBe(normalId);
      expect((await session.listPages()).some((entry) => entry.pageId === normalId)).toBe(true);
      const { result } = await chosen.cdp.send("Runtime.evaluate", { expression: "40 + 2", returnByValue: true });
      expect(result.value).toBe(42);
    } finally {
      release();
      await selecting.catch(() => {});
      spy.mockRestore();
      await session.close();
      oldBrowser?.disconnect();
      await normal.close().catch(() => {});
      external.disconnect();
    }
  });
});


describe("隔离页面有界清理", () => {
  it.each(["detach", "context-close"] as const)("%s 阻塞：release 在共享预算内返回，迟到只关闭自建 context", async (mode) => {
    const session = await BrowserSession.connect(inject("browserURL"));
    const user = await session.newPage();
    await session.getPage(user.pageId);
    const isolated = await session.newIsolatedPage();
    const context = isolated.handle.page.browserContext();
    const browser = user.page.browser();
    const userId = user.pageId;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const originalDetach = isolated.handle.cdp.detach.bind(isolated.handle.cdp);
    const originalClose = context.close.bind(context);
    const spy = mode === "detach"
      ? vi.spyOn(isolated.handle.cdp, "detach").mockImplementation(async () => { await gate; await originalDetach(); })
      : vi.spyOn(context, "close").mockImplementation(async () => { await gate; await originalClose(); });
    const diagnostics: string[] = [];
    const diagnosticSpy = vi.spyOn(console, "error").mockImplementation((message) => { diagnostics.push(String(message)); });
    const releasing = isolated.release();
    try {
      await within(Promise.all([releasing, isolated.release()]), 2500);
      expect(diagnostics.some((message) => /清理.*2000ms.*未确认/.test(message))).toBe(true);
      expect(session.currentPageId()).toBe(userId);
      expect(user.page.isClosed()).toBe(false);
      if (mode === "detach") expect(isolated.handle.page.isClosed()).toBe(true);
      release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await expect.poll(() => browser.browserContexts().includes(context)).toBe(false);
      expect(session.allHandles()).toEqual([user]);
    } finally {
      release();
      await releasing.catch(() => {});
      spy.mockRestore();
      diagnosticSpy.mockRestore();
      await context.close().catch(() => {});
      await session.close();
      await user.page.close().catch(() => {});
    }
  });
});


describe("隔离页面创建失败的清理", () => {
  it("装配失败时即使 context.close 延迟，也在清理预算后报告原错误并最终关闭自建 context", async () => {
    const session = await BrowserSession.connect(inject("browserURL"));
    const user = await session.newPage();
    await session.getPage(user.pageId);
    const browser = user.page.browser();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const originalCreate = browser.createBrowserContext.bind(browser);
    let context: Awaited<ReturnType<Browser["createBrowserContext"]>> | undefined;
    const contextSpy = vi.spyOn(browser, "createBrowserContext").mockImplementationOnce(async () => {
      context = await originalCreate();
      const originalClose = context.close.bind(context);
      vi.spyOn(context, "close").mockImplementation(async () => { await gate; await originalClose(); });
      const originalPage = context.newPage.bind(context);
      vi.spyOn(context, "newPage").mockImplementationOnce(async () => {
        const page = await originalPage();
        vi.spyOn(page, "createCDPSession").mockRejectedValueOnce(new Error("isolated setup failed"));
        return page;
      });
      return context;
    });
    const diagnostics: string[] = [];
    const diagnosticSpy = vi.spyOn(console, "error").mockImplementation((message) => { diagnostics.push(String(message)); });
    const creating = session.newIsolatedPage();
    try {
      await expect(within(creating, 2500)).rejects.toThrow("isolated setup failed");
      expect(diagnostics.some((message) => /清理.*2000ms.*未确认/.test(message))).toBe(true);
      expect(user.page.isClosed()).toBe(false);
      expect(session.currentPageId()).toBe(user.pageId);
      release();
      await expect.poll(() => browser.browserContexts().includes(context!)).toBe(false);
      expect(session.allHandles()).toEqual([user]);
    } finally {
      release();
      await creating.catch(() => {});
      vi.restoreAllMocks();
      await context?.close().catch(() => {});
      contextSpy.mockRestore();
      diagnosticSpy.mockRestore();
      await session.close();
      await user.page.close().catch(() => {});
    }
  });
});


describe("新目标创建与初始化共享预算", () => {
  it("newPage 迟到返回时只关闭自建页，不登记句柄或改选", async () => {
    const session = await BrowserSession.connect(inject("browserURL"), { pageTimeoutMs: 1000 });
    const user = await session.newPage();
    await session.getPage(user.pageId);
    const browser = user.page.browser();
    let entered!: () => void, release!: () => void;
    const entering = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = browser.newPage.bind(browser);
    let delayed: Page | undefined;
    const spy = vi.spyOn(browser, "newPage").mockImplementationOnce(async () => {
      delayed = await original();
      entered();
      await gate;
      return delayed;
    });
    const creating = session.newPage();
    const rejected = expect(within(creating)).rejects.toMatchObject({ code: "page-initialization-deadline", timeoutMs: 1000 });
    try {
      await entering;
      await rejected;
      expect(session.allHandles()).toEqual([user]);
      release();
      await expect.poll(() => delayed!.isClosed()).toBe(true);
      expect(session.currentPageId()).toBe(user.pageId);
      expect(user.page.isClosed()).toBe(false);
    } finally {
      release();
      await creating.catch(() => {});
      spy.mockRestore();
      await delayed?.close().catch(() => {});
      await session.close();
      await user.page.close().catch(() => {});
    }
  });

  it("newIsolatedPage 的 context 迟到返回时立即销毁，不再创建或装配页面", async () => {
    const session = await BrowserSession.connect(inject("browserURL"), { pageTimeoutMs: 1000 });
    const user = await session.newPage();
    await session.getPage(user.pageId);
    const browser = user.page.browser();
    let entered!: () => void, release!: () => void;
    const entering = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = browser.createBrowserContext.bind(browser);
    let delayed: Awaited<ReturnType<Browser["createBrowserContext"]>> | undefined;
    let newPageIssued = false;
    const spy = vi.spyOn(browser, "createBrowserContext").mockImplementationOnce(async () => {
      delayed = await original();
      const originalPage = delayed.newPage.bind(delayed);
      vi.spyOn(delayed, "newPage").mockImplementation(async () => { newPageIssued = true; return originalPage(); });
      entered();
      await gate;
      return delayed;
    });
    const creating = session.newIsolatedPage();
    const rejected = expect(within(creating)).rejects.toMatchObject({ code: "page-initialization-deadline", timeoutMs: 1000 });
    try {
      await entering;
      await rejected;
      release();
      await expect.poll(() => browser.browserContexts().includes(delayed!)).toBe(false);
      expect(newPageIssued).toBe(false);
      expect(session.allHandles()).toEqual([user]);
      expect(session.currentPageId()).toBe(user.pageId);
      expect(user.page.isClosed()).toBe(false);
    } finally {
      release();
      await creating.catch(() => {});
      spy.mockRestore();
      vi.restoreAllMocks();
      await delayed?.close().catch(() => {});
      await session.close();
      await user.page.close().catch(() => {});
    }
  });
});


it("旧 close 的迟到清理不能断开或清空已经建立的新连接", async () => {
  const session = await BrowserSession.connect(inject("browserURL"));
  const user = await session.newPage();
  await session.getPage(user.pageId);
  let entered!: () => void, release!: () => void;
  const entering = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = user.cdp.detach.bind(user.cdp);
  const spy = vi.spyOn(user.cdp, "detach").mockImplementation(async () => { entered(); await gate; await original(); });
  const closing = session.close();
  let chosen: PageHandle | undefined;
  try {
    await entering;
    chosen = await within(session.getPage(user.pageId));
    release();
    await within(closing);
    expect(session.allHandles()).toEqual([chosen]);
    expect(session.currentPageId()).toBe(user.pageId);
    const { result } = await chosen.cdp.send("Runtime.evaluate", { expression: "40 + 2", returnByValue: true });
    expect(result.value).toBe(42);
    expect(chosen.page.isClosed()).toBe(false);
  } finally {
    release();
    await closing.catch(() => {});
    spy.mockRestore();
    await chosen?.page.close().catch(() => {});
    await session.close();
  }
});


it("恢复页装配超时只清理本次新页，保留关闭页恢复状态和其它页面", async () => {
  const session = await BrowserSession.connect(inject("browserURL"), { pageTimeoutMs: 1000 });
  const user = await session.newPage(), closed = await session.newPage();
  await session.getPage(closed.pageId);
  const browser = user.page.browser();
  await closed.page.close();
  await session.listPages();
  let entered!: () => void, release!: () => void;
  const entering = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = browser.newPage.bind(browser);
  let recovered: Page | undefined;
  const spy = vi.spyOn(browser, "newPage").mockImplementationOnce(async () => {
    recovered = await original();
    const createCdp = recovered.createCDPSession.bind(recovered);
    vi.spyOn(recovered, "createCDPSession").mockImplementationOnce(async () => {
      const cdp = await createCdp();
      entered();
      await gate;
      return cdp;
    });
    return recovered;
  });
  const selecting = session.getPage();
  const rejected = expect(within(selecting)).rejects.toMatchObject({ code: "page-initialization-deadline", timeoutMs: 1000 });
  try {
    await entering;
    await rejected;
    await expect.poll(() => recovered!.isClosed()).toBe(true);
    expect(session.currentPageId()).toBeUndefined();
    expect(session.needsPageRecovery).toBe(true);
    expect(session.allHandles()).toEqual([user]);
    expect(user.page.isClosed()).toBe(false);
  } finally {
    release();
    await selecting.catch(() => {});
    spy.mockRestore();
    vi.restoreAllMocks();
    await recovered?.close().catch(() => {});
    await session.close();
    await user.page.close().catch(() => {});
  }
});



describe("页面列表初始化的隔离", () => {
  it("旧列表迟到响应在重连后被取消，不写入新连接的句柄和恢复状态", async () => {
    const session = await BrowserSession.connect(inject("browserURL"));
    const user = await session.newPage();
    await session.getPage(user.pageId);
    const proto = Object.getPrototypeOf(user.cdp), original = proto.send;
    let entered!: () => void, release!: () => void;
    const entering = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let delayed = false;
    const spy = vi.spyOn(proto, "send").mockImplementation(async function(this: any, method: string, params: any) {
      const result = await original.call(this, method, params);
      if (method === "Target.getTargets" && !delayed) {
        delayed = true;
        entered();
        await gate;
      }
      return result;
    });
    const listing = session.listPages();
    const rejected = expect(listing).rejects.toThrow(/连接.*取消|连接.*已更换/);
    let chosen: PageHandle | undefined;
    try {
      await entering;
      await session.close();
      chosen = await session.getPage(user.pageId);
      release();
      await rejected;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(session.currentPageId()).toBe(user.pageId);
      expect(session.allHandles()).toEqual([chosen]);
      expect(session.needsPageRecovery).toBe(false);
      const { result } = await chosen.cdp.send("Runtime.evaluate", { expression: "40 + 2", returnByValue: true });
      expect(result.value).toBe(42);
    } finally {
      release();
      await listing.catch(() => {});
      spy.mockRestore();
      await chosen?.page.close().catch(() => {});
      await session.close();
    }
  });

  it("列表读取超时有结构化错误，独立作用域不锁住getPage或改写当前选择", async () => {
    const session = await BrowserSession.connect(inject("browserURL"), { pageTimeoutMs: 1000 });
    const first = await session.newPage(), second = await session.newPage();
    await session.getPage(first.pageId);
    const proto = Object.getPrototypeOf(first.cdp), original = proto.send;
    let entered!: () => void, release!: () => void;
    const entering = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let delayed = false;
    const spy = vi.spyOn(proto, "send").mockImplementation(async function(this: any, method: string, params: any) {
      const result = await original.call(this, method, params);
      if (method === "Target.getTargets" && !delayed) {
        delayed = true;
        entered();
        await gate;
      }
      return result;
    });
    const listing = session.listPages();
    const rejected = expect(within(listing)).rejects.toMatchObject({ code: "page-initialization-deadline", timeoutMs: 1000 });
    try {
      await entering;
      const chosen = await within(session.getPage(second.pageId), 500);
      expect(chosen).toBe(second);
      await rejected;
      expect(session.currentPageId()).toBe(second.pageId);
      expect(session.needsPageRecovery).toBe(false);
      release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(session.currentPageId()).toBe(second.pageId);
      expect(session.allHandles()).toEqual([first, second]);
      const { result } = await second.cdp.send("Runtime.evaluate", { expression: "40 + 2", returnByValue: true });
      expect(result.value).toBe(42);
    } finally {
      release();
      await listing.catch(() => {});
      spy.mockRestore();
      await first.page.close().catch(() => {});
      await second.page.close().catch(() => {});
      await session.close();
    }
  });
});
