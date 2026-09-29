import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { BrowserSession } from "../../src/session/browser.js";

let session: BrowserSession;

beforeAll(async () => {
  session = await BrowserSession.connect(inject("browserURL"));
});

afterAll(async () => {
  await session?.close();
});

describe("BrowserSession", () => {
  it("能列出至少一个页面", async () => {
    const pages = await session.listPages();
    expect(pages.length).toBeGreaterThan(0);
    expect(pages[0]).toHaveProperty("pageId");
    expect(pages[0]).toHaveProperty("url");
  });

  it("getPage 返回可用的 CDPSession", async () => {
    const handle = await session.getPage();
    const { result } = await handle.cdp.send("Runtime.evaluate", {
      expression: "1 + 1",
      returnByValue: true
    });
    expect(result.value).toBe(2);
  });

  it("同一 pageId 重复 getPage 复用同一个 CDPSession", async () => {
    const pages = await session.listPages();
    const a = await session.getPage(pages[0].pageId);
    const b = await session.getPage(pages[0].pageId);
    expect(a.cdp).toBe(b.cdp);
  });

  it("外部关闭标签页后，targetDestroyed 自动清掉句柄条目", async () => {
    const before = session.handleCount();
    const h = await session.newPage();
    expect(session.handleCount()).toBe(before + 1);

    // 模拟外部关闭（不经 closePage），等 targetDestroyed 事件送达
    await h.page.close();
    await new Promise((r) => setTimeout(r, 500));
    expect(session.handleCount()).toBe(before);
  });

  it("显式 closePage 的页面再收到销毁通知不报错（幂等）", async () => {
    const before = session.handleCount();
    const h = await session.newPage();
    await session.closePage(h.pageId);
    expect(session.handleCount()).toBe(before);

    // 页面销毁事件随后才到——不应抛错，其他句柄不受影响
    await new Promise((r) => setTimeout(r, 500));
    expect(session.handleCount()).toBe(before);
    const pages = await session.listPages();
    expect(pages.length).toBeGreaterThan(0); // getPage/listPages 行为不变
  });

  it("观察模式：auto 连 headless 不启用，显式 watch 可覆盖", async () => {
    const saved = process.env.CUQ_WATCH;
    delete process.env.CUQ_WATCH; // 开发机上若设了 CUQ_WATCH，别让它干扰判定
    try {
      const auto = await BrowserSession.connect(inject("browserURL"));
      expect(auto.watchEnabled).toBe(false);
      await auto.close();

      const forced = await BrowserSession.connect(inject("browserURL"), { watch: true });
      expect(forced.watchEnabled).toBe(true);
      await forced.close();
    } finally {
      if (saved !== undefined) process.env.CUQ_WATCH = saved;
    }
  });

  it("allHandles 列出已登记的全部句柄", async () => {
    const h = await session.getPage();
    expect(session.allHandles()).toContain(h);
  });
});
