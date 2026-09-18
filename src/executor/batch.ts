import type { PageHandle } from "../session/browser.js";
import type { NetworkTracker } from "../waiter/stability.js";
import type { DiagnosticsCollector } from "../diagnostics/collector.js";
import type { FailureContext, FailureKind, Step, StepResult } from "../types.js";
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
}

export interface BatchResult {
  ok: boolean;
  results: StepResult[];
  vars: Record<string, string>;
  snapshot: string;
  /** 固化后的步骤：所有 {ref} 已替换为 {descriptor}，可直接写进 trace */
  capturedSteps: Step[];
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

export async function runBatch(opts: BatchOptions): Promise<BatchResult> {
  const ctx: ActionContext = {
    handle: opts.handle,
    tracker: opts.tracker,
    refs: opts.refs,
    vars: { ...opts.vars },
    stability: opts.stability
  };

  const results: StepResult[] = [];
  const capturedSteps: Step[] = [];

  for (let i = 0; i < opts.steps.length; i++) {
    const raw = opts.steps[i];
    const t0 = Date.now();
    const notes: string[] = [];
    ctx.onResolved = undefined;

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
        await runAssert(ctx, step);
      } else {
        await runAction(ctx, step);
      }
      ctx.onResolved = undefined;
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

      results.push({
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
      });
      ctx.lastResolve = undefined;
    } catch (err) {
      ctx.onResolved = undefined;
      const { kind, message, candidates } = classify(err);
      results.push({
        index: i, action: raw.action, ok: false, durationMs: Date.now() - t0, error: message
      });

      let snapshotText = "（快照获取失败）";
      try {
        snapshotText = (await takeSnapshot(opts.handle)).text;
      } catch { /* 快照失败不该掩盖原始错误 */ }

      return {
        ok: false,
        results,
        vars: ctx.vars,
        snapshot: snapshotText,
        capturedSteps,
        failure: {
          failedIndex: i,
          failedStep: raw,
          kind,
          message,
          snapshot: snapshotText,
          candidates: candidates?.slice(0, 10),
          consoleErrors: opts.collector.consoleErrors(),
          failedRequests: opts.collector.failedRequests()
        }
      };
    }
  }

  const final = await takeSnapshot(opts.handle);
  opts.refs.clear();
  for (const [k, v] of final.refs) opts.refs.set(k, v);

  return { ok: true, results, vars: ctx.vars, snapshot: final.text, capturedSteps };
}
