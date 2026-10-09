import { basename } from "node:path";
import type { WindowSlot } from "../session/windowLayout.js";
import type { BrowserSession, PageHandle } from "../session/browser.js";
import type { StepObserver } from "../executor/observer.js";
import { NetworkTracker } from "../waiter/stability.js";
import { DiagnosticsCollector } from "../diagnostics/collector.js";
import type { RunRecord, Trace } from "../types.js";
import { PageClosedError } from "../session/pageErrors.js";
import { loadTraceSnapshot } from "./store.js";
import { replayTrace, pageClosedRecord } from "./replay.js";
import { archiveRun } from "../report/archive.js";
import type { AuthState } from "../session/auth.js";
import { applyAuth } from "../session/auth.js";
import { inspectVariables, MissingVariablesError } from "../executor/variables.js";

type PreparedTrace = PromiseSettledResult<Awaited<ReturnType<typeof loadTraceSnapshot>>>;

export const DEFAULT_CONCURRENCY = 3;
export const MAX_CONCURRENCY = 8;

export type ConcurrencyGate = { ok: true; value: number } | { ok: false; reason: string };

/** 并发上限校验：缺省 3、硬上限 8。纯函数，server 在建任何浏览器资源前调用。 */
export function checkConcurrency(requested: number | undefined): ConcurrencyGate {
  const n = requested ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(n) || n < 1) {
    return { ok: false, reason: `concurrency 必须是 ≥1 的整数，收到 ${JSON.stringify(requested)}` };
  }
  if (n > MAX_CONCURRENCY) {
    return { ok: false, reason: `concurrency=${n} 超过硬上限 ${MAX_CONCURRENCY}（防止打爆 Chrome 或靶场），请分批` };
  }
  return { ok: true, value: n };
}

export interface SuiteTraceResult {
  path: string;
  name: string;
  ok: boolean;
  /** 该条自身耗时（近似；并行时多条同时跑，各自的 durationMs 都含等待） */
  durationMs: number;
  stepCount: number;
  driftCount: number;
  /** 未预期异常（如 trace 文件读不出、Context 创建失败）；步骤失败走 record */
  error?: string;
  /** 完整 run-record（成功与失败都带；server 逐 trace 记账用，失败上下文接 heal_step） */
  record?: RunRecord;
  /** 与 record 实际运行的原始文件绑定的 SHA256。 */
  traceFingerprint?: string;
  /** 尝试次数（0 = 预检未执行；1 = 未重试；2 = 重试过） */
  attempts: number;
  /** 首次失败、重试通过——抖动而非真挂 */
  flaky?: boolean;
  /** 被用户打断（观察模式介入检测）：用户在场，不自动重试 */
  interrupted?: true;
  /** 页面在准备或执行阶段关闭，不自动重试。 */
  pageClosed?: true;
}

/** 用例级进度事件：首次失败即将重试发 retrying，最终结果发 done */
export interface TraceProgressInfo {
  traceIndex: number;
  path: string;
  name: string;
  attempt: 1 | 2;
  totalSteps: number;
}
export type TraceEvent =
  | ({ kind: "started" } & TraceProgressInfo)
  | ({ kind: "step"; completedSteps: number } & TraceProgressInfo)
  | { kind: "retrying" | "done"; result: SuiteTraceResult; traceIndex?: number };

export interface SuiteResult {
  total: number;
  ok: number;
  failed: number;
  /** 重试后通过（flaky）的条数 */
  flaky: number;
  /** 墙钟耗时：从编排开始到全部结束 */
  durationMs: number;
  results: SuiteTraceResult[];
  preflightFailed?: boolean;
  environmentUsed?: string[];
}

export interface RunSuiteOptions {
  session: BrowserSession;
  paths: string[];
  vars: Record<string, string>;
  concurrency: number;
  environmentNames?: ReadonlySet<string>;
  slowMoMs?: number;
  resolveRetryMs?: number;
  /** 归档根目录（默认 ./traces/runs；测试指向临时目录） */
  runsDir?: string;
  /** 认证态（session 默认或调用方显式指定）；注入到每个运行 Context */
  auth?: AuthState;
  /** 重录全部视觉基线并一律通过（等价 Playwright --update-snapshots） */
  updateBaselines?: boolean;
  /** 视觉基线根目录（默认 traces/baselines；测试指向临时目录） */
  baselineRoot?: string;
  /** 每次尝试的隔离页一个观察者（标注 + 介入检测）；省略即不观察 */
  observerFor?: (handle: PageHandle, traceName: string) => StepObserver | undefined;
  /** 用例级进度事件回调 */
  onTraceEvent?: (e: TraceEvent) => void;
}

/** 进度为旁路能力，同步或异步通知失败都不能改变运行结果。 */
function emitTraceEvent(opts: RunSuiteOptions, event: TraceEvent): void {
  if (!opts.onTraceEvent) return;
  try { Promise.resolve(opts.onTraceEvent(event)).catch(() => {}); } catch { /* best effort */ }
}

function traceObserver(opts: RunSuiteOptions, info: TraceProgressInfo, observer?: StepObserver): StepObserver | undefined {
  if (!opts.onTraceEvent) return observer;
  return {
    inputGate: observer?.inputGate,
    onRunStart: async total => { await observer?.onRunStart(total); },
    onStepStart: async (index, step, description) => { await observer?.onStepStart(index, step, description); },
    onStepEnd: async result => {
      await observer?.onStepEnd(result);
      emitTraceEvent(opts, { ...info, kind: "step", completedSteps: result.index + (result.ok ? 1 : 0) });
    },
    onRunEnd: async outcome => { await observer?.onRunEnd(outcome); },
    takeInterruption: () => observer?.takeInterruption(),
    takeScrollCount: () => observer?.takeScrollCount() ?? 0
  };
}

/** 单次尝试：独立 Context 完整重跑 + 归档（失败时抓截图进现场包） */
async function attemptOnce(
  opts: RunSuiteOptions,
  path: string,
  suffix: string,
  prepared: PreparedTrace,
  slot: WindowSlot,
  traceIndex: number
): Promise<SuiteTraceResult> {
  const t0 = Date.now();
  let resource: Awaited<ReturnType<BrowserSession["newIsolatedPage"]>> | undefined;
  let trace: Trace | undefined;
  let traceFingerprint: string | undefined;
  try {
    if (prepared.status === "rejected") throw prepared.reason;
    const snapshot = prepared.value;
    trace = snapshot.trace;
    traceFingerprint = snapshot.fingerprint;
    const info: TraceProgressInfo = { traceIndex, path, name: trace.name, attempt: suffix ? 2 : 1, totalSteps: trace.steps.length };
    emitTraceEvent(opts, { ...info, kind: "started" });
    resource = await opts.session.newIsolatedPage(slot);
    const { handle } = resource;
    const tracker = await NetworkTracker.attach(handle);
    const collector = await DiagnosticsCollector.attach(handle);
    if (opts.auth) await applyAuth(handle, opts.auth);
    const rec = await replayTrace({
      handle, tracker, collector, trace, vars: opts.vars, environmentNames: opts.environmentNames,
      slowMoMs: opts.slowMoMs, resolveRetryMs: opts.resolveRetryMs,
      visual: {
        traceName: trace.name,
        updateBaselines: opts.updateBaselines,
        baselineRoot: opts.baselineRoot
      },
      observer: traceObserver(opts, info, opts.observerFor?.(handle, trace.name))
    });

    // 失败现场包：截图必须在 Context release 前抓
    let screenshot: string | undefined;
    if (!rec.ok && !rec.failure?.retryBlocked) {
      screenshot = await collector.screenshot().catch(() => undefined);
    }
    await archiveRun({
      traceName: trace.name, record: rec, trace,
      screenshotBase64: screenshot, rootDir: opts.runsDir, suffix,
      artifacts: rec.artifacts
    });

    return {
      path, name: trace.name, ok: rec.ok, durationMs: Date.now() - t0,
      stepCount: rec.steps.length, driftCount: rec.drifts.length,
      // record 始终带上：server 要逐 trace 记账（suite→heal 闭环），ok 的 record 也有消费价值
      record: rec, traceFingerprint,
      attempts: suffix ? 2 : 1
    };
  } catch (err) {
    if (trace && (err instanceof PageClosedError || resource?.handle.page.isClosed())) {
      const message = err instanceof PageClosedError ? err.message : new PageClosedError(resource!.handle.pageId).message;
      const record = pageClosedRecord(trace, message, t0);
      await archiveRun({ traceName: trace.name, record, trace, rootDir: opts.runsDir, suffix });
      return {
        path, name: trace.name, ok: false, durationMs: Date.now() - t0,
        stepCount: 0, driftCount: 0, record, traceFingerprint, pageClosed: true, attempts: suffix ? 2 : 1
      };
    }
    // 未预期异常兜底为单条失败：trace 读不出/Context 创建失败等，
    // 不得向上抛——一条的意外不能拖垮整批
    return {
      path, name: basename(path), ok: false, durationMs: Date.now() - t0,
      stepCount: 0, driftCount: 0,
      error: err instanceof Error ? err.message : String(err),
      attempts: suffix ? 2 : 1
    };
  } finally {
    await resource?.release();
  }
}

const isInterrupted = (r: SuiteTraceResult): boolean => r.record?.failure?.kind === "user-interrupted";

/** 只有结构化暂态类型允许新 Context 重跑一次；介入/关闭/状态不确定优先阻止。 */
async function runOne(opts: RunSuiteOptions, path: string, prepared: PreparedTrace, slot: WindowSlot, traceIndex: number): Promise<SuiteTraceResult> {
  const done = (r: SuiteTraceResult): SuiteTraceResult => {
    emitTraceEvent(opts, { kind: "done", result: r, traceIndex });
    return r;
  };
  const first = await attemptOnce(opts, path, "", prepared, slot, traceIndex);
  if (first.ok) return done(first);
  // 用户在场才会被打断：重试大概率再被打断，如实报告即可
  if (isInterrupted(first)) return done({ ...first, interrupted: true });
  if (first.record?.failure?.retryBlocked) return done(first);
  if (first.pageClosed || first.record?.failure?.kind === "page-closed") return done(first);
  const kind = first.record?.failure?.kind;
  if (kind !== "timeout" && kind !== "navigation-failed") return done(first);
  emitTraceEvent(opts, { kind: "retrying", result: first, traceIndex });
  const second = await attemptOnce(opts, path, "-retry", prepared, slot, traceIndex);
  return done({
    ...second,
    flaky: second.ok || undefined,
    ...(isInterrupted(second) ? { interrupted: true as const } : {})
  });
}

/**
 * 并行回放编排：信号量限流，每条 trace 一个独立 BrowserContext，
 * 跑完全部再汇总。concurrency=1 时自然退化为串行。
 */
export async function runSuite(opts: RunSuiteOptions): Promise<SuiteResult> {
  if (opts.paths.length === 0) throw new Error("tracePaths 不能为空");

  const t0 = Date.now();
  const prepared = await Promise.allSettled(opts.paths.map(loadTraceSnapshot));
  const inspections = prepared.map((input) => input.status === "fulfilled"
    ? inspectVariables(input.value.trace.steps, opts.vars, opts.environmentNames)
    : { missing: [], environmentUsed: [] });
  const environmentUsed = [...new Set(inspections.flatMap((item) => item.environmentUsed))].sort();
  if (inspections.some((item) => item.missing.length > 0)) {
    const results: SuiteTraceResult[] = prepared.map((input, index) => ({
      path: opts.paths[index],
      name: input.status === "fulfilled" ? input.value.trace.name : basename(opts.paths[index]),
      ok: false, durationMs: 0, stepCount: 0, driftCount: 0, attempts: 0,
      error: inspections[index].missing.length
        ? new MissingVariablesError(inspections[index].missing).message
        : input.status === "rejected"
          ? (input.reason instanceof Error ? input.reason.message : String(input.reason))
          : "因其他用例缺失变量，本用例未执行。"
    }));
    results.forEach((result, traceIndex) => emitTraceEvent(opts, { kind: "done", result, traceIndex }));
    return { total: results.length, ok: 0, failed: results.length, flaky: 0,
      durationMs: Date.now() - t0, results, preflightFailed: true,
      ...(environmentUsed.length ? { environmentUsed } : {}) };
  }
  const results: SuiteTraceResult[] = new Array(opts.paths.length);
  let next = 0;

  const workerCount = Math.min(opts.concurrency, opts.paths.length);
  const worker = async (index: number): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= opts.paths.length) return;
      results[i] = await runOne(opts, opts.paths[i], prepared[i], { index, of: workerCount }, i);
    }
  };

  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push(worker(w));
  }
  await Promise.all(workers);

  const ok = results.filter((r) => r.ok).length;
  return {
    total: results.length,
    ok,
    failed: results.length - ok,
    flaky: results.filter((r) => r.flaky).length,
    durationMs: Date.now() - t0,
    results,
    ...(environmentUsed.length ? { environmentUsed } : {})
  };
}
