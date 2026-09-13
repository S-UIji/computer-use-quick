import { describe, it, expect, beforeAll, afterAll } from "vitest";
import puppeteer, { type Browser } from "puppeteer";
import { BrowserSession } from "../../src/session/browser.js";

let chrome: Browser;
let session: BrowserSession;

beforeAll(async () => {
  chrome = await puppeteer.launch({
    headless: true,
    args: ["--remote-debugging-port=9333", "--no-sandbox"]
  });
  session = await BrowserSession.connect("http://127.0.0.1:9333");
});

afterAll(async () => {
  await session?.close();
  await chrome?.close();
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
