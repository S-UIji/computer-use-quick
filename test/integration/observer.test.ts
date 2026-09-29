import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { NetworkTracker } from "../../src/waiter/stability.js";
import { DiagnosticsCollector } from "../../src/diagnostics/collector.js";
import { runBatch } from "../../src/executor/batch.js";
import type { Descriptor, Step } from "../../src/types.js";
import { FakeObserver, RecordingGate } from "../fixtures/fake-observer.js";

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

async function evalValue<T>(expression: string): Promise<T> {
  const { result } = (await handle.cdp.send("Runtime.evaluate", { expression, returnByValue: true })) as {
    result: { value: T };
  };
  return result.value;
}

function run(steps: Step[], observer: FakeObserver, extra: { captureDescriptors?: boolean; resolveRetryMs?: number } = {}) {
  return runBatch({ handle, tracker, collector, refs: new Map(), vars: {}, steps, observer, ...extra });
}

const loginSteps = (): Step[] => [
  { action: "navigate", url: `${fx.url}/form.html` },
  { action: "fill", target: css("#user"), value: "admin" },
  { action: "click", target: css("#submit") }
];

describe("runBatch 步骤钩子", () => {
  it("按固定顺序调用生命周期钩子", async () => {
    const obs = new FakeObserver();
    const r = await run(loginSteps(), obs);
    expect(r.ok).toBe(true);
    expect(obs.events).toEqual([
      "start:3",
      "step:0:navigate", "end:0:ok",
      "step:1:fill", "end:1:ok",
      "step:2:click", "end:2:ok",
      "done:true:-:false"
    ]);
  });

  it("非最后一步成功后检测到介入：停在下一步，标 user-interrupted，下一步不执行", async () => {
    const obs = new FakeObserver({ interruptAt: 1 });
    const steps = loginSteps();
    const r = await run(steps, obs);

    expect(r.ok).toBe(false);
    expect(r.results).toHaveLength(2);
    expect(r.failure?.kind).toBe("user-interrupted");
    expect(r.failure?.failedIndex).toBe(2);
    expect(r.failure?.failedStep).toEqual(steps[2]);
    expect(r.failure?.message).toContain("pointerdown @ 12,31");
    expect(r.failure?.message).toContain("本步未执行");
    expect(r.failure?.snapshot).toContain("用户登录");
    // 探索模式：被介入的那一步提示 save_trace 前确认
    expect(r.results[1].error).toContain("save_trace 前请确认");
    // 第 3 步（点登录）确实没执行
    expect(await evalValue<string>(`document.getElementById("result").textContent`)).toBe("");
    expect(obs.events.at(-1)).toBe("done:false:2:true");
  });

  it("captureDescriptors=false（回放）时不出 save_trace 提示", async () => {
    const r = await run(loginSteps(), new FakeObserver({ interruptAt: 1 }), { captureDescriptors: false });
    expect(r.failure?.kind).toBe("user-interrupted");
    expect(r.results[1].error).toBeUndefined();
  });

  it("当步失败且期间有介入：改判 user-interrupted，保留原始错误", async () => {
    const obs = new FakeObserver({ interruptAt: 1 });
    const r = await run([
      { action: "navigate", url: `${fx.url}/form.html` },
      { action: "click", target: css("#nope") }
    ], obs, { resolveRetryMs: 0 });

    expect(r.ok).toBe(false);
    expect(r.failure?.kind).toBe("user-interrupted");
    expect(r.failure?.failedIndex).toBe(1);
    expect(r.failure?.message).toContain("本步执行期间检测到用户操作");
    expect(r.failure?.message).toContain("原始错误：target-not-found");
    expect(obs.events.at(-1)).toBe("done:false:1:true");
  });

  it("最后一步有介入：整体仍成功，只附告警", async () => {
    const obs = new FakeObserver({ interruptAt: 1 });
    const r = await run([
      { action: "navigate", url: `${fx.url}/form.html` },
      { action: "fill", target: css("#user"), value: "admin" }
    ], obs);

    expect(r.ok).toBe(true);
    expect(r.results[1].error).toContain("所有步骤已完成，结果仍有效");
    expect(obs.events.at(-1)).toBe("done:true:-:false");
  });

  it("用户滚动只告警、不中止", async () => {
    const r = await run([
      { action: "navigate", url: `${fx.url}/form.html` },
      { action: "fill", target: css("#user"), value: "admin" }
    ], new FakeObserver({ scrollAt: 1 }));

    expect(r.ok).toBe(true);
    expect(r.results[1].error).toContain("用户滚动 2 次");
  });
});

describe("sendInput 登记 agent 输入", () => {
  it("点击/填写/按键/悬停/滚动全部经输入门登记，且每次登记都被关闭", async () => {
    const gate = new RecordingGate();
    const r = await run([
      { action: "navigate", url: `${fx.url}/form.html` },
      { action: "click", target: css("#submit") },
      { action: "fill", target: css("#user"), value: "ab" },
      { action: "press", key: "Tab" },
      { action: "hover", target: css("#submit") },
      { action: "scroll", direction: "down", amount: 100 }
    ], new FakeObserver({ inputGate: gate }));

    expect(r.ok).toBe(true);
    expect(gate.begins.map((b) => b.kind)).toEqual([
      "mouse", "mouse", "mouse", // click：moved / pressed / released
      "key", "key", "key",       // fill：Ctrl+A 按下 / 抬起 + insertText
      "key", "key",              // press：keyDown / keyUp
      "mouse",                   // hover：moved
      "wheel"                    // scroll：mouseWheel
    ]);
    const [a, b, c] = gate.begins;
    expect(a.point?.x).toBeGreaterThan(0);
    expect(b.point).toEqual(a.point);
    expect(c.point).toEqual(a.point);
    expect(gate.begins[9].point).toEqual({ x: 10, y: 10 });
    expect(gate.closed).toBe(gate.begins.length);
  });
});
