import type { PageHandle } from "../session/browser.js";
import type { NetworkTracker } from "../waiter/stability.js";
import type { DiagnosticsCollector } from "../diagnostics/collector.js";
import type { RunRecord, Trace, Step, Descriptor } from "../types.js";
import { runBatch } from "../executor/batch.js";

export interface ReplayOptions {
  handle: PageHandle;
  tracker: NetworkTracker;
  collector: DiagnosticsCollector;
  trace: Trace;
  vars: Record<string, string>;
  /** 每步之间的额外延迟，用于演示场景让人看得见操作。默认 0。 */
  slowMoMs?: number;
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

export async function replayTrace(opts: ReplayOptions): Promise<RunRecord> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const steps = opts.trace.steps.map((s) => absolutize(s, opts.trace.baseUrl));
  const slowMo = opts.slowMoMs ?? 0;

  const withSlowMo: Step[] = slowMo > 0
    ? steps.flatMap((s, i) => (i === 0 ? [s] : [{ action: "sleep", ms: slowMo } as Step, s]))
    : steps;

  const r = await runBatch({
    handle: opts.handle,
    tracker: opts.tracker,
    collector: opts.collector,
    refs: new Map(),
    vars: opts.vars,
    steps: withSlowMo,
    captureDescriptors: false
  });

  // slowMo 插入的 sleep 步骤不该出现在台账里，去掉并重排序号
  const realResults = slowMo > 0
    ? r.results.filter((s) => s.action !== "sleep").map((s, i) => ({ ...s, index: i }))
    : r.results;

  const drifts: RunRecord["drifts"] = [];
  for (const s of realResults) {
    if (s.strategyIndex === undefined || s.strategyIndex <= 0) continue;
    const step = steps[s.index];
    const expected = strategyKindAt(step, 0);
    const actual = strategyKindAt(step, s.strategyIndex);
    if (expected && actual) drifts.push({ index: s.index, expected, actual });
  }

  // 失败上下文里的步序号也要按真实步计（slowMo 会撑大 runBatch 的序号）
  const failure = r.failure && slowMo > 0
    ? { ...r.failure, failedIndex: Math.floor(r.failure.failedIndex / 2) }
    : r.failure;

  return {
    traceName: opts.trace.name,
    startedAt,
    durationMs: Date.now() - t0,
    ok: r.ok,
    steps: realResults,
    drifts,
    failure,
    healRequired: !r.ok
  };
}
