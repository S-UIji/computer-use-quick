import type { PageHandle } from "../session/browser.js";
import type { NetworkTracker } from "../waiter/stability.js";
import type { DiagnosticsCollector } from "../diagnostics/collector.js";
import type { RunRecord, Trace, Step, Descriptor, VisualOptions } from "../types.js";
import { runBatch } from "../executor/batch.js";

export interface ReplayOptions {
  handle: PageHandle;
  tracker: NetworkTracker;
  collector: DiagnosticsCollector;
  trace: Trace;
  vars: Record<string, string>;
  /** 每步之间的额外延迟，用于演示场景让人看得见操作。默认 0。 */
  slowMoMs?: number;
  /** 目标解析的轮询重试预算（ms），默认 3000；传 0 恢复一次性解析 */
  resolveRetryMs?: number;
  /** 视觉断言链路配置（screenshot-match 基线归属与更新模式） */
  visual?: VisualOptions;
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
    captureDescriptors: false,
    resolveRetryMs: opts.resolveRetryMs,
    visual: opts.visual
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

  // 失败上下文里的步序号同样换算回真实步序号
  const failure = r.failure
    ? { ...r.failure, failedIndex: realIndex[r.failure.failedIndex] }
    : r.failure;

  return {
    traceName: opts.trace.name,
    startedAt,
    durationMs: Date.now() - t0,
    ok: r.ok,
    steps: realResults,
    drifts,
    failure,
    healRequired: !r.ok,
    artifacts: r.artifacts.length > 0 ? r.artifacts : undefined
  };
}
