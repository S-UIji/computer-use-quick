import { describe, it, expect } from "vitest";
import { renderSuiteResult, renderTraceEvent } from "../../src/report/suiteReport.js";
import type { SuiteResult, SuiteTraceResult } from "../../src/trace/suite.js";
import type { FailureKind, RunRecord } from "../../src/types.js";

function stopped(kind: FailureKind, flags: Partial<SuiteTraceResult> = {}, blocked = false): SuiteTraceResult {
  const record: RunRecord = { traceName: "same", startedAt: "", durationMs: 20, ok: false, steps: [], drifts: [], healRequired: false,
    failure: { kind, failedIndex: 1, failedStep: { action: "sleep", ms: 1 }, message: "stopped on second attempt",
      snapshot: "snapshot", consoleErrors: [], failedRequests: [], ...(blocked ? { retryBlocked: true } : {}) } };
  return { path: "/same.json", name: "same", ok: false, attempts: 2, durationMs: 20, stepCount: 1, driftCount: 0, record, ...flags };
}
const report = (result: SuiteTraceResult): SuiteResult => ({ total: 1, ok: 0, failed: 1, flaky: 0, durationMs: 20, results: [result] });

describe("R16 报告身份和尝试历史边界", () => {
  it("第二次尝试被用户中断仍显示实际两次", () => {
    const text = renderSuiteResult(report(stopped("user-interrupted", { interrupted: true })));
    expect(text).toContain("尝试 2 次");
    expect(text).not.toContain("未自动重试");
  });
  it.each([
    stopped("page-closed", { pageClosed: true }),
    stopped("timeout", {}, true)
  ])("第二次尝试关闭或恢复不确定只停止后续重试，不改写历史", result => {
    const text = renderSuiteResult(report(result));
    expect(text).toContain("尝试 2 次");
    expect(text).not.toContain("未自动重试");
    expect(text).toContain("停止后续重试");
  });
  it("同名短用例的即时终态按输入位置区分", () => {
    const result: SuiteTraceResult = { path: "/same.json", name: "same", ok: true, attempts: 1, durationMs: 20, stepCount: 1, driftCount: 0 };
    const first = renderTraceEvent({ kind: "done", traceIndex: 0, result });
    const second = renderTraceEvent({ kind: "done", traceIndex: 1, result });
    expect(first).not.toBe(second);
    expect(first).toContain("#1 same");
    expect(second).toContain("#2 same");
  });
  it("即时重试也带输入位置", () => {
    const text = renderTraceEvent({ kind: "retrying", traceIndex: 1, result: stopped("timeout") });
    expect(text).toContain("#2 same"); expect(text).toContain("重试中");
  });
});
