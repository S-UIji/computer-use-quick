import { describe, it, expect, beforeAll, afterAll } from "vitest";
import puppeteer, { type Browser } from "puppeteer";
import { BrowserSession } from "../../src/session/browser.js";
import { startFixtureServer } from "../fixtures/server.js";
import { DiagnosticsCollector } from "../../src/diagnostics/collector.js";

let chrome: Browser, session: BrowserSession, fx: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  fx = await startFixtureServer();
  chrome = await puppeteer.launch({ headless: true, args: ["--remote-debugging-port=9339", "--no-sandbox"] });
  session = await BrowserSession.connect("http://127.0.0.1:9339");
});
afterAll(async () => { await session?.close(); await chrome?.close(); await fx?.close(); });

describe("DiagnosticsCollector", () => {
  it("采集 console.error", async () => {
    const h = await session.getPage();
    const c = await DiagnosticsCollector.attach(h);
    await h.page.goto(`${fx.url}/form.html`, { waitUntil: "load" });
    c.clear();
    await h.cdp.send("Runtime.evaluate", { expression: `console.error("测试用报错")` });
    await new Promise((r) => setTimeout(r, 300));
    expect(c.consoleErrors().join("\n")).toContain("测试用报错");
  });

  it("采集 4xx 请求", async () => {
    const h = await session.getPage();
    const c = await DiagnosticsCollector.attach(h);
    await h.page.goto(`${fx.url}/form.html`, { waitUntil: "load" });
    c.clear();
    await h.cdp.send("Runtime.evaluate", {
      expression: `fetch("${fx.url}/nope.html").catch(function () {})`
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(c.failedRequests().join("\n")).toContain("nope.html");
  });

  it("只保留最近 20 条", async () => {
    const h = await session.getPage();
    const c = await DiagnosticsCollector.attach(h);
    await h.page.goto(`${fx.url}/form.html`, { waitUntil: "load" });
    c.clear();
    await h.cdp.send("Runtime.evaluate", {
      expression: `for (var i = 0; i < 30; i++) console.error("err" + i)`
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(c.consoleErrors().length).toBe(20);
    expect(c.consoleErrors().join("\n")).toContain("err29");
  });

  it("截图返回非空 base64", async () => {
    const h = await session.getPage();
    const c = await DiagnosticsCollector.attach(h);
    await h.page.goto(`${fx.url}/form.html`, { waitUntil: "load" });
    expect((await c.screenshot()).length).toBeGreaterThan(1000);
  });

  it("同一页面重复 attach 复用同一个采集器实例", async () => {
    const h = await session.getPage();
    const a = await DiagnosticsCollector.attach(h);
    const b = await DiagnosticsCollector.attach(h);
    expect(a).toBe(b);
  });
});
