import type { PageHandle } from "../session/browser.js";
import type { NetworkTracker } from "../waiter/stability.js";
import type { DiagnosticsCollector } from "../diagnostics/collector.js";
import type { FailureContext, FailureKind, Step, StepResult } from "../types.js";
import { runAction, type ActionContext } from "./actions.js";
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
  if (/navigat/i.test(message)) return { kind: "navigation-failed", message };
  return { kind: "target-not-found", message };
}

export async function runBatch(opts: BatchOptions): Promise<BatchResult> {
  const ctx: ActionContext = {
    handle: opts.handle,
    tracker: opts.tracker,
    refs: opts.refs,
    vars: { ...opts.vars }
  };

  const results: StepResult[] = [];
  const capturedSteps: Step[] = [];

  for (let i = 0; i < opts.steps.length; i++) {
    const raw = opts.steps[i];
    const t0 = Date.now();

    try {
      const step = interpolateStep(raw, ctx.vars);
      if (step.action === "assert") {
        await runAssert(ctx, step);
      } else {
        await runAction(ctx, step);
      }
      // ref 是单次快照内的短期句柄，不能进 trace。趁元素刚解析成功、
      // 还在页面上时把它固化成长期 descriptor（懒计算的正确时机）。
      let captured = step;
      if (opts.captureDescriptors !== false && ctx.lastResolve && "target" in step) {
        const target = (step as { target: unknown }).target;
        if (target && typeof target === "object" && "ref" in target) {
          const descriptor = await buildDescriptor(opts.handle, ctx.lastResolve.backendNodeId);
          captured = { ...step, target: { descriptor } } as Step;
        }
      }
      capturedSteps.push(captured);

      results.push({
        index: i,
        action: raw.action,
        ok: true,
        durationMs: Date.now() - t0,
        strategyIndex: ctx.lastResolve?.strategyIndex,
        // sleep 成功也要显形：每出现一次都是一处该改成显式 wait 的技术债
        error: raw.action === "sleep"
          ? "使用了固定 sleep，建议改为显式 wait 条件"
          : undefined
      });
      ctx.lastResolve = undefined;
    } catch (err) {
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
