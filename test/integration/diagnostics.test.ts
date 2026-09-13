import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { BrowserSession } from "../../src/session/browser.js";
import { DiagnosticsCollector } from "../../src/diagnostics/collector.js";

let session: BrowserSession;
const fx = { url: "" };

beforeAll(async () => {
  fx.url = inject("fixtureURL");
  session = await BrowserSession.connect(inject("browserURL"));
});
afterAll(async () => { await session?.close(); });

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
