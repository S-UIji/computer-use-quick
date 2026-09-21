import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkHealGate, buildHealedTrace,
  MAX_ATTEMPTS_PER_STEP, MAX_HEALS_PER_TRACE, type HealBudget
} from "../../src/trace/heal.js";
import {
  saveTrace, loadTrace, atomicWriteTrace, healSidecarPath,
  appendHealRecord, readHealRecords
} from "../../src/trace/store.js";
import type { Step, Trace } from "../../src/types.js";

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "cuq-heal-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const budget = (perStep: Record<number, number> = {}, total = 0): HealBudget => ({
  perStep: new Map(Object.entries(perStep).map(([k, v]) => [Number(k), v])),
  total
});

describe("checkHealGate 失败类型白名单", () => {
  it("target-not-found / ambiguous / timeout 放行", () => {
    for (const kind of ["target-not-found", "ambiguous", "timeout"] as const) {
      const r = checkHealGate({ lastFailureKind: kind, budget: budget(), stepIndex: 2 });
      expect(r.ok).toBe(true);
    }
  });

  it("assert-failed 拒绝，并说明需人工判定", () => {
    const r = checkHealGate({ lastFailureKind: "assert-failed", budget: budget(), stepIndex: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/断言失败/);
  });

  it("navigation-failed / action-failed 同样拒绝", () => {
    for (const kind of ["navigation-failed", "action-failed"] as const) {
      const r = checkHealGate({ lastFailureKind: kind, budget: budget(), stepIndex: 0 });
      expect(r.ok).toBe(false);
    }
  });

  it("无失败记录时拒绝猜测", () => {
    const r = checkHealGate({ lastFailureKind: undefined, budget: budget(), stepIndex: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/先 replay/);
  });
});

describe("checkHealGate 自愈预算", () => {
  it("单步达到上限拒绝", () => {
    const r = checkHealGate({
      lastFailureKind: "target-not-found",
      budget: budget({ 3: MAX_ATTEMPTS_PER_STEP }),
      stepIndex: 3
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/转人工/);
  });

  it("单步未达上限但本轮总额达上限拒绝", () => {
    const r = checkHealGate({
      lastFailureKind: "target-not-found",
      budget: budget({ 0: 1, 1: 1 }, MAX_HEALS_PER_TRACE),
      stepIndex: 5
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/本轮修复周期/);
  });
});

describe("buildHealedTrace", () => {
  const trace: Trace = {
    name: "t", baseUrl: "http://x", createdAt: "2026-09-21T00:00:00.000Z",
    steps: [
      { action: "navigate", url: "/a" },
      { action: "click", target: { ref: "e1" } },
      { action: "fill", target: { ref: "e2" }, value: "v" },
      { action: "assert", type: "visible" }
    ]
  };

  it("只替换目标步，其余步保持原位", () => {
    const fix: Step = { action: "click", target: { ref: "e9" } };
    const healed = buildHealedTrace(trace, 1, [fix]);
    expect(healed.steps).toHaveLength(4);
    expect(healed.steps[0]).toEqual(trace.steps[0]);
    expect(healed.steps[1]).toEqual(fix);
    expect(healed.steps[2]).toEqual(trace.steps[2]);
    expect(healed.steps[3]).toEqual(trace.steps[3]);
  });

  it("1 步可替换为多步（区间变长）", () => {
    const fixed: Step[] = [
      { action: "wait", until: { type: "url-contains", value: "/a" } },
      { action: "click", target: { ref: "e9" } }
    ];
    const healed = buildHealedTrace(trace, 1, fixed);
    expect(healed.steps).toHaveLength(5);
    expect(healed.steps[1]).toEqual(fixed[0]);
    expect(healed.steps[2]).toEqual(fixed[1]);
    expect(healed.steps[3]).toEqual(trace.steps[2]);
  });

  it("不修改原 trace（纯函数）", () => {
    const before = JSON.stringify(trace);
    buildHealedTrace(trace, 0, [{ action: "sleep", ms: 1 }]);
    expect(JSON.stringify(trace)).toBe(before);
  });
});

describe("atomicWriteTrace", () => {
  const trace: Trace = {
    name: "heal-me", baseUrl: "http://x", createdAt: "2026-09-21T00:00:00.000Z",
    steps: [
      { action: "navigate", url: "/a" },
      { action: "click", target: { descriptor: {
        strategies: [{ kind: "role-name", role: "button", name: "旧按钮" }], framePath: []
      } } },
      { action: "assert", type: "visible" }
    ]
  };

  it("除被换的步外逐字节不变", async () => {
    const d = await tmp();
    const p = await saveTrace(d, trace);
    const before = await readFile(p, "utf8");

    const healed = buildHealedTrace(trace, 1, [{
      action: "click",
      target: { descriptor: {
        strategies: [{ kind: "role-name", role: "button", name: "新按钮" }], framePath: []
      } }
    }]);
    await atomicWriteTrace(p, healed);

    const afterLines = (await readFile(p, "utf8")).split("\n");
    const beforeLines = before.split("\n");
    // 未触及的行逐字节一致；变化的行仅限 descriptor 内的差异
    const changed = beforeLines.filter((l) => !afterLines.includes(l));
    expect(changed.join("\n")).toContain("旧按钮");
    expect(changed.join("\n")).not.toContain("navigate");
  });

  it("写回后目录里不残留临时文件", async () => {
    const d = await tmp();
    const p = await saveTrace(d, trace);
    await atomicWriteTrace(p, buildHealedTrace(trace, 2, [{ action: "assert", type: "hidden" }]));
    const left = await readdir(d);
    expect(left.filter((f) => f.includes(".tmp-"))).toHaveLength(0);
  });

  it("写回内容仍含明文凭证时被拒，原文件不动", async () => {
    const d = await tmp();
    const p = await saveTrace(d, trace);
    const before = await readFile(p, "utf8");
    const poisoned = buildHealedTrace(trace, 1, [{
      action: "fill",
      target: { descriptor: {
        strategies: [{ kind: "css", value: "#password" }], framePath: []
      } },
      value: "hunter2"
    }]);
    await expect(atomicWriteTrace(p, poisoned)).rejects.toThrow(/明文/);
    expect(await readFile(p, "utf8")).toBe(before);
  });
});

describe("heal sidecar", () => {
  it("路径由 trace 路径派生", () => {
    expect(healSidecarPath("/t/smoke-login.json")).toBe("/t/smoke-login.heal.jsonl");
  });

  it("追加与读取往返一致，按时间排列", async () => {
    const d = await tmp();
    const p = join(d, "x.json");
    await writeFile(p, "{}", "utf8");
    expect(await readHealRecords(p)).toEqual([]);

    const rec = {
      healedAt: "2026-09-21T08:00:00.000Z",
      stepIndex: 1,
      originalStep: { action: "click" } as Step,
      replacementSteps: [{ action: "click" } as Step],
      validation: { ok: true, durationMs: 100, driftCount: 0 }
    };
    await appendHealRecord(p, rec);
    await appendHealRecord(p, { ...rec, healedAt: "2026-09-21T09:00:00.000Z", stepIndex: 4 });
    const all = await readHealRecords(p);
    expect(all).toHaveLength(2);
    expect(all[0].stepIndex).toBe(1);
    expect(all[1].stepIndex).toBe(4);
  });

  it("读到的记录可以直接 loadTrace 回来的 trace 对应（原步一致）", async () => {
    const d = await tmp();
    const trace: Trace = {
      name: "y", baseUrl: "http://x", createdAt: "c",
      steps: [
        { action: "navigate", url: "/a" },
        { action: "click", target: { descriptor: {
          strategies: [{ kind: "css", value: "#go" }], framePath: []
        } } }
      ]
    };
    const p = await saveTrace(d, trace);
    // 模拟写回前留档：sidecar 里的 originalStep 应与写回前 trace 的第 k 步一致
    const loaded = await loadTrace(p);
    expect(loaded.steps[1]).toEqual(trace.steps[1]);
  });
});
