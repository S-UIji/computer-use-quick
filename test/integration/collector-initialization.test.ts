import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { DiagnosticsCollector } from "../../src/diagnostics/collector.js";

let session: BrowserSession, handle: PageHandle;
beforeEach(async () => {
  session = await BrowserSession.connect(inject("browserURL"), { watch: false });
  handle = await session.newPage();
  await handle.page.goto(inject("fixtureURL") + "/form.html");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await handle?.page.close().catch(() => {});
  await session?.close();
});
const consoleEvent = () => new Promise<void>(resolve => handle.cdp.once("Runtime.consoleAPICalled", () => resolve()));
describe("采集器初始化发布", () => {
  it.each(["Network.enable", "Log.enable"])("%s失败后重试仍采集真实console和业务404", async (failureMethod) => {
    const send = handle.cdp.send.bind(handle.cdp);
    let failed = false;
    const spy = vi.spyOn(handle.cdp, "send").mockImplementation((async (method: string, params: any) => {
      if (!failed && method === failureMethod) { failed = true; throw Error("controlled enable failure"); }
      return send(method as any, params);
    }) as any);
    await expect(DiagnosticsCollector.attach(handle)).rejects.toThrow("controlled enable failure");
    spy.mockRestore();
    const collector = await DiagnosticsCollector.attach(handle);
    collector.clear();
    const received = consoleEvent();
    await handle.page.evaluate(() => console.error("collector recovered event"));
    await received;
    expect(collector.consoleErrors().filter(line => line === "collector recovered event")).toHaveLength(1);
    const url = inject("fixtureURL") + "/collector-retry-missing";
    await handle.page.evaluate(async (target) => { await fetch(target); }, url);
    expect(collector.failedRequests()).toContain("404 " + url);
  });
  it("并发attach共用完成实例且真实console只记一次", async () => {
    const [a, b] = await Promise.all([DiagnosticsCollector.attach(handle), DiagnosticsCollector.attach(handle)]);
    expect(a).toBe(b);
    a.clear();
    const received = consoleEvent();
    await handle.page.evaluate(() => console.error("collector concurrent event"));
    await received;
    expect(a.consoleErrors().filter(line => line === "collector concurrent event")).toHaveLength(1);
  });
});
