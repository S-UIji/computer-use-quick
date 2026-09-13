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
});
