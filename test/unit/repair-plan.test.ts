import { describe, expect, it } from "vitest";
import {
  assessRepairs, buildRepairPlan, repairFailureLocation, type TraceRepair
} from "../../src/trace/repairPlan.js";
import type { FailureKind, RunRecord, Step, Trace } from "../../src/types.js";

const target = (value: string) => ({
  descriptor: { strategies: [{ kind: "css" as const, value }], framePath: [] }
});

function original(): Trace {
  return {
    name: "two-faults", baseUrl: "https://app.test", createdAt: "2026-10-08",
    steps: [
      { action: "navigate", url: "/form" },
      { action: "click", target: target("#first-old") },
      { action: "fill", target: target("#user"), value: "original" },
      { action: "click", target: target("#second-old") },
      { action: "wait", until: { type: "url-contains", value: "/done" } },
      { action: "assert", type: "url-contains", expected: "/done" }
    ]
  };
}

function replacements(): TraceRepair[] {
  return [
    { stepIndex: 3, steps: [{ action: "click", target: target("#second-new") }] },
    { stepIndex: 1, steps: [
      { action: "wait", until: { type: "visible", target: target("#first-new") }, timeout: 100 },
      { action: "fill", target: target("#user"), value: "repaired" },
      { action: "click", target: target("#first-new") }
    ] }
  ];
}

function validation(executed: Array<[number, boolean]>, failedIndex?: number,
  kind: FailureKind = "target-not-found"): RunRecord {
  return {
    traceName: "two-faults", startedAt: "2026-10-08", durationMs: 1,
    ok: failedIndex === undefined,
    steps: executed.map(([index, ok]) => ({ index, ok, action: "click", durationMs: 1 })),
    drifts: [], healRequired: failedIndex !== undefined,
    failure: failedIndex === undefined ? undefined : {
      failedIndex, failedStep: { action: "click", target: target("#failed") }, kind,
      message: "failure", snapshot: "", consoleErrors: [], failedRequests: []
    }
  };
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

describe("buildRepairPlan 原索引与候选轨迹映射", () => {
  it("1→3 替换后，多点修复仍按原索引定位并返回排序后的范围", () => {
    const trace = original();
    const fixes = replacements();
    const plan = buildRepairPlan(trace, fixes);
    expect(plan.repairs.map((repair) => repair.stepIndex)).toEqual([1, 3]);
    expect(plan.trace.steps).toEqual([
      trace.steps[0], ...fixes[1].steps, trace.steps[2], ...fixes[0].steps,
      trace.steps[4], trace.steps[5]
    ]);
    expect(plan.indexMap).toEqual([
      { originalIndex: 0 },
      { originalIndex: 1, repairIndex: 0 },
      { originalIndex: 1, repairIndex: 0 },
      { originalIndex: 1, repairIndex: 0 },
      { originalIndex: 2 },
      { originalIndex: 3, repairIndex: 1 },
      { originalIndex: 4 },
      { originalIndex: 5 }
    ]);
    expect(plan.ranges).toEqual([
      { stepIndex: 1, start: 1, end: 4 },
      { stepIndex: 3, start: 5, end: 6 }
    ]);
  });

  it("连续原步骤及第0步可同时替换，范围不重叠", () => {
    const plan = buildRepairPlan(original(), [
      { stepIndex: 2, steps: [{ action: "press", key: "Tab" }] },
      { stepIndex: 0, steps: [{ action: "navigate", url: "/new" }, { action: "sleep", ms: 1 }] },
      { stepIndex: 1, steps: [{ action: "click", target: target("#new") }] }
    ]);
    expect(plan.ranges).toEqual([
      { stepIndex: 0, start: 0, end: 2 },
      { stepIndex: 1, start: 2, end: 3 },
      { stepIndex: 2, start: 3, end: 4 }
    ]);
    expect(plan.indexMap[4]).toEqual({ originalIndex: 3 });
  });

  it("不修改输入及未修步骤，保留合法步骤的所有字段", () => {
    const trace = freezeDeep(original());
    const enriched: Step = {
      action: "fill", target: {
        descriptor: {
          strategies: [{ kind: "role-name", role: "textbox", name: "", nth: 0 }],
          framePath: ["login-frame"], distinguishers: ["账号"]
        }
      },
      value: "${PASSWORD}", sensitive: true, dialog: "dismiss", promptText: ""
    };
    const fixes = freezeDeep([{ stepIndex: 2, steps: [enriched] }]);
    const before = JSON.stringify({ trace, fixes });
    const plan = buildRepairPlan(trace, fixes);
    expect(JSON.stringify({ trace, fixes })).toBe(before);
    expect(plan.trace).not.toBe(trace);
    expect(plan.repairs).not.toBe(fixes);
    expect(plan.repairs[0].steps).not.toBe(fixes[0].steps);
    expect(plan.trace.steps[1]).toBe(trace.steps[1]);
    expect(plan.trace.steps[2]).toEqual(enriched);
    expect(plan.trace.name).toBe(trace.name);
    expect(plan.trace.createdAt).toBe(trace.createdAt);
  });

  it("允许新增断言验证修复，但不能替换原来的断言", () => {
    const asserted: Step = {
      action: "assert", type: "screenshot-match", fullPage: true, threshold: 0.02,
      dialog: "accept", promptText: "继续"
    };
    expect(buildRepairPlan(original(), [{ stepIndex: 1, steps: [asserted] }]).trace.steps[1]).toEqual(asserted);
    expect(() => buildRepairPlan(original(), [{ stepIndex: 5, steps: [asserted] }])).toThrow(/assert|断言/);
  });

  it("支持全部现有动作与等待条件，不丢可选字段", () => {
    const cases: Step[] = [
      { action: "navigate", url: "${BASE_URL}/form", dialog: "accept" },
      { action: "click", target: target("#ok"), dialog: "dismiss" },
      { action: "fill", target: target("#user"), value: "" },
      { action: "select", target: target("#region"), value: "bj" },
      { action: "press", key: "Enter" },
      { action: "hover", target: target("#ok") },
      { action: "scroll", target: target("#list"), direction: "up", amount: 50 },
      { action: "scroll" },
      { action: "wait", until: { type: "hidden", target: target("#loading") }, timeout: 0 },
      { action: "wait", until: { type: "response", urlPattern: "/api" } },
      { action: "wait", until: { type: "url-contains", value: "/done" } },
      { action: "sleep", ms: 0 },
      { action: "assert", type: "text-equals", target: target("#result"), expected: "" },
      { action: "assert", type: "hidden", target: target("#loading") },
      { action: "extract", target: target("#user"), as: "USER", from: "value" }
    ];
    for (const step of cases) {
      expect(buildRepairPlan(original(), [{ stepIndex: 1, steps: [step] }]).trace.steps[1]).toEqual(step);
    }
  });
});

describe("buildRepairPlan 输入拒绝", () => {
  it.each([-1, 6, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("拒绝非法原步索引 %s", (stepIndex) => {
    expect(() => buildRepairPlan(original(), [{ stepIndex, steps: [{ action: "sleep", ms: 1 }] }])).toThrow();
  });

  it("拒绝重复索引", () => {
    expect(() => buildRepairPlan(original(), [
      { stepIndex: 1, steps: [{ action: "sleep", ms: 1 }] },
      { stepIndex: 1, steps: [{ action: "sleep", ms: 2 }] }
    ])).toThrow(/重复/);
  });

  it("限制1至3个修复点、每点1至3个替换步骤", () => {
    expect(() => buildRepairPlan(original(), [])).toThrow();
    expect(() => buildRepairPlan(original(), [0, 1, 2, 3].map((stepIndex) => ({
      stepIndex, steps: [{ action: "sleep" as const, ms: 1 }]
    })))).toThrow();
    for (const count of [0, 4]) {
      expect(() => buildRepairPlan(original(), [{
        stepIndex: 1, steps: Array.from({ length: count }, () => ({ action: "sleep" as const, ms: 1 }))
      }])).toThrow();
    }
  });

  it.each([
    { action: "click", target: { ref: "e1" } },
    { action: "click", target: { ...target("#ok"), ref: "e1" } },
    { action: "wait", until: { type: "visible", target: { ref: "e1" } } },
    { action: "wait", until: { type: "hidden", target: { ...target("#ok"), ref: "e1" } } }
  ])("禁止直接或wait嵌套ref：%j", (step) => {
    expect(() => buildRepairPlan(original(), [{ stepIndex: 1, steps: [step as Step] }])).toThrow(/ref/);
  });

  it.each([
    { action: "unknown" },
    { action: "click" },
    { action: "click", target: { descriptor: { strategies: [], framePath: [] } } },
    { action: "click", target: { descriptor: { strategies: [{ kind: "css", value: 7 }], framePath: [] } } },
    { action: "click", target: { descriptor: { strategies: [{ kind: "unknown", value: "#ok" }], framePath: [] } } },
    { action: "click", target: { descriptor: { strategies: [{ kind: "css", value: "#ok" }] } } },
    { action: "fill", target: target("#ok"), value: 12 },
    { action: "sleep", ms: -1 },
    { action: "wait", until: { type: "response" } },
    { action: "assert", type: "visible" },
    { action: "assert", type: "screenshot-match" },
    { action: "assert", type: "screenshot-match", fullPage: true, threshold: 2 },
    { action: "press", key: "Enter", dialog: "invalid" }
  ])("拒绝非法Step或descriptor：%j", (step) => {
    expect(() => buildRepairPlan(original(), [{ stepIndex: 1, steps: [step as Step] }])).toThrow();
  });
});

describe("assessRepairs 按实际执行结果评估修复块", () => {
  const plan = buildRepairPlan(original(), replacements());

  it("全量执行通过时所有修复passed", () => {
    const rec = validation(plan.trace.steps.map((_, index) => [index, true]));
    expect(assessRepairs(plan, rec)).toEqual([
      { stepIndex: 1, status: "passed" }, { stepIndex: 3, status: "passed" }
    ]);
  });

  it("已通过修复块不因后续未修改原步骤失败而误判", () => {
    const rec = validation([[0, true], [1, true], [2, true], [3, true], [4, false]], 4);
    expect(assessRepairs(plan, rec)).toEqual([
      { stepIndex: 1, status: "passed" }, { stepIndex: 3, status: "not-reached" }
    ]);
    expect(repairFailureLocation(plan, rec)).toEqual({ originalIndex: 2 });
  });

  it("修复块内实际失败为failed，未执行的后续块为not-reached", () => {
    const rec = validation([[0, true], [1, true], [2, false]], 2);
    expect(assessRepairs(plan, rec)).toEqual([
      { stepIndex: 1, status: "failed" }, { stepIndex: 3, status: "not-reached" }
    ]);
    expect(repairFailureLocation(plan, rec)).toEqual({ originalIndex: 1, repairIndex: 0 });
  });

  it("只跑完成功前缀后在下一步前中断，整个修复块为not-reached且不归因", () => {
    const rec = validation([[0, true], [1, true]], 2, "user-interrupted");
    expect(assessRepairs(plan, rec)).toEqual([
      { stepIndex: 1, status: "not-reached" }, { stepIndex: 3, status: "not-reached" }
    ]);
    expect(repairFailureLocation(plan, rec)).toBeUndefined();
  });

  it("准备阶段page-closed没有执行台账，所有块not-reached且不归因", () => {
    const rec = validation([], 0, "page-closed");
    expect(assessRepairs(plan, rec)).toEqual([
      { stepIndex: 1, status: "not-reached" }, { stepIndex: 3, status: "not-reached" }
    ]);
    expect(repairFailureLocation(plan, rec)).toBeUndefined();
  });

  it("失败序号不能代替缺少的实际执行项，记录顺序不影响评估", () => {
    const rec = validation([[3, true], [0, true], [1, true], [5, false]], 5);
    expect(assessRepairs(plan, rec)).toEqual([
      { stepIndex: 1, status: "not-reached" }, { stepIndex: 3, status: "failed" }
    ]);
    expect(repairFailureLocation(plan, rec)).toEqual({ originalIndex: 3, repairIndex: 1 });
  });

  it("无失败、越界失败序号均不归因，评估不修改plan或validation", () => {
    const complete = freezeDeep(validation(plan.trace.steps.map((_, index) => [index, true])));
    const frozenPlan = freezeDeep(buildRepairPlan(original(), replacements()));
    const before = JSON.stringify({ frozenPlan, complete });
    assessRepairs(frozenPlan, complete);
    expect(repairFailureLocation(frozenPlan, complete)).toBeUndefined();
    expect(JSON.stringify({ frozenPlan, complete })).toBe(before);
    expect(repairFailureLocation(plan, validation([[99, false]], 99))).toBeUndefined();
  });
});
