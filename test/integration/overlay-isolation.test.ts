import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { NetworkTracker, waitStable } from "../../src/waiter/stability.js";
import { DiagnosticsCollector } from "../../src/diagnostics/collector.js";
import { runBatch } from "../../src/executor/batch.js";
import { takeSnapshot } from "../../src/perception/snapshot.js";
import { buildDescriptor } from "../../src/locator/descriptor.js";
import { decodePng, diffPng } from "../../src/perception/pngDiff.js";
import { showOverlay, removeOverlay, type OverlayState } from "../../src/watch/overlay.js";
import type { Descriptor, Step } from "../../src/types.js";

let session: BrowserSession;
let handle: PageHandle;
let tracker: NetworkTracker, collector: DiagnosticsCollector;
const fx = { url: "" };

beforeAll(async () => {
  fx.url = inject("fixtureURL");
  session = await BrowserSession.connect(inject("browserURL"));
  handle = await session.getPage();
  tracker = await NetworkTracker.attach(handle);
  collector = await DiagnosticsCollector.attach(handle);
});
afterAll(async () => { await session?.close(); });

const css = (value: string): { descriptor: Descriptor } => ({
  descriptor: { strategies: [{ kind: "css", value }], framePath: [] }
});
const active = (step: number): OverlayState => ({ kind: "active", label: "探索", step, total: 20, action: "click" });

async function evalValue<T>(expression: string): Promise<T> {
  const { result } = (await handle.cdp.send("Runtime.evaluate", { expression, returnByValue: true })) as {
    result: { value: T };
  };
  return result.value;
}

async function fresh(): Promise<void> {
  await handle.page.goto(`${fx.url}/watch.html`, { waitUntil: "load" });
}

async function backendIdOf(selector: string): Promise<number> {
  const { root } = (await handle.cdp.send("DOM.getDocument", { depth: 0 })) as { root: { nodeId: number } };
  const { nodeId } = (await handle.cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector })) as { nodeId: number };
  const { node } = (await handle.cdp.send("DOM.describeNode", { nodeId })) as { node: { backendNodeId: number } };
  return node.backendNodeId;
}

describe("标注不污染测试链路", () => {
  it("无障碍快照逐字相同", async () => {
    await fresh();
    const before = (await takeSnapshot(handle)).text;
    await showOverlay(handle, active(1));
    expect((await takeSnapshot(handle)).text).toBe(before);
  });

  it("状态更新对隐式等待的 MutationObserver 不可见", async () => {
    await fresh();
    await showOverlay(handle, active(1)); // 宿主插入：唯一一次 DOM 变化
    await waitStable(handle, tracker, { timeoutMs: 3000 }); // 装上 observer 并等到静默
    const v1 = await evalValue<number>("window.__cuqLastMutation");
    for (let i = 2; i <= 21; i++) await showOverlay(handle, active(i));
    expect(await evalValue<number>("window.__cuqLastMutation")).toBe(v1);
    expect(await waitStable(handle, tracker, { timeoutMs: 2000 })).toBe(false);
  });

  it("角标覆盖区域内的点击仍直接命中（不走 JS 兜底）", async () => {
    await fresh();
    await showOverlay(handle, active(1));
    const r = await runBatch({ handle, tracker, collector, refs: new Map(), vars: {},
      steps: [{ action: "click", target: css("#under") }] });
    expect(r.ok).toBe(true);
    expect(await evalValue<string>(`document.getElementById("hit").textContent`)).toBe("trusted");
  });

  it("生成的描述符与无标注时相同", async () => {
    await fresh();
    await removeOverlay(handle);
    const before = await buildDescriptor(handle, await backendIdOf("#under"));
    await showOverlay(handle, active(1));
    expect(await buildDescriptor(handle, await backendIdOf("#under"))).toEqual(before);
  });

  it("失败截图 / inspect 截图：挂着标注与无标注逐像素相同，截完恢复显示", async () => {
    await fresh();
    await removeOverlay(handle);
    const a = await collector.screenshot();
    await showOverlay(handle, active(1));
    const b = await collector.screenshot();
    const { ratio } = diffPng(decodePng(Buffer.from(a, "base64")), decodePng(Buffer.from(b, "base64")), { threshold: 0 });
    expect(ratio).toBe(0);
    expect(await evalValue<string>(`window.__cuqOverlay.wrap.style.display`)).toBe("");
  });

  it("视觉断言：挂着标注与无标注基线比对通过", async () => {
    const root = await mkdtemp(join(tmpdir(), "cuq-iso-"));
    try {
      const steps: Step[] = [{ action: "assert", type: "screenshot-match", fullPage: true }];
      const visual = { baselineRoot: root, traceName: "iso" };
      await fresh();
      await removeOverlay(handle);
      const first = await runBatch({ handle, tracker, collector, refs: new Map(), vars: {}, steps, visual });
      expect(first.results[0].error).toContain("基线已创建");

      await showOverlay(handle, active(1));
      const second = await runBatch({ handle, tracker, collector, refs: new Map(), vars: {}, steps, visual });
      expect(second.ok).toBe(true);
      expect(second.results[0].error).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
