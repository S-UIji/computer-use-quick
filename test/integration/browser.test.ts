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
});
