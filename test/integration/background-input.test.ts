import { createServer as createHttpServer } from "node:http";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join, dirname, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { runSuite } from "../../src/trace/suite.js";
import { renderSuiteResult } from "../../src/report/suiteReport.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.js";
import { beforeEach, afterEach, describe, it, expect, inject, vi } from "vitest";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { NetworkTracker } from "../../src/waiter/stability.js";
import { DiagnosticsCollector } from "../../src/diagnostics/collector.js";
import { runAction, type ActionContext } from "../../src/executor/actions.js";
import { runBatch } from "../../src/executor/batch.js";
import { RunWatch } from "../../src/watch/runWatch.js";
import { InterventionMonitor } from "../../src/watch/intervention.js";
import puppeteer from "puppeteer-core";
import type { Step } from "../../src/types.js";

let session: BrowserSession, user: PageHandle, target: PageHandle;
let owned: PageHandle[] = [];
type Fixture = { session?: BrowserSession; pages: PageHandle[]; closed: boolean };
const fixtures = new WeakMap<object, Fixture>();
const css = (value: string) => ({ descriptor: { strategies: [{ kind: "css" as const, value }], framePath: [] } });
const stability = { domQuietMs: 20, networkQuietMs: 20, timeoutMs: 800 };
const visible = (h: PageHandle) => h.page.evaluate(() => document.visibilityState);
async function ctx(h = target): Promise<ActionContext> {
  return { handle: h, tracker: await NetworkTracker.attach(h), refs: new Map(), vars: {}, stability, resolveRetryMs: 0 };
}
async function batch(steps: Step[]) {
  return runBatch({ ...(await ctx()), collector: await DiagnosticsCollector.attach(target), steps, captureDescriptors: false,
    observer: new RunWatch({ handle: target, label: "R14", watch: true }) });
}
beforeEach(async ({ task }) => {
  const fixture: Fixture = { pages: [], closed: false }; fixtures.set(task, fixture);
  let stage = "connect";
  try {
    const currentSession = await BrowserSession.connect(inject("browserURL")); fixture.session = currentSession;
    if (fixture.closed) { await currentSession.close(); throw new Error("fixture already closed"); }
    const newOwnedPage = async (): Promise<PageHandle> => {
      if (fixture.closed) throw new Error("fixture already closed");
      const h = await currentSession.newPage();
      if (fixture.closed) {
        try { await h.page.close().catch(() => {}); } finally { await currentSession.close(); }
        throw new Error("fixture already closed");
      }
      fixture.pages.push(h); return h;
    };
    stage = "user page"; const currentUser = await newOwnedPage();
    stage = "user content"; await currentUser.page.setContent("<title>用户页面</title><h1>用户内容</h1>");
    stage = "target page"; const currentTarget = await newOwnedPage();
    stage = "target navigation"; await currentTarget.page.goto(inject("fixtureURL") + "/form.html");
    stage = "target event setup"; await currentTarget.page.evaluate(() => {
      const spacer = document.createElement("div"); spacer.id = "r14-long"; spacer.style.height = "2200px"; document.body.append(spacer);
      (window as any).__r14Events = [];
      for (const type of ["input", "keydown", "pointerdown", "wheel"]) document.addEventListener(type, e =>
        (window as any).__r14Events.push({ type: e.type, trusted: e.isTrusted, value: (e.target as HTMLInputElement).value }), true);
    });
    stage = "user activation"; await currentUser.cdp.send("Page.bringToFront");
    if (fixture.closed) throw new Error("fixture already closed");
    session = currentSession; user = currentUser; target = currentTarget; owned = fixture.pages;
  } catch (error) { console.error("[R14 fixture] setup failed at " + stage); throw error; }
});
afterEach(async ({ task }) => {
  const fixture = fixtures.get(task); if (!fixture) return;
  fixture.closed = true; fixtures.delete(task); vi.restoreAllMocks();
  try {
    // 先关闭自建目标：不向已经卡住的 renderer 派发模拟恢复或清理脚本。
    for (const h of fixture.pages.splice(0)) {
      await h.page.close().catch(() => {});
      await InterventionMonitor.for(h).disarm();
    }
  } finally { await fixture.session?.close(); }
});

describe("后台输入生命周期", () => {
  it("连接断开不等于页面关闭，保留原错误并阻止不确定恢复的重试", async () => {
    const ownedIds = new Set(owned.map(h => h.pageId));
    const owner = await puppeteer.connect({ browserURL: inject("browserURL"), defaultViewport: null });
    try {
      const ownerTarget = await owner.waitForTarget(t => (t as any)._targetId === target.pageId);
      const ownerPage = await ownerTarget.page(); const c = await ctx(); const warnings: any[] = [];
      c.onInputWarning = warning => warnings.push(warning);
      c.onResolved = async () => { await session.close(); };
      let error: any; try { await runAction(c, { action: "fill", target: css("#user"), value: "not-written" }); } catch (e) { error = e; }
      expect(error).toBeDefined(); expect(error.name).not.toBe("PageClosedError");
      expect(ownerPage!.isClosed()).toBe(false); expect(warnings.some(w => w.retryBlocked)).toBe(true);
      expect(await ownerPage!.$eval("#user", n => (n as HTMLInputElement).value)).toBe("");
    } finally {
      try {
        for (const page of await owner.pages()) if (ownedIds.has((page.target() as any)._targetId)) await page.close().catch(() => {});
      } finally { owner.disconnect(); }
    }
  });


  it("后台输入期间真实用户点击仍按步骤边界中断", async () => {
    const point = await target.page.$eval("#remember", n => { const b = n.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
    const send = target.cdp.send.bind(target.cdp); let injected = false;
    vi.spyOn(target.cdp, "send").mockImplementation((async (method: string, params: any) => {
      if (!injected && method === "Input.insertText") {
        injected = true;
        for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
      }
      return send(method as any, params);
    }) as any);
    const result = await batch([{ action: "fill", target: css("#user"), value: "agent" }, { action: "click", target: css("#submit") }]);
    expect(result.failure?.kind).toBe("user-interrupted");
    expect(await target.page.$eval("#result", n => n.textContent)).toBe("");
    expect(await visible(user)).toBe("visible"); expect(await visible(target)).toBe("hidden");
  });


  it("真实滚轮带提示切前台并实际滚动，不误报用户介入", async () => {
    const r = await batch([{ action: "scroll", direction: "down", amount: 300 }]);
    expect(r.ok).toBe(true); expect(r.results[0].error).toMatch(/滚轮.*前台/);
    expect(await visible(user)).toBe("hidden");
    expect(await target.page.evaluate(() => scrollY)).toBeGreaterThan(0);
    const events = await target.page.evaluate(() => (window as any).__r14Events);
    expect(events.some((e: any) => e.type === "wheel" && e.trusted)).toBe(true);
  });


  it("恢复失败会阻止沿用此前的自愈证据，文件不写回", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cuq-r14-heal-gate-"));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer(session); const client = new Client({ name: "r14-gate", version: "1" });
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      const path = join(dir, "blocked.json");
      const source = JSON.stringify({ name: "blocked", baseUrl: inject("fixtureURL"), steps: [{ action: "navigate", url: "/form.html" }, { action: "click", target: css("#missing") }] });
      await writeFile(path, source);
      const args = { pageId: target.pageId, tracePath: path, resolveRetryMs: 0 };
      const first = await client.callTool({ name: "replay", arguments: args }); expect(first.isError).not.toBe(true);
      const send = target.cdp.send.bind(target.cdp);
      vi.spyOn(target.cdp, "send").mockImplementation(((method: string, params: any) => {
        if (method === "Emulation.setFocusEmulationEnabled" && !params.enabled) throw new Error("r14-reset-failed");
        return send(method as any, params);
      }) as any);
      await client.callTool({ name: "replay", arguments: args });
      const healed = await client.callTool({ name: "heal_step", arguments: { tracePath: path, repairs: [{ stepIndex: 1, steps: [{ action: "click", target: css("#submit") }] }] } });
      expect(healed.isError).toBe(true);
      expect(JSON.stringify(healed.content)).toContain("核实副作用");
      expect(await readFile(path, "utf8")).toBe(source);
    } finally {
      await client.close(); await server.close();
      const ownedDir = resolve(dir);
      if (dirname(ownedDir).toLowerCase() !== resolve(tmpdir()).toLowerCase() || !basename(ownedDir).startsWith("cuq-r14-heal-gate-")) throw new Error("unsafe cleanup");
      await rm(ownedDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });


  it("开启已生效但响应失败时也恢复模拟，保留原错误且不输入", async () => {
    const send = target.cdp.send.bind(target.cdp);
    vi.spyOn(target.cdp, "send").mockImplementation((async (method: string, params: any) => {
      if (method === "Emulation.setFocusEmulationEnabled" && params.enabled) {
        await send(method as any, params); throw new Error("r14-enable-response-lost");
      }
      return send(method as any, params);
    }) as any);
    const r = await batch([{ action: "fill", target: css("#user"), value: "not-written" }]);
    expect(r.ok).toBe(false); expect(r.failure?.message).toContain("r14-enable-response-lost");
    expect(await target.page.$eval("#user", n => (n as HTMLInputElement).value)).toBe("");
    expect(await visible(target)).toBe("hidden"); expect(await visible(user)).toBe("visible");
  });

  it("套件遇到恢复失败不会自动重复已完成的提交，也不给自愈提示", async () => {
    let commits = 0;
    const sut = createHttpServer((q, r) => {
      if (q.url === "/effect") { commits++; r.writeHead(200); r.end("ok"); return; }
      r.writeHead(200, { "content-type": "text/html" });
      r.end('<input id="field"><script>field.oninput=()=>fetch("/effect",{method:"POST"})</script>');
    });
    await new Promise<void>(r => sut.listen(0, "127.0.0.1", r));
    const dir = await mkdtemp(join(tmpdir(), "cuq-r14-retry-"));
    try {
      const url = "http://127.0.0.1:" + (sut.address() as any).port;
      const path = join(dir, "no-retry.json");
      await writeFile(path, JSON.stringify({ name: "no-retry", baseUrl: url, steps: [{ action: "navigate", url: "/" }, { action: "fill", target: css("#field"), value: "committed" }] }));
      const result = await runSuite({ session, paths: [path], vars: {}, concurrency: 1, runsDir: join(dir, "runs"),
        observerFor: h => {
          const send = h.cdp.send.bind(h.cdp);
          h.cdp.send = (async (method: string, params: any) => {
            if (method === "Emulation.setFocusEmulationEnabled" && !params.enabled) throw new Error("r14-reset-failed");
            return send(method as any, params);
          }) as any;
          return new RunWatch({ handle: h, label: "R14-retry", watch: true });
        } });
      expect(commits).toBe(1); expect(result.results[0].attempts).toBe(1);
      expect(result.results[0].record?.healRequired).toBe(false);
      expect(renderSuiteResult(result)).not.toContain("heal_step");
    } finally {
      sut.closeAllConnections(); await new Promise<void>(r => sut.close(() => r()));
      const ownedDir = resolve(dir);
      if (dirname(ownedDir).toLowerCase() !== resolve(tmpdir()).toLowerCase() || !basename(ownedDir).startsWith("cuq-r14-retry-")) throw new Error("unsafe cleanup");
      await rm(ownedDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });


  it("完整输入保持用户标签，可信事件不误报且结束恢复hidden", async () => {
    const r = await batch([
      { action: "fill", target: css("#user"), value: "r14-user" },
      { action: "press", key: "Tab" },
      { action: "hover", target: css("#submit") },
      { action: "select", target: css("#region"), value: "hf" },
      { action: "click", target: css("#submit") },
      { action: "scroll", target: css("#r14-long"), direction: "down" }
    ]);
    expect(r.ok).toBe(true); expect(await visible(user)).toBe("visible"); expect(await visible(target)).toBe("hidden");
    expect(await target.page.$eval("#user", n => (n as HTMLInputElement).value)).toBe("r14-user");
    expect(await target.page.$eval("#result", n => n.textContent)).toBe("欢迎 r14-user");
    expect(await target.page.$eval("#region", n => (n as HTMLSelectElement).value)).toBe("hf");
    const events = await target.page.evaluate(() => (window as any).__r14Events);
    for (const type of ["input", "keydown", "pointerdown"]) expect(events.some((e: any) => e.type === type && e.trusted)).toBe(true);
    expect(r.failure).toBeUndefined(); const scroll = await target.page.evaluate(() => ({ y: scrollY, height: innerHeight, docHeight: document.documentElement.scrollHeight, bodyHeight: document.body.scrollHeight, events: (window as any).__r14Events })); expect(scroll.y, JSON.stringify(scroll)).toBeGreaterThan(0);
  });

  it("定位失败后恢复，下一次调用仍能后台输入", async () => {
    const failed = await batch([{ action: "click", target: css("#missing") }]);
    expect(failed.failure?.kind).toBe("target-not-found");
    expect(await visible(target)).toBe("hidden"); expect(await visible(user)).toBe("visible");
    const recovered = await batch([{ action: "fill", target: css("#user"), value: "recovered" }]);
    expect(recovered.ok).toBe(true); expect(await visible(user)).toBe("visible"); expect(await visible(target)).toBe("hidden");
  });

  it("点击触发导航后新文档不残留模拟", async () => {
    await target.page.evaluate(url => { const a = document.createElement("a"); a.id = "r14-nav"; a.href = url; a.textContent = "跳转"; document.body.prepend(a); }, inject("fixtureURL") + "/form.html?after=1");
    const r = await batch([{ action: "click", target: css("#r14-nav") }]);
    expect(r.ok).toBe(true); expect(target.page.url()).toContain("after=1");
    expect(await visible(user)).toBe("visible"); expect(await visible(target)).toBe("hidden");
  });

  it("同页重叠输入按提交顺序完成，不提前关闭另一动作的模拟", async () => {
    const first = await ctx(), second = await ctx();
    first.onResolved = async () => { await new Promise(r => setTimeout(r, 80)); };
    await Promise.all([runAction(first, { action: "fill", target: css("#user"), value: "first" }),
      runAction(second, { action: "fill", target: css("#user"), value: "second" })]);
    const values = await target.page.evaluate(() => (window as any).__r14Events.filter((e: any) => e.type === "input" && e.trusted).map((e: any) => e.value));
    expect(values).toEqual(["first", "second"]); expect(await visible(user)).toBe("visible"); expect(await visible(target)).toBe("hidden");
  });

  it("明确不支持时回退前台，工具结果保留警告", async () => {
    const send = target.cdp.send.bind(target.cdp);
    vi.spyOn(target.cdp, "send").mockImplementation(((method: string, params: any) => {
      if (method === "Emulation.setFocusEmulationEnabled") throw new Error("Protocol error: method wasn't found");
      return send(method as any, params);
    }) as any);
    const r = await batch([{ action: "fill", target: css("#user"), value: "fallback" }]);
    expect(r.ok).toBe(true); expect(r.results[0].error).toMatch(/前台.*回退|回退.*前台/);
    expect(await visible(user)).toBe("hidden"); expect(await target.page.$eval("#user", n => (n as HTMLInputElement).value)).toBe("fallback");
  });

  it("未知开启及恢复错误隔离同页动作，显式重连核实后可继续", async () => {
    const send = target.cdp.send.bind(target.cdp);
    const spy = vi.spyOn(target.cdp, "send").mockImplementation(((method: string, params: any) => {
      if (method === "Emulation.setFocusEmulationEnabled") throw new Error("r14-enable-unexpected");
      return send(method as any, params);
    }) as any);
    const r = await batch([{ action: "fill", target: css("#user"), value: "not-written" }]);
    expect(r.ok).toBe(false); expect(r.failure?.message).toContain("r14-enable-unexpected");
    expect(await target.page.$eval("#user", n => (n as HTMLInputElement).value)).toBe(""); expect(await visible(user)).toBe("visible");
    spy.mockRestore();
    const blocked = await batch([{ action: "fill", target: css("#user"), value: "next" }]);
    expect(blocked.ok).toBe(false); expect(blocked.failure?.retryBlocked).toBe(true);
    expect(await target.page.$eval("#user", n => (n as HTMLInputElement).value)).toBe("");
    const reconnected = await BrowserSession.connect(inject("browserURL"));
    try {
      const fresh = await reconnected.getPage(target.pageId);
      await fresh.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
      const next = await runBatch({ ...(await ctx(fresh)), collector: await DiagnosticsCollector.attach(fresh),
        steps: [{ action: "fill", target: css("#user"), value: "next" }], captureDescriptors: false });
      expect(next.ok).toBe(true);
      expect(await fresh.page.$eval("#user", n => (n as HTMLInputElement).value)).toBe("next");
    } finally { await reconnected.close(); }
  });

  it("成功输入恢复失败时停止后续步骤，说明副作用可能已完成", async () => {
    const send = target.cdp.send.bind(target.cdp);
    vi.spyOn(target.cdp, "send").mockImplementation(((method: string, params: any) => {
      if (method === "Emulation.setFocusEmulationEnabled" && !params.enabled) throw new Error("r14-reset-failed");
      return send(method as any, params);
    }) as any);
    const r = await batch([{ action: "fill", target: css("#user"), value: "written" }, { action: "click", target: css("#submit") }]);
    expect(r.ok).toBe(false); expect(r.failure?.kind).toBe("action-failed"); expect(r.failure?.message).toContain("可能已完成");
    expect(r.results).toHaveLength(1); expect(await target.page.$eval("#user", n => (n as HTMLInputElement).value)).toBe("written");
    expect(await target.page.$eval("#result", n => n.textContent)).toBe(""); expect(await visible(user)).toBe("visible");
    const blocked = await batch([{ action: "click", target: css("#submit") }]);
    expect(blocked.ok).toBe(false); expect(blocked.failure?.retryBlocked).toBe(true);
    expect(await target.page.$eval("#result", n => n.textContent)).toBe("");
  });

  it("主动作与恢复都失败时保留原始定位失败和恢复提示", async () => {
    const send = target.cdp.send.bind(target.cdp);
    vi.spyOn(target.cdp, "send").mockImplementation(((method: string, params: any) => {
      if (method === "Emulation.setFocusEmulationEnabled" && !params.enabled) throw new Error("r14-reset-failed");
      return send(method as any, params);
    }) as any);
    const r = await batch([{ action: "click", target: css("#missing") }]);
    expect(r.failure?.kind).toBe("target-not-found"); expect(r.failure?.message).toContain("策略");
    expect(r.failure?.message).toMatch(/焦点.*恢复|恢复.*焦点/);
  });

  it("动作期间关闭页面仍按page-closed收尾，新页面可用", async () => {
    const c = await ctx(); c.onResolved = async () => { await target.page.close(); };
    await expect(runAction(c, { action: "fill", target: css("#user"), value: "not-written" })).rejects.toThrow();
    const fresh = await session.newPage(); owned.push(fresh); await fresh.page.goto(inject("fixtureURL") + "/form.html"); await user.cdp.send("Page.bringToFront");
    await runAction(await ctx(fresh), { action: "fill", target: css("#user"), value: "fresh" });
    expect(await fresh.page.$eval("#user", n => (n as HTMLInputElement).value)).toBe("fresh"); expect(await visible(user)).toBe("visible");
  });
});
