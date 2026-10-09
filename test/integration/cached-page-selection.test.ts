import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";
import puppeteer, { type Browser, type Dialog, type Page } from "puppeteer-core";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { DialogGuard } from "../../src/session/dialogs.js";
import { PageClosedError } from "../../src/session/pageErrors.js";

let session: BrowserSession;
const owned: PageHandle[] = [];

beforeEach(async () => { session = await BrowserSession.connect(inject("browserURL")); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const handle of owned.splice(0)) await handle.page.close().catch(() => {});
  await session.close();
});

async function newOwnedPage(): Promise<PageHandle> {
  const handle = await session.newPage();
  owned.push(handle);
  return handle;
}

describe("已缓存页面的选择", () => {
  it.each(["explicit", "selected"] as const)("%s：外来冷页持有 alert 时仍能取到缓存目标", async (mode) => {
    const handle = await newOwnedPage();
    await session.getPage(handle.pageId);
    let external: Browser | undefined, foreign: Page | undefined, dialog: Dialog | undefined;
    let alertOpen = false, alertEvaluation: Promise<unknown> | undefined;
    let selecting: Promise<PageHandle> | undefined;
    try {
      // 独立连接创建目标；本 session 尚未 materialize 外来页，也没有安装它的 DialogGuard。
      external = await puppeteer.connect({ browserURL: inject("browserURL"), defaultViewport: null });
      foreign = await external.newPage();
      const opened = new Promise<Dialog>((resolve) => foreign!.once("dialog", resolve));
      alertEvaluation = foreign.evaluate(() => alert("foreign cold page")).then(() => { alertOpen = false; });
      dialog = await opened;
      alertOpen = true;
      expect(session.allHandles()).toEqual([handle]);

      selecting = session.getPage(mode === "explicit" ? handle.pageId : undefined);
      // 一个真实 CDP round-trip 作事件边界：不靠固定 sleep 或超时判定已知目标被全局枚举阻塞。
      const first = await Promise.race([
        selecting.then(() => "selected" as const),
        handle.cdp.send("Target.getTargetInfo").then(() => "checkpoint" as const)
      ]);
      expect(first).toBe("selected");
      expect(alertOpen).toBe(true);
      expect(await selecting).toBe(handle);
      expect(session.currentPageId()).toBe(handle.pageId);
      const { result } = await handle.cdp.send("Runtime.evaluate", { expression: "1 + 1", returnByValue: true });
      expect(result.value).toBe(2);
      expect(alertOpen).toBe(true);
    } finally {
      // RED 时 getPage 正等外来页初始化：必须先关弹窗释放原调用，再收尾连接与页面。
      await dialog?.dismiss().catch(() => {});
      await alertEvaluation?.catch(() => {});
      await selecting?.catch(() => {});
      await foreign?.close().catch(() => {});
      external?.disconnect();
    }
  });

  it("显式空 pageId 不回退到缓存默认页", async () => {
    const handle = await newOwnedPage();
    await session.getPage(handle.pageId);
    const before = await session.listPages();
    await expect(session.getPage("")).rejects.toThrow(/pageId「」.*list_pages/);
    expect(session.currentPageId()).toBe(handle.pageId);
    expect(await session.listPages()).toEqual(before);
  });

  it.each(["explicit", "selected"] as const)("%s：缓存页在处理弹窗期间关闭仍报告 page-closed 并保留恢复状态", async (mode) => {
    const handle = await newOwnedPage();
    await session.getPage(handle.pageId);
    let entered!: () => void, release!: () => void;
    const settling = new Promise<void>((resolve) => { entered = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(DialogGuard.for(handle)!, "settlePending").mockImplementation(async () => {
      entered();
      await released;
    });
    const selecting = session.getPage(mode === "explicit" ? handle.pageId : undefined);
    const rejected = expect(selecting).rejects.toBeInstanceOf(PageClosedError);
    try {
      await settling;
      await handle.page.close();
    } finally { release(); }
    await rejected;
    expect(session.currentPageId()).toBeUndefined();
    expect(session.needsPageRecovery).toBe(true);
    const recovered = await newOwnedPage();
    await session.getPage(recovered.pageId);
    expect(session.needsPageRecovery).toBe(false);
  });
});
