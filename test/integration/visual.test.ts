import { describe, it, expect, beforeAll, afterAll, afterEach, inject } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { NetworkTracker } from "../../src/waiter/stability.js";
import { DiagnosticsCollector } from "../../src/diagnostics/collector.js";
import { replayTrace } from "../../src/trace/replay.js";
import { runSuite } from "../../src/trace/suite.js";
import { saveTrace } from "../../src/trace/store.js";
import type { Trace } from "../../src/types.js";

let session: BrowserSession;
const fx = { url: "" };
let tracker: NetworkTracker, collector: DiagnosticsCollector;

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "cuq-visual-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

beforeAll(async () => {
  fx.url = inject("fixtureURL");
  session = await BrowserSession.connect(inject("browserURL"));
  const h = await session.getPage();
  tracker = await NetworkTracker.attach(h);
  collector = await DiagnosticsCollector.attach(h);
});
afterAll(async () => { await session?.close(); });

async function open(): Promise<PageHandle> {
  const h = await session.getPage();
  await h.page.goto(`${fx.url}/visual.html`, { waitUntil: "load" });
  return h;
}

const boxShot = (page: string): Trace => ({
  name: "visual-box", baseUrl: fx.url, createdAt: "2026-09-24T00:00:00.000Z",
  steps: [
    { action: "navigate", url: `/${page}` },
    { action: "assert", type: "screenshot-match",
      target: { descriptor: { strategies: [{ kind: "css", value: "#box" }], framePath: [] } } }
  ]
});

const toggleThenShot = (page: string): Trace => ({
  name: "visual-box", baseUrl: fx.url, createdAt: "2026-09-24T00:00:00.000Z",
  steps: [
    { action: "navigate", url: `/${page}` },
    { action: "click", target: { descriptor: { strategies: [{ kind: "css", value: "#toggle" }], framePath: [] } } },
    { action: "assert", type: "screenshot-match",
      target: { descriptor: { strategies: [{ kind: "css", value: "#box" }], framePath: [] } } }
  ]
});

describe("screenshot-match 视觉断言", () => {
  it("首次运行自动建基线并通过，台账标注「基线已创建」", async () => {
    const d = await tmp();
    const trace = boxShot("visual.html");
    const rec = await replayTrace({
      handle: await open(), tracker, collector, trace, vars: {},
      visual: { traceName: trace.name, baselineRoot: d }
    });
    expect(rec.ok).toBe(true);
    expect(rec.steps[1].error).toContain("基线已创建");
    // 基线落在 <root>/<trace 名>/ 下
    const files = await readdir(join(d, trace.name));
    expect(files.filter((f) => f.endsWith(".png"))).toHaveLength(1);
  }, 30_000);

  it("与基线一致时通过且无标注", async () => {
    const d = await tmp();
    const trace = boxShot("visual.html");
    const opts = { traceName: trace.name, baselineRoot: d };
    await replayTrace({ handle: await open(), tracker, collector, trace, vars: {}, visual: opts });
    const rec = await replayTrace({ handle: await open(), tracker, collector, trace, vars: {}, visual: opts });
    expect(rec.ok).toBe(true);
    expect(rec.steps[1].error ?? "").not.toContain("基线已创建");
  }, 30_000);

  it("样式改版超阈值 → assert-failed + 三图进归档；updateBaselines 重录后恢复", async () => {
    const d = await tmp();
    const runs = join(d, "runs");
    // 先建蓝色基线
    await replayTrace({
      handle: await open(), tracker, collector, vars: {},
      trace: boxShot("visual.html"),
      visual: { traceName: "visual-box", baselineRoot: d }
    });
    // 红色改版 trace 回放 → 失败
    const tracePath = await saveTrace(d, toggleThenShot("visual.html"));
    const r = await runSuite({
      session, paths: [tracePath], vars: {}, concurrency: 1,
      runsDir: runs, baselineRoot: d
    });
    expect(r.failed).toBe(1);
    expect(r.results[0].record?.failure?.kind).toBe("assert-failed");

    // 三图（actual/expected/diff）在归档目录
    const dir = (await readdir(runs))[0];
    const files = await readdir(join(runs, dir));
    expect(files.some((f) => f.endsWith("-actual.png"))).toBe(true);
    expect(files.some((f) => f.endsWith("-expected.png"))).toBe(true);
    expect(files.some((f) => f.endsWith("-diff.png"))).toBe(true);

    // updateBaselines 重录 → 通过且标注「基线已更新」
    const r2 = await runSuite({
      session, paths: [tracePath], vars: {}, concurrency: 1,
      runsDir: runs, baselineRoot: d, updateBaselines: true
    });
    expect(r2.ok).toBe(1);
    expect(r2.results[0].record?.steps[2].error).toContain("基线已更新");

    // 再跑 → 按新基线通过
    const r3 = await runSuite({
      session, paths: [tracePath], vars: {}, concurrency: 1,
      runsDir: runs, baselineRoot: d
    });
    expect(r3.ok).toBe(1);
  }, 60_000);

  it("视觉断言失败归为 assert-failed（heal 拒修语义）", async () => {
    const d = await tmp();
    await replayTrace({
      handle: await open(), tracker, collector, vars: {},
      trace: boxShot("visual.html"),
      visual: { traceName: "visual-box", baselineRoot: d }
    });
    const rec = await replayTrace({
      handle: await open(), tracker, collector, vars: {},
      trace: toggleThenShot("visual.html"),
      visual: { traceName: "visual-box", baselineRoot: d }
    });
    expect(rec.ok).toBe(false);
    expect(rec.failure?.kind).toBe("assert-failed");
    expect(rec.healRequired).toBe(true);
  }, 30_000);
});
