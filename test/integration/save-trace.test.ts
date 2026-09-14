import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserSession } from "../../src/session/browser.js";
import { NetworkTracker } from "../../src/waiter/stability.js";
import { DiagnosticsCollector } from "../../src/diagnostics/collector.js";
import { runBatch } from "../../src/executor/batch.js";
import { takeSnapshot } from "../../src/perception/snapshot.js";
import { saveTrace, loadTrace } from "../../src/trace/store.js";

let session: BrowserSession;
const fx = { url: "" };
let tracker: NetworkTracker, collector: DiagnosticsCollector, dir: string;

beforeAll(async () => {
  fx.url = inject("fixtureURL");
  session = await BrowserSession.connect(inject("browserURL"));
  const h = await session.getPage();
  tracker = await NetworkTracker.attach(h);
  collector = await DiagnosticsCollector.attach(h);
  dir = await mkdtemp(join(tmpdir(), "cuq-trace-"));
});
afterAll(async () => {
  await session?.close();
  await rm(dir, { recursive: true, force: true });
});

describe("descriptor 固化", () => {
  it("batch 里用的 ref 被固化成 descriptor，可存成 trace", async () => {
    const handle = await session.getPage();
    await handle.page.goto(`${fx.url}/cards-no-container.html`, { waitUntil: "load" });

    const snap = await takeSnapshot(handle, { threshold: 99 });
    const line = snap.text.split("\n").filter((l) => l.includes("查看在岗干部明细"))[1];
    const ref = line.match(/\[(e\d+)\]/)![1];

    const r = await runBatch({
      handle, tracker, collector, refs: snap.refs, vars: {},
      steps: [{ action: "click", target: { ref } }]
    });

    expect(r.ok).toBe(true);
    const captured = r.capturedSteps[0] as { target: { descriptor?: unknown } };
    expect(captured.target.descriptor).toBeDefined();

    const path = await saveTrace(dir, {
      name: "card-click", baseUrl: fx.url,
      createdAt: new Date().toISOString(), steps: r.capturedSteps
    });
    const loaded = await loadTrace(path);
    expect(JSON.stringify(loaded.steps)).not.toContain('"ref"');
    expect(JSON.stringify(loaded.steps)).toContain("技术平台中心");
  });

  it("replay 模式（captureDescriptors=false）不做额外的 descriptor 计算", async () => {
    const handle = await session.getPage();
    await handle.page.goto(`${fx.url}/form.html`, { waitUntil: "load" });
    const snap = await takeSnapshot(handle);
    const ref = snap.text.split("\n").find((l) => l.includes('"登录"'))!.match(/\[(e\d+)\]/)![1];

    const r = await runBatch({
      handle, tracker, collector, refs: snap.refs, vars: {},
      captureDescriptors: false,
      steps: [{ action: "click", target: { ref } }]
    });
    const captured = r.capturedSteps[0] as { target: { ref?: string } };
    expect(captured.target.ref).toBe(ref);
  });

  it("固化出的 descriptor 能真的回放命中同一个元素", async () => {
    const handle = await session.getPage();
    await handle.page.goto(`${fx.url}/table-dup.html`, { waitUntil: "load" });

    const snap = await takeSnapshot(handle, { threshold: 99 });
    const ref = snap.text.split("\n")
      .filter((l) => l.includes('] button "删除"'))[2].match(/\[(e\d+)\]/)![1];

    const first = await runBatch({
      handle, tracker, collector, refs: snap.refs, vars: {},
      steps: [{ action: "click", target: { ref } }]
    });
    expect(first.ok).toBe(true);

    // 重新加载页面（ref 全部失效），用固化下来的步骤再跑一遍
    await handle.page.goto(`${fx.url}/table-dup.html`, { waitUntil: "load" });
    const again = await runBatch({
      handle, tracker, collector, refs: new Map(), vars: {},
      captureDescriptors: false,
      steps: [
        ...first.capturedSteps,
        { action: "assert", type: "text-equals",
          target: { descriptor: { strategies: [{ kind: "css", value: "#deleted" }], framePath: [] } },
          expected: "已删除 ORD20260913" }
      ]
    });
    expect(again.ok).toBe(true);
  });
});
