import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, inject, vi } from "vitest";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ProgressNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { BrowserSession } from "../../src/session/browser.js";
import { createServer } from "../../src/server.js";
import { saveTrace } from "../../src/trace/store.js";
import { runSuite } from "../../src/trace/suite.js";
import type { Trace, Step } from "../../src/types.js";

let session: BrowserSession, client: Client, mcp: ReturnType<typeof createServer>;
let sut: ReturnType<typeof createHttpServer>, baseUrl: string, dir: string;
const commits = new Map<string, number>(), visits = new Map<string, number>();
let notices: Array<{ progress: number; total?: number; message?: string }> = [];
const css = (value: string) => ({ descriptor: { strategies: [{ kind: "css" as const, value }], framePath: [] } });
const click = (value: string): Step => ({ action: "click", target: css(value) });
function html(ready: boolean): string {
  return '<!doctype html><title>R16 fixture</title><button id="submit">提交</button><button class="same">同名</button><button class="same">同名</button><p id="out">initial</p>' +
    (ready ? '<p id="ready">ready</p>' : '') +
    '<script>document.querySelector("#submit").onclick=async()=>{await fetch("/submit?case="+encodeURIComponent(location.pathname),{method:"POST"});document.querySelector("#out").textContent="committed";};</script>';
}
beforeAll(async () => {
  sut = createHttpServer((req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    if (url.pathname === "/submit" && req.method === "POST") {
      const key = url.searchParams.get("case")!; commits.set(key, (commits.get(key) ?? 0) + 1);
      res.end("ok"); return;
    }
    visits.set(url.pathname, (visits.get(url.pathname) ?? 0) + 1);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html(url.pathname === "/flaky" && visits.get("/flaky")! > 1));
  });
  await new Promise<void>(resolve => sut.listen(0, "127.0.0.1", resolve));
  baseUrl = "http://127.0.0.1:" + (sut.address() as AddressInfo).port;
  session = await BrowserSession.connect(inject("browserURL"), { watch: false });
  mcp = createServer(session); client = new Client({ name: "r16-feedback", version: "1" });
  client.setNotificationHandler(ProgressNotificationSchema, async notification => { notices.push(notification.params); });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await mcp.connect(s); await client.connect(c);
});
beforeEach(async () => {
  notices = []; commits.clear(); visits.clear();
  dir = await mkdtemp(join(tmpdir(), "cuq-r16-feedback-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  const owned = realpathSync.native(dir), temporary = realpathSync.native(tmpdir());
  if (dirname(owned).toLowerCase() !== temporary.toLowerCase() || !basename(owned).startsWith("cuq-r16-feedback-")) throw new Error("unsafe cleanup");
  await rm(owned, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
afterAll(async () => {
  await client?.close(); await mcp?.close(); await session?.close();
  sut?.closeAllConnections(); await new Promise<void>(resolve => sut?.close(() => resolve()));
});
async function trace(name: string, steps: Step[]): Promise<string> {
  return saveTrace(dir, { name, baseUrl, createdAt: "2026-10-09T00:00:00.000Z", steps });
}
const suite = (paths: string[], extra = {}) => runSuite({ session, paths, vars: {}, concurrency: 1, resolveRetryMs: 0, runsDir: join(dir, "runs"), ...extra });

describe("R16 套件反馈与重试", () => {
  it("开始通知先于隔离页面准备，不能等首个用例结束", async () => {
    const path = await trace("early", [{ action: "sleep", ms: 20 }]);
    let entered!: () => void, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const original = session.newIsolatedPage.bind(session);
    const spy = vi.spyOn(session, "newIsolatedPage").mockImplementation(async slot => { entered(); await gate; return original(slot); });
    const pending = client.callTool({ name: "replay_suite", arguments: { tracePaths: [path] }, _meta: { progressToken: "early" } });
    try {
      await Promise.race([started, pending.then(() => { throw new Error("page preparation not reached"); })]);
      expect(notices.length).toBeGreaterThan(0);
      expect(notices[0]).toMatchObject({ progress: 0, total: 1 });
      expect(notices[0].message).toMatch(/开始/);
    } finally { release(); await pending; spy.mockRestore(); }
  });

  it.each([
    ["target-not-found", click("#missing")],
    ["ambiguous", click(".same")],
    ["assert-failed", { action: "assert", type: "text-equals", target: css("#out"), expected: "wrong" } as Step]
  ] as const)("确定性%s只提交一次并保留失败证据", async (kind, failedStep) => {
    const route = "/case-" + kind;
    const path = await trace(kind, [{ action: "navigate", url: route }, click("#submit"), failedStep]);
    const before = (await session.listPages()).length;
    const result = await suite([path]);
    expect(result.failed).toBe(1); expect(result.results[0].attempts).toBe(1);
    expect(result.results[0].record?.failure?.kind).toBe(kind);
    expect(commits.get(route)).toBe(1);
    expect((await session.listPages()).length).toBe(before);
  });

  it("等待超时允许全新Context重试一次，第二次成功标记flaky", async () => {
    const path = await trace("wait-flaky", [{ action: "navigate", url: "/flaky" },
      { action: "wait", until: { type: "visible", target: css("#ready") }, timeout: 60 }]);
    const result = await suite([path]);
    expect(result.ok).toBe(1); expect(result.flaky).toBe(1);
    expect(result.results[0]).toMatchObject({ attempts: 2, flaky: true });
    expect(visits.get("/flaky")).toBe(2);
  });

  it("真实连接拒绝的导航失败允许新Context重试恢复", async () => {
    const recovery = createHttpServer((_req, response) => { response.end("<title>recovered</title><h1>ok</h1>"); });
    await new Promise<void>(resolve => recovery.listen(0, "127.0.0.1", resolve));
    const port = (recovery.address() as AddressInfo).port;
    await new Promise<void>(resolve => recovery.close(() => resolve()));
    let ready!: () => void, failed!: (error: Error) => void;
    const listening = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
    recovery.on("error", failed);
    const contexts: string[] = [], failures: string[] = [];
    const original = session.newIsolatedPage.bind(session);
    const spy = vi.spyOn(session, "newIsolatedPage").mockImplementation(async slot => {
      if (contexts.length === 1) await listening;
      const resource = await original(slot); contexts.push(resource.handle.pageId); return resource;
    });
    try {
      const path = await trace("navigation-flaky", [{ action: "navigate", url: "http://127.0.0.1:" + port }]);
      const result = await suite([path], { onTraceEvent: (event: any) => {
        if (event.kind === "retrying") {
          failures.push(event.result.record?.failure?.kind);
          recovery.listen(port, "127.0.0.1", ready);
        }
      } });
      expect(failures).toEqual(["navigation-failed"]);
      expect(result.results[0]).toMatchObject({ ok: true, attempts: 2, flaky: true });
      expect(contexts).toHaveLength(2); expect(contexts[0]).not.toBe(contexts[1]);
    } finally {
      spy.mockRestore(); recovery.closeAllConnections();
      await new Promise<void>(resolve => recovery.close(() => resolve()));
    }
  });

  it("等待两次仍失败不进行第三次", async () => {
    const path = await trace("wait-always", [{ action: "navigate", url: "/never-ready" },
      { action: "wait", until: { type: "visible", target: css("#ready") }, timeout: 30 }]);
    const result = await suite([path]);
    expect(result.results[0].attempts).toBe(2);
    expect(result.results[0].record?.failure?.kind).toBe("timeout");
    expect(visits.get("/never-ready")).toBe(2);
  });

  it("坏文件不创建页面或无用重试", async () => {
    const path = join(dir, "bad.json"); await writeFile(path, "{", "utf8");
    const spy = vi.spyOn(session, "newIsolatedPage");
    const result = await suite([path]);
    expect(result.results[0].attempts).toBe(1);
    expect(result.results[0].error).toBeDefined(); expect(spy).not.toHaveBeenCalled();
  });

  it("slowMo汇总真实步骤且通知回调异常不破坏执行", async () => {
    const path = await trace("real-steps", [{ action: "sleep", ms: 5 }, { action: "sleep", ms: 5 }, { action: "sleep", ms: 5 }]);
    const events: any[] = [];
    const result = await suite([path], { slowMoMs: 10, onTraceEvent: (event: unknown) => events.push(event) });
    expect(result.ok).toBe(1);
    expect(events.filter(e => e.kind === "step").map(e => e.completedSteps)).toEqual([1, 2, 3]);
    expect(events.filter(e => e.kind === "step").every(e => e.totalSteps === 3)).toBe(true);
    const resilient = await suite([path], { onTraceEvent: () => { throw new Error("notification failed"); } });
    expect(resilient.ok).toBe(1);
  });

  it("无token不发通知", async () => {
    const path = await trace("silent", [{ action: "sleep", ms: 5 }]);
    await client.callTool({ name: "replay_suite", arguments: { tracePaths: [path] } });
    expect(notices).toEqual([]);
  });
});
