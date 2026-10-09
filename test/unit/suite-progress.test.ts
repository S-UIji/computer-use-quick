import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { SuiteProgress } from "../../src/watch/suiteProgress.js";
import { ProgressReporter, type ProgressNotification } from "../../src/watch/progress.js";
import type { TraceEvent, TraceProgressInfo, SuiteTraceResult } from "../../src/trace/suite.js";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
function setup(total = 3, enabled = true) {
  const notices: ProgressNotification[] = [];
  const reporter = ProgressReporter.from({
    _meta: enabled ? { progressToken: 0 } : undefined,
    sendNotification: async notice => { notices.push(notice); }
  });
  return { notices, progress: new SuiteProgress(reporter, total) };
}
const info = (traceIndex: number, name = "same", attempt: 1 | 2 = 1): TraceProgressInfo =>
  ({ traceIndex, name, path: "/same.json", totalSteps: 4, attempt });
function terminal(traceIndex: number, ok = true): TraceEvent {
  const result: SuiteTraceResult = { path: "/same.json", name: "same", ok, attempts: ok ? 2 : 1,
    durationMs: 50, stepCount: 4, driftCount: 0 };
  return { kind: "done", traceIndex, result };
}
describe("SuiteProgress 节流生命周期", () => {
  it("开始立即发0，250ms内多页多步只汇总最新状态", () => {
    const { progress, notices } = setup();
    progress.start();
    progress.accept({ ...info(0, "a"), kind: "started" });
    progress.accept({ ...info(1, "b"), kind: "started" });
    progress.accept({ ...info(0, "a"), kind: "step", completedSteps: 2 });
    vi.advanceTimersByTime(100);
    progress.accept({ ...info(0, "a"), kind: "step", completedSteps: 3 });
    progress.accept({ ...info(1, "b"), kind: "step", completedSteps: 1 });
    vi.advanceTimersByTime(149);
    expect(notices).toHaveLength(1);
    expect(notices[0].params).toMatchObject({ progress: 0, total: 3, progressToken: 0 });
    vi.advanceTimersByTime(1);
    expect(notices).toHaveLength(2);
    expect(notices[1].params.message).toContain("#1 a 已完成 3/4 步");
    expect(notices[1].params.message).toContain("#2 b 已完成 1/4 步");
    progress.dispose();
  });

  it("同名重复路径按位置区分，重试只重置局部步数", () => {
    const { progress, notices } = setup(2);
    progress.start();
    progress.accept({ ...info(0), kind: "started" });
    progress.accept({ ...info(1), kind: "started" });
    progress.accept(terminal(0));
    progress.accept({ kind: "retrying", traceIndex: 1, result: { ...((terminal(1, false) as any).result) } });
    progress.accept({ ...info(1, "same", 2), kind: "started" });
    vi.advanceTimersByTime(250);
    expect(notices.at(-1)!.params).toMatchObject({ progress: 1, total: 2 });
    expect(notices.at(-1)!.params.message).toContain("#2 same 已完成 0/4 步（重试）");
    progress.accept(terminal(1));
    const count = notices.length; progress.accept(terminal(1));
    expect(notices).toHaveLength(count);
    expect(notices.at(-1)!.params.progress).toBe(2);
    expect(notices.map(n => n.params.progress)).toEqual([...notices.map(n => n.params.progress)].sort());
    progress.dispose();
  });

  it("一个终态即时发送后，仍刷新另一用例的尾部变化", () => {
    const { progress, notices } = setup(2);
    progress.start();
    progress.accept({ ...info(0, "a"), kind: "started" });
    progress.accept({ ...info(1, "b"), kind: "started" });
    progress.accept({ ...info(1, "b"), kind: "step", completedSteps: 3 });
    vi.advanceTimersByTime(100);
    progress.accept(terminal(0));
    expect(notices.at(-1)!.params.progress).toBe(1);
    vi.advanceTimersByTime(250);
    expect(notices.at(-1)!.params.message).toContain("#2 b 已完成 3/4 步");
    progress.accept(terminal(1));
    const count = notices.length; vi.advanceTimersByTime(1000);
    expect(notices).toHaveLength(count);
    progress.dispose();
  });

  it("dispose后不发尾部通知或接受迟到事件", () => {
    const { progress, notices } = setup();
    progress.start();
    progress.accept({ ...info(0), kind: "started" });
    progress.accept({ ...info(0), kind: "step", completedSteps: 2 });
    progress.dispose(); progress.accept(terminal(0)); progress.start();
    vi.advanceTimersByTime(1000);
    expect(notices).toHaveLength(1);
  });

  it("无token不产生通知或定时器", () => {
    const { progress, notices } = setup(1, false);
    progress.start(); progress.accept({ ...info(0), kind: "started" });
    progress.accept({ ...info(0), kind: "step", completedSteps: 1 });
    expect(vi.getTimerCount()).toBe(0);
    progress.accept(terminal(0)); vi.advanceTimersByTime(1000);
    expect(notices).toEqual([]); progress.dispose();
  });

  it("通知发送失败不抛出或阻断收尾", () => {
    const reporter = ProgressReporter.from({ _meta: { progressToken: "bad" }, sendNotification: async () => { throw new Error("closed transport"); } });
    const progress = new SuiteProgress(reporter, 1);
    expect(() => { progress.start(); progress.accept({ ...info(0), kind: "started" }); vi.advanceTimersByTime(250); progress.accept(terminal(0)); progress.dispose(); }).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});
