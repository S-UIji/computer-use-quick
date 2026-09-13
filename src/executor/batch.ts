import type { PageHandle } from "../session/browser.js";
import type { NetworkTracker } from "../waiter/stability.js";
import type { DiagnosticsCollector } from "../diagnostics/collector.js";
import type { FailureContext, FailureKind, Step, StepResult } from "../types.js";
import { runAction, type ActionContext } from "./actions.js";
import { runAssert, AssertionFailure } from "../assertion/assert.js";
import { interpolateStep } from "./variables.js";
import { LocatorError } from "../locator/resolve.js";
import { takeSnapshot } from "../perception/snapshot.js";

export interface BatchOptions {
  handle: PageHandle;
  tracker: NetworkTracker;
  collector: DiagnosticsCollector;
  refs: Map<string, number>;
  vars: Record<string, string>;
  steps: Step[];
}

export interface BatchResult {
  ok: boolean;
  results: StepResult[];
  vars: Record<string, string>;
  snapshot: string;
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
      results.push({
        index: i,
        action: raw.action,
        ok: true,
        durationMs: Date.now() - t0,
        // sleep 成功也要显形：每出现一次都是一处该改成显式 wait 的技术债
        error: raw.action === "sleep"
          ? "使用了固定 sleep，建议改为显式 wait 条件"
          : undefined
      });
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

  return { ok: true, results, vars: ctx.vars, snapshot: final.text };
}
