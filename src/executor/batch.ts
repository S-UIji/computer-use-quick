import type { PageHandle } from "../session/browser.js";
import type { NetworkTracker } from "../waiter/stability.js";
import type { DiagnosticsCollector } from "../diagnostics/collector.js";
import type { FailureContext, FailureKind, RunArtifact, Step, StepResult, VisualOptions } from "../types.js";
import { describeInterruption, type StepObserver } from "./observer.js";
import { runAction, type ActionContext } from "./actions.js";
import type { StabilityOptions } from "../waiter/stability.js";
import { runAssert, AssertionFailure } from "../assertion/assert.js";
import { interpolateStep } from "./variables.js";
import { LocatorError } from "../locator/resolve.js";
import { takeSnapshot } from "../perception/snapshot.js";
import { buildDescriptor } from "../locator/descriptor.js";

export interface BatchOptions {
  handle: PageHandle;
  tracker: NetworkTracker;
  collector: DiagnosticsCollector;
  refs: Map<string, number>;
  vars: Record<string, string>;
  steps: Step[];
  /** 成功执行后是否把 {ref} 固化成 {descriptor}，供 save_trace 使用。replay 时传 false。 */
  captureDescriptors?: boolean;
  /** 隐式稳定性等待参数，覆盖 waitStable 的默认值 */
  stability?: StabilityOptions;
  /** 目标解析的轮询重试预算（ms），默认 3000；传 0 恢复一次性解析 */
  resolveRetryMs?: number;
  /** 视觉断言链路配置（screenshot-match 基线归属与更新模式） */
  visual?: VisualOptions;
  /** 步骤生命周期钩子（标注 / 进度 / 介入检测）；省略即不观察 */
  observer?: StepObserver;
}

export interface BatchResult {
  ok: boolean;
  results: StepResult[];
  vars: Record<string, string>;
  snapshot: string;
  /** 固化后的步骤：所有 {ref} 已替换为 {descriptor}，可直接写进 trace */
  capturedSteps: Step[];
  /** 失败现场产物（视觉断言三图等），随结果上交归档 */
  artifacts: RunArtifact[];
  failure?: FailureContext;
}

function classify(err: unknown): {
  kind: FailureKind;
  message: string;
  candidates?: string[];
} {
  if (err instanceof LocatorError) {
    return { kind: err.kind, message: err.message, candidates: err.candidates };
  }
  if (err instanceof AssertionFailure) {
    return { kind: "assert-failed", message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/超时/.test(message)) return { kind: "timeout", message };
  if (/navigat|net::ERR|Target closed|target closed/i.test(message)) {
    return { kind: "navigation-failed", message };
  }
  // 其余一律归为"动作执行失败"。以前这里兜底成 target-not-found，
  // 于是"点击其实成功了、只是后续步骤出错"也会被标成找不到元素，排障被带偏。
  return { kind: "action-failed", message };
}

/** 失败上下文：抓快照（失败不掩盖原始错误）+ console 报错 + 失败请求，一次给全 */
async function failureAt(
  opts: BatchOptions,
  index: number,
  step: Step,
  kind: FailureKind,
  message: string,
  candidates?: string[]
): Promise<FailureContext> {
  let snapshotText = "（快照获取失败）";
  try {
    snapshotText = (await takeSnapshot(opts.handle)).text;
  } catch { /* 快照失败不该掩盖原始错误 */ }
  return {
    failedIndex: index,
    failedStep: step,
    kind,
    message,
    snapshot: snapshotText,
    candidates: candidates?.slice(0, 10),
    consoleErrors: opts.collector.consoleErrors(),
    failedRequests: opts.collector.failedRequests()
  };
}

export async function runBatch(opts: BatchOptions): Promise<BatchResult> {
  const obs = opts.observer;
  const ctx: ActionContext = {
    handle: opts.handle,
    tracker: opts.tracker,
    refs: opts.refs,
    vars: { ...opts.vars },
    stability: opts.stability,
    resolveRetryMs: opts.resolveRetryMs ?? 3000,
    visual: opts.visual,
    artifacts: []
  };

  const results: StepResult[] = [];
  const capturedSteps: Step[] = [];
  const fail = (failure: FailureContext): BatchResult => ({
    ok: false, results, vars: ctx.vars, snapshot: failure.snapshot,
    capturedSteps, artifacts: ctx.artifacts ?? [], failure
  });

  await obs?.onRunStart(opts.steps.length);

  for (let i = 0; i < opts.steps.length; i++) {
    const raw = opts.steps[i];
    const t0 = Date.now();
    const notes: string[] = [];
    ctx.onResolved = undefined;
    ctx.lastWaitTimedOut = undefined;
    await obs?.onStepStart(i, raw);

    try {
      const step = interpolateStep(raw, ctx.vars);
      // ref 是单次快照内的短期句柄，不能进 trace，要固化成长期 descriptor。
      // 固化的时机必须早于动作本身：动作一旦触发导航或打开新标签，原元素就失效了，
      // 事后再固化必然失败——早先的版本因此把"点击成功且页面已跳转"误判为步骤失败。
      const target = (step as { target?: { ref?: string } }).target;
      const refName = target && typeof target === "object" && "ref" in target
        ? (target as { ref: string }).ref
        : undefined;

      let captured = step;
      if (opts.captureDescriptors !== false && refName !== undefined) {
        ctx.onResolved = async (backendNodeId: number) => {
          try {
            const descriptor = await buildDescriptor(opts.handle, backendNodeId);
            captured = { ...step, target: { descriptor } } as Step;
          } catch (err) {
            // 固化失败只降级成警告：跑得通比能回放重要，
            // 不能因为拿不到 descriptor 就把一个已经成功的动作判成失败。
            notes.push(
              `ref「${refName}」固化成 descriptor 失败（${err instanceof Error ? err.message : String(err)}）：` +
              `这一步不会进 trace，如需回放请重新探索这一步`
            );
          }
        };
      }

      if (step.action === "assert") {
        const note = await runAssert(ctx, step);
        if (note) notes.push(note);
      } else {
        await runAction(ctx, step);
      }
      ctx.onResolved = undefined;
      if (ctx.lastWaitTimedOut) {
        // 打满上限不抛错是设计（等不到静默不耽误干活），但这笔开销必须显形——
        // 否则持续流量页面上每一步都在静默地白付整个 timeout
        notes.push(
          `隐式等待打满 ${ctx.stability?.timeoutMs ?? 5000}ms 上限：页面有持续的接口请求或 DOM 变更，` +
          `可考虑调小 stability.timeoutMs 或为该步改用显式 wait`
        );
        ctx.lastWaitTimedOut = undefined;
      }
      if (
        opts.captureDescriptors !== false && refName !== undefined && captured === step
      ) {
        // 带 ref 的步骤没固化成功（固化抛错，或像 assert hidden 一样目标已不存在、
        // 根本没机会固化）。它进 trace 会让 save_trace 整体拒绝且本 session 无法恢复，
        // 所以按告警所说跳过它——跑得通比能回放重要。
        if (!notes.length) {
          notes.push(`ref「${refName}」未固化成 descriptor：这一步不会进 trace`);
        }
      } else {
        capturedSteps.push(captured);
      }

      // 介入检测在步骤边界结算：本步期间的用户操作归到本步
      const interruption = obs?.takeInterruption();
      const scrolls = obs?.takeScrollCount() ?? 0;
      const isLast = i === opts.steps.length - 1;
      if (scrolls > 0) notes.push(`执行期间检测到用户滚动 ${scrolls} 次（未中止）`);
      if (interruption && isLast) {
        // 所有步骤与断言都已通过，不因事后操作改判，只显形
        notes.push(`执行期间检测到用户操作（${describeInterruption(interruption)}），所有步骤已完成，结果仍有效`);
      } else if (interruption && opts.captureDescriptors !== false) {
        notes.push("执行期间有用户操作，save_trace 前请确认这一步");
      }

      const result: StepResult = {
        index: i,
        action: raw.action,
        ok: true,
        durationMs: Date.now() - t0,
        strategyIndex: ctx.lastResolve?.strategyIndex,
        error: [
          // sleep 成功也要显形：每出现一次都是一处该改成显式 wait 的技术债
          raw.action === "sleep" ? "使用了固定 sleep，建议改为显式 wait 条件" : "",
          ...notes
        ].filter(Boolean).join("；") || undefined
      };
      results.push(result);
      ctx.lastResolve = undefined;
      await obs?.onStepEnd(result);

      if (interruption && !isLast) {
        // 说明里不写步号：回放开 slowMo 时批次序号与 trace 真实序号不同，步号由渲染层按 failedIndex 显示
        const failure = await failureAt(
          opts, i + 1, opts.steps[i + 1], "user-interrupted",
          `检测到用户操作（${describeInterruption(interruption)}），已在上一步完成后停止，本步未执行`
        );
        await obs?.onRunEnd({ ok: false, failedIndex: i + 1, interrupted: true });
        return fail(failure);
      }
    } catch (err) {
      ctx.onResolved = undefined;
      const c = classify(err);
      const interruption = obs?.takeInterruption();
      obs?.takeScrollCount(); // 失败即结束，滚动计数一并清掉
      const kind: FailureKind = interruption ? "user-interrupted" : c.kind;
      const message = interruption
        ? `本步执行期间检测到用户操作（${describeInterruption(interruption)}）；原始错误：${c.kind}：${c.message}`
        : c.message;
      const result: StepResult = {
        index: i, action: raw.action, ok: false, durationMs: Date.now() - t0, error: message
      };
      results.push(result);
      await obs?.onStepEnd(result);
      const failure = await failureAt(opts, i, raw, kind, message, c.candidates);
      await obs?.onRunEnd({ ok: false, failedIndex: i, interrupted: interruption !== undefined });
      return fail(failure);
    }
  }

  const final = await takeSnapshot(opts.handle);
  opts.refs.clear();
  for (const [k, v] of final.refs) opts.refs.set(k, v);

  await obs?.onRunEnd({ ok: true, interrupted: false });
  return { ok: true, results, vars: ctx.vars, snapshot: final.text, capturedSteps, artifacts: ctx.artifacts ?? [] };
}
