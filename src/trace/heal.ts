import type { BrowserSession, PageHandle } from "../session/browser.js";
import type {
  FailureContext, FailureKind, HealOutcome, RunRecord, Step, Trace
} from "../types.js";
import { runBatch } from "../executor/batch.js";
import { NetworkTracker } from "../waiter/stability.js";
import { DiagnosticsCollector } from "../diagnostics/collector.js";
import { replayTrace } from "./replay.js";
import { atomicWriteTrace, appendHealRecord } from "./store.js";

/** 可自愈的失败类型。assert-failed 不在列：断言失败可能是被测系统真缺陷，自动改期望等于掩盖 bug */
export const HEALABLE_KINDS: ReadonlySet<FailureKind> = new Set([
  "target-not-found", "ambiguous", "timeout"
]);

export const MAX_ATTEMPTS_PER_STEP = 2;
export const MAX_HEALS_PER_TRACE = 3;

export interface HealBudget {
  perStep: Map<number, number>;
  total: number;
}

export type HealGate = { ok: true } | { ok: false; reason: string };

/**
 * 自愈前置护栏：失败类型白名单 + 预算。纯函数，server 在演示执行前调用。
 * 预算语义：验证重放每失败一次计 1 次（demo 失败不计——那是模型动作本身没走通，
 * 还没消耗验证资源）；trace 全量重放成功时由 server 清零，开启新一轮周期。
 */
export function checkHealGate(opts: {
  lastFailureKind: FailureKind | undefined;
  budget: HealBudget;
  stepIndex: number;
}): HealGate {
  if (opts.lastFailureKind === undefined) {
    return { ok: false, reason: "该 trace 无失败记录，无法确认失败类型；请先 replay" };
  }
  if (!HEALABLE_KINDS.has(opts.lastFailureKind)) {
    return {
      ok: false,
      reason:
        `失败类型「${opts.lastFailureKind}」不可自动修复（仅 ${[...HEALABLE_KINDS].join("/")} 可修）。` +
        `断言失败可能是被测系统缺陷，需人工判定。`
    };
  }
  const used = opts.budget.perStep.get(opts.stepIndex) ?? 0;
  if (used >= MAX_ATTEMPTS_PER_STEP) {
    return { ok: false, reason: `第 ${opts.stepIndex + 1} 步已消耗 ${used} 次自愈尝试（上限 ${MAX_ATTEMPTS_PER_STEP}），请转人工` };
  }
  if (opts.budget.total >= MAX_HEALS_PER_TRACE) {
    return { ok: false, reason: `本轮修复周期已消耗 ${opts.budget.total} 次自愈（上限 ${MAX_HEALS_PER_TRACE}），请转人工` };
  }
  return { ok: true };
}

/** 构造修复后的 trace：仅把第 stepIndex 步替换为修复步序列，其余内容引用不变 */
export function buildHealedTrace(
  trace: Trace,
  stepIndex: number,
  replacementSteps: Step[]
): Trace {
  const steps = [
    ...trace.steps.slice(0, stepIndex),
    ...replacementSteps,
    ...trace.steps.slice(stepIndex + 1)
  ];
  return { ...trace, steps };
}

export interface RunHealOptions {
  session: BrowserSession;
  /** 演示页 handle（replay 失败留下的页面，模型已在其上探索） */
  handle: PageHandle;
  tracker: NetworkTracker;
  collector: DiagnosticsCollector;
  /** 演示动作里 ref → backendNodeId 的映射（来自模型最近一次 snapshot） */
  refs: Map<string, number>;
  tracePath: string;
  trace: Trace;
  stepIndex: number;
  demoSteps: Step[];
  vars: Record<string, string>;
  dryRun: boolean;
}

/**
 * 自愈编排：演示捕获 → 新标签页全量重放验证门 → 通过则原子写回 + sidecar。
 * 写回与否、预算记账都由 outcome 表达，由调用方（server）落状态。
 */
export async function runHeal(opts: RunHealOptions): Promise<HealOutcome> {
  const demo = await runBatch({
    handle: opts.handle,
    tracker: opts.tracker,
    collector: opts.collector,
    refs: opts.refs,
    vars: opts.vars,
    steps: opts.demoSteps,
    captureDescriptors: true
  });
  if (!demo.ok) {
    return { status: "demo-failed", stepIndex: opts.stepIndex, failure: demo.failure! };
  }

  const healed = buildHealedTrace(opts.trace, opts.stepIndex, demo.capturedSteps);

  // 验证门：独立 BrowserContext 全量重放。不复用失败页（脏状态），
  // 也不与之共享 cookie/storage——探索痕迹进不了验证，验证过了才算真修好。
  const { handle: vHandle, release } = await opts.session.newIsolatedPage();
  let validation: RunRecord;
  try {
    const vTracker = await NetworkTracker.attach(vHandle);
    const vCollector = await DiagnosticsCollector.attach(vHandle);
    validation = await replayTrace({
      handle: vHandle, tracker: vTracker, collector: vCollector,
      trace: healed, vars: opts.vars
    });
  } finally {
    await release();
  }

  if (!validation.ok) {
    return { status: "validation-failed", stepIndex: opts.stepIndex, trace: healed, validation };
  }

  if (!opts.dryRun) {
    await atomicWriteTrace(opts.tracePath, healed);
    await appendHealRecord(opts.tracePath, {
      healedAt: new Date().toISOString(),
      stepIndex: opts.stepIndex,
      originalStep: opts.trace.steps[opts.stepIndex],
      replacementSteps: demo.capturedSteps,
      validation: {
        ok: true,
        durationMs: validation.durationMs,
        driftCount: validation.drifts.length
      }
    });
  }

  return { status: "healed", dryRun: opts.dryRun, stepIndex: opts.stepIndex, trace: healed, validation };
}

/** demo-failed  outcome 的返回文本，与 batch 失败语义对齐（一次给全） */
export function renderDemoFailure(f: FailureContext): string {
  return (
    `❌ 演示步失败（第 ${f.failedIndex + 1} 步）：${f.kind}\n${f.message}\n\n` +
    `## 失败步骤\n${JSON.stringify(f.failedStep, null, 2)}\n\n` +
    (f.candidates?.length ? `## 同容器内的其它文字（可用于消歧）\n${f.candidates.join("\n")}\n\n` : "") +
    `## 当前快照\n${f.snapshot}\n\n` +
    `## console 报错\n${f.consoleErrors.join("\n") || "（无）"}\n\n` +
    `## 失败请求\n${f.failedRequests.join("\n") || "（无）"}`
  );
}
