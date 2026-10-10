import type { PageHandle } from "../session/browser.js";
import { NetworkTracker } from "../waiter/stability.js";
import { DiagnosticsCollector } from "../diagnostics/collector.js";
import type { RunRecord, Trace, Step, Descriptor, VisualOptions } from "../types.js";
import type { StepObserver } from "../executor/observer.js";
import { runBatch } from "../executor/batch.js";
import { runWithDeadline, assertExecutionReady, validateStepTimeoutMs, ExecutionDeadlineError, ExecutionQuarantinedError } from "../executor/deadline.js";
import { PageInitializationDeadlineError } from "../session/pageInitialization.js";
import { PageClosedError } from "../session/pageErrors.js";
import { displayPageUrl } from "../session/pageUrl.js";
import { applyAuth, type AuthState } from "../session/auth.js";
import { assertVariables, inspectVariables } from "../executor/variables.js";
import { createVariableRedactor, redactVariableRecord } from "../report/variablePrivacy.js";

export interface ReplayOptions {
  handle: PageHandle;
  tracker: NetworkTracker;
  collector: DiagnosticsCollector;
  trace: Trace;
  vars: Record<string, string>;
  environmentNames?: ReadonlySet<string>;
  /** 每步之间的额外延迟，用于演示场景让人看得见操作。默认 0。 */
  slowMoMs?: number;
  /** 目标解析的轮询重试预算（ms），默认 3000；传 0 恢复一次性解析 */
  resolveRetryMs?: number;
  /** 单步骤整体执行预算，默认 30000ms。 */
  stepTimeoutMs?: number;
  /** 视觉断言链路配置（screenshot-match 基线归属与更新模式） */
  visual?: VisualOptions;
  /** 步骤生命周期钩子（标注 / 进度 / 介入检测），看到的是 trace 真实步序号 */
  observer?: StepObserver;
}

/** 把 trace 里的相对 url 补全成绝对地址 */
export function absolutize(step: Step, baseUrl: string): Step {
  if (step.action !== "navigate") return step;
  if (/^https?:\/\//i.test(step.url)) return step;
  const base = baseUrl.replace(/\/$/, "");
  return { ...step, url: base + (step.url.startsWith("/") ? step.url : `/${step.url}`) };
}

function strategyKindAt(step: Step, index: number): string | undefined {
  const t = (step as { target?: { descriptor?: Descriptor } }).target;
  return t?.descriptor?.strategies[index]?.kind;
}

/** 批次序号 → trace 真实序号；落在 slowMo 插入的 sleep 上时取其后的第一个真实步 */
function nextReal(realIndex: number[], k: number, total: number): number {
  for (let j = k; j < realIndex.length; j++) {
    if (realIndex[j] !== -1) return realIndex[j];
  }
  return total - 1;
}

/** slowMo 插入的 sleep 对观察者不可见，步序号换算回 trace 真实序号 */
function remapObserver(obs: StepObserver, realIndex: number[], total: number): StepObserver {
  return {
    inputGate: obs.inputGate,
    onRunStart: () => obs.onRunStart(total),
    onStepStart: async (i, step, description, details) => {
      if (realIndex[i] !== -1) await obs.onStepStart(realIndex[i], step, description, details);
    },
    onStepEnd: async (r) => {
      if (realIndex[r.index] !== -1) await obs.onStepEnd({ ...r, index: realIndex[r.index] });
    },
    onRunEnd: (o) => obs.onRunEnd({
      ...o,
      failedIndex: o.failedIndex === undefined ? undefined : nextReal(realIndex, o.failedIndex, total)
    }),
    takeInterruption: () => obs.takeInterruption(),
    takeScrollCount: () => obs.takeScrollCount()
  };
}

/** 页面在准备阶段关闭，还未执行任何步骤；同样生成不可自愈的失败台账。 */
export function pageClosedRecord(trace: Trace, message: string, startedAt: number): RunRecord {
  return {
    traceName: trace.name, startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt, ok: false, steps: [], drifts: [], healRequired: false,
    failure: trace.steps[0] ? {
      failedIndex: 0, failedStep: trace.steps[0], kind: "page-closed", message,
      snapshot: "（标签页已关闭，无法获取快照）", consoleErrors: [], failedRequests: []
    } : undefined
  };
}

/** 采集器、网络追踪与认证注入共享一个准备预算；迟到的 CDP 续链由执行域阻止。 */
export async function prepareExecution(handle: PageHandle, auth?: AuthState): Promise<{
  tracker: NetworkTracker; collector: DiagnosticsCollector;
}> {
  return runWithDeadline(handle, 2000, async () => {
    assertExecutionReady(handle);
    const collector = await DiagnosticsCollector.attach(handle);
    const tracker = await NetworkTracker.attach(handle);
    if (auth) await applyAuth(handle, auth);
    return { tracker, collector };
  });
}

/** 准备阶段尚未执行任何步骤；关闭与截止失败均生成不可自愈台账。 */
export function preparationFailureRecord(
  trace: Trace, error: unknown, startedAt: number, handle?: PageHandle
): RunRecord | undefined {
  if (error instanceof PageClosedError || handle?.page.isClosed()) {
    return pageClosedRecord(trace, error instanceof PageClosedError ? error.message : new PageClosedError(handle!.pageId).message, startedAt);
  }
  if (!(error instanceof ExecutionDeadlineError) && !(error instanceof ExecutionQuarantinedError) && !(error instanceof PageInitializationDeadlineError)) return undefined;
  let currentUrl: string | undefined;
  try { if (handle) currentUrl = displayPageUrl(handle.page.url()); } catch { /* 最后已知 URL 不可用。 */ }
  return {
    traceName: trace.name, startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt, ok: false, steps: [], drifts: [], healRequired: false,
    failure: trace.steps[0] ? {
      failedIndex: 0, failedStep: trace.steps[0], kind: "timeout", retryBlocked: true,
      message: "执行前准备未完成，尚未开始任何步骤；" + (error instanceof ExecutionDeadlineError || error instanceof PageInitializationDeadlineError ? "准备超时。" : "页面需要恢复。") + error.message,
      snapshot: "（执行前准备未完成，无法获取可信快照）", currentUrl,
      consoleErrors: [], failedRequests: []
    } : undefined
  };
}

/** 归档截图同样有界；截图超时保留主失败，阻止不安全的自动恢复。 */
export async function captureFailureScreenshot(
  handle: PageHandle, collector: DiagnosticsCollector, record: RunRecord
): Promise<{ record: RunRecord; screenshot?: string }> {
  if (record.ok || record.failure?.retryBlocked || record.failure?.kind === "page-closed") return { record };
  try {
    return { record, screenshot: await runWithDeadline(handle, 2000, () => collector.screenshot()) };
  } catch (error) {
    if ((error instanceof ExecutionDeadlineError || error instanceof ExecutionQuarantinedError || error instanceof PageClosedError) && record.failure) {
      return { record: { ...record, healRequired: false, failure: {
        ...record.failure, retryBlocked: true,
        message: record.failure.message + "\n失败截图无法获取；" + error.message
      } } };
    }
    return { record };
  }
}

export async function replayTrace(opts: ReplayOptions): Promise<RunRecord> {
  validateStepTimeoutMs(opts.stepTimeoutMs);
  assertVariables(opts.trace.steps, opts.vars);
  const origins = inspectVariables(opts.trace.steps, opts.vars, opts.environmentNames).environmentUsed;

  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const steps = opts.trace.steps.map((s) => absolutize(s, opts.trace.baseUrl));
  const slowMo = opts.slowMoMs ?? 0;

  // realIndex[k] = withSlowMo 第 k 步在 trace 里的真实序号；-1 表示是 slowMo 插入的 sleep。
  // 不能靠 action==="sleep" 过滤台账——trace 自己也可能有 sleep 步，会被误删、序号也会错位。
  const withSlowMo: Step[] = [];
  const realIndex: number[] = [];
  steps.forEach((s, i) => {
    if (slowMo > 0 && i > 0) {
      withSlowMo.push({ action: "sleep", ms: slowMo });
      realIndex.push(-1);
    }
    withSlowMo.push(s);
    realIndex.push(i);
  });

  const r = await runBatch({
    handle: opts.handle,
    tracker: opts.tracker,
    collector: opts.collector,
    refs: new Map(),
    vars: opts.vars,
    steps: withSlowMo,
    captureDescriptors: false, environmentNames: opts.environmentNames,
    resolveRetryMs: opts.resolveRetryMs, stepTimeoutMs: opts.stepTimeoutMs,
    visual: opts.visual,
    observer: opts.observer ? remapObserver(opts.observer, realIndex, steps.length) : undefined
  });

  // 去掉 slowMo 插入的 sleep，序号换算回真实步序号
  const realResults = r.results
    .filter((s) => realIndex[s.index] !== -1)
    .map((s) => ({ ...s, index: realIndex[s.index] }));

  const drifts: RunRecord["drifts"] = [];
  for (const s of realResults) {
    if (s.strategyIndex === undefined || s.strategyIndex <= 0) continue;
    const step = steps[s.index];
    const expected = strategyKindAt(step, 0);
    const actual = strategyKindAt(step, s.strategyIndex);
    if (expected && actual) drifts.push({ index: s.index, expected, actual });
  }

  // 失败上下文里的步序号同样换算回真实步序号（介入中断可能落在插入的 sleep 上）
  let failure = r.failure;
  if (failure) {
    const idx = nextReal(realIndex, failure.failedIndex, steps.length);
    failure = { ...failure, failedIndex: idx, failedStep: steps[idx] };
  }

  const record: RunRecord = {
    traceName: opts.trace.name,
    startedAt,
    durationMs: Date.now() - t0,
    ok: r.ok,
    steps: realResults,
    drifts,
    failure,
    // 用户介入或页面关闭不应修改 trace。
    healRequired: !r.ok && !failure?.retryBlocked && failure?.kind !== "user-interrupted" && failure?.kind !== "page-closed",
    artifacts: r.artifacts.length > 0 ? r.artifacts : undefined
  };
  return redactVariableRecord(record, createVariableRedactor(opts.vars, origins, r.variableRedactions));
}
