import { describe, it, expect } from "vitest";
import { checkConcurrency, runSuite, MAX_CONCURRENCY, DEFAULT_CONCURRENCY } from "../../src/trace/suite.js";
import { renderSuiteResult, renderTraceEvent } from "../../src/report/suiteReport.js";
import type { SuiteResult } from "../../src/trace/suite.js";
import type { RunRecord } from "../../src/types.js";

describe("checkConcurrency 并发上限", () => {
  it("缺省为 3，1 与上限内放行", () => {
    expect(checkConcurrency(undefined)).toEqual({ ok: true, value: DEFAULT_CONCURRENCY });
    expect(checkConcurrency(1)).toEqual({ ok: true, value: 1 });
    expect(checkConcurrency(MAX_CONCURRENCY)).toEqual({ ok: true, value: MAX_CONCURRENCY });
  });

  it("超过硬上限拒绝，并说明理由", () => {
    const r = checkConcurrency(MAX_CONCURRENCY + 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/硬上限/);
  });

  it("非整数与 <1 拒绝", () => {
    expect(checkConcurrency(0).ok).toBe(false);
    expect(checkConcurrency(2.5).ok).toBe(false);
  });
});

describe("runSuite 入参防线", () => {
  it("空 paths 直接抛错（zod min(1) 之外的纵深防御）", async () => {
    await expect(runSuite({
      session: undefined as never, paths: [], vars: {}, concurrency: 1
    })).rejects.toThrow(/tracePaths 不能为空/);
  });
});

describe("renderSuiteResult 聚合报告", () => {
  const okRecord = { steps: [], drifts: [] } as unknown as RunRecord;
  const mixed: SuiteResult = {
    total: 3, ok: 1, failed: 2, durationMs: 12345,
    results: [
      { path: "/a.json", name: "good", ok: true, durationMs: 3000, stepCount: 11, driftCount: 0 },
      {
        path: "/b.json", name: "broken", ok: false, durationMs: 2000, stepCount: 1, driftCount: 0,
        record: {
          traceName: "broken", startedAt: "", durationMs: 2000, ok: false,
          steps: [], drifts: [],
          failure: {
            failedIndex: 0, failedStep: { action: "click" }, kind: "target-not-found",
            message: "找不到", snapshot: "snap", consoleErrors: [], failedRequests: []
          },
          healRequired: true
        } as RunRecord
      },
      { path: "/c.json", name: "boom", ok: false, durationMs: 100, stepCount: 0, driftCount: 0, error: "Context 创建失败" }
    ]
  };

  it("概览一行：总数/成功/失败/墙钟", () => {
    const text = renderSuiteResult(mixed);
    expect(text).toContain("3 条 — 1 成功 / 2 失败");
    expect(text).toContain("墙钟 12.3s");
  });

  it("每条 compact：成功 ✓、失败 ✗、异常带错误信息", () => {
    const text = renderSuiteResult(mixed);
    expect(text).toContain("✓ good — 11 步");
    expect(text).toContain("✗ broken — 第 1 步失败（target-not-found）");
    expect(text).toContain("✗ boom — 未预期异常：Context 创建失败");
  });

  it("失败用例附完整失败上下文（可接 heal_step）", () => {
    const text = renderSuiteResult(mixed);
    expect(text).toContain("## 失败上下文（可接 heal_step 自愈）");
    expect(text).toContain("heal_required=true");
    expect(text).toContain("找不到");
  });

  it("全部成功时没有失败上下文段", () => {
    const allOk: SuiteResult = {
      total: 1, ok: 1, failed: 0, durationMs: 1000,
      results: [{ path: "/a", name: "good", ok: true, durationMs: 1000, stepCount: 2, driftCount: 0, record: okRecord }]
    };
    expect(renderSuiteResult(allOk)).not.toContain("失败上下文");
  });

  it("机读收尾行：固定格式、固定键序、是整个报告的最后一行", () => {
    const text = renderSuiteResult(mixed);
    const lines = text.split("\n");
    expect(lines[lines.length - 1]).toBe("SUITE_RESULT ok=1 failed=2 total=3 wall_ms=12345");
    // 值纯数字无空格，grep/awk 零成本
    expect(lines[lines.length - 1]).toMatch(/^SUITE_RESULT ok=\d+ failed=\d+ total=\d+ wall_ms=\d+$/);
  });
});

describe("被用户打断的用例", () => {
  const interruptedRecord = {
    traceName: "exp-3", startedAt: "", durationMs: 2400, ok: false, steps: [], drifts: [], healRequired: false,
    failure: {
      failedIndex: 7, failedStep: { action: "click" }, kind: "user-interrupted",
      message: "检测到用户操作", snapshot: "snap", consoleErrors: [], failedRequests: []
    }
  } as unknown as RunRecord;
  const r: SuiteResult = {
    total: 1, ok: 0, failed: 1, flaky: 0, durationMs: 2400,
    results: [{ path: "/e.json", name: "exp-3", ok: false, durationMs: 2400, stepCount: 7, driftCount: 0,
      record: interruptedRecord, attempts: 1, interrupted: true }]
  };

  it("报告行用 ✋ 标明停在第几步，且不列入可自愈的失败上下文段", () => {
    const text = renderSuiteResult(r);
    expect(text).toContain("✋ exp-3 — 被用户打断（停在第 8 步）");
    expect(text).not.toContain("## 失败上下文（可接 heal_step 自愈）");
    expect(text).toContain("无需 heal_step");
    expect(text.trim().split("\n").pop()).toBe("SUITE_RESULT ok=0 failed=1 total=1 wall_ms=2400");
  });

  it("renderTraceEvent：成功 / flaky / 被打断 / 失败 / 重试中", () => {
    const base = { path: "/a.json", name: "a", durationMs: 2400, stepCount: 3, driftCount: 0, attempts: 1 };
    const failRec = { ...interruptedRecord, failure: { ...interruptedRecord.failure!, kind: "target-not-found" } } as RunRecord;
    expect(renderTraceEvent({ kind: "done", result: { ...base, ok: true } })).toBe("a ✓ 2.4s");
    expect(renderTraceEvent({ kind: "done", result: { ...base, ok: true, flaky: true } })).toBe("a ✓ 2.4s（flaky）");
    expect(renderTraceEvent({ kind: "done", result: { ...base, ok: false, interrupted: true, record: interruptedRecord } }))
      .toBe("a ✋ 被用户打断");
    expect(renderTraceEvent({ kind: "done", result: { ...base, ok: false, record: failRec } })).toBe("a ✗ target-not-found");
    expect(renderTraceEvent({ kind: "retrying", result: { ...base, ok: false, record: failRec } }))
      .toBe("a ✗ target-not-found，重试中");
  });
});
