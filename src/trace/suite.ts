import { basename } from "node:path";
import type { BrowserSession } from "../session/browser.js";
import { NetworkTracker } from "../waiter/stability.js";
import { DiagnosticsCollector } from "../diagnostics/collector.js";
import type { RunRecord } from "../types.js";
import { loadTrace } from "./store.js";
import { replayTrace } from "./replay.js";

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
  /** 失败用例的完整 run-record，接 heal_step 自愈循环 */
  record?: RunRecord;
}

export interface SuiteResult {
  total: number;
  ok: number;
  failed: number;
  /** 墙钟耗时：从编排开始到全部结束 */
  durationMs: number;
  results: SuiteTraceResult[];
}

export interface RunSuiteOptions {
  session: BrowserSession;
  paths: string[];
  vars: Record<string, string>;
  concurrency: number;
  slowMoMs?: number;
  resolveRetryMs?: number;
}

async function runOne(opts: RunSuiteOptions, path: string): Promise<SuiteTraceResult> {
  const t0 = Date.now();
  const { handle, release } = await opts.session.newIsolatedPage();
  try {
    const tracker = await NetworkTracker.attach(handle);
    const collector = await DiagnosticsCollector.attach(handle);
    const trace = await loadTrace(path);
    const rec = await replayTrace({
      handle, tracker, collector, trace, vars: opts.vars,
      slowMoMs: opts.slowMoMs, resolveRetryMs: opts.resolveRetryMs
    });
    return {
      path, name: trace.name, ok: rec.ok, durationMs: Date.now() - t0,
      stepCount: rec.steps.length, driftCount: rec.drifts.length,
      record: rec.ok ? undefined : rec
    };
  } catch (err) {
    // 未预期异常兜底为单条失败：trace 读不出/Context 创建失败等，
    // 不得向上抛——一条的意外不能拖垮整批
    return {
      path, name: basename(path), ok: false, durationMs: Date.now() - t0,
      stepCount: 0, driftCount: 0,
      error: err instanceof Error ? err.message : String(err)
    };
  } finally {
    await release();
  }
}

/**
 * 并行回放编排：信号量限流，每条 trace 一个独立 BrowserContext，
 * 跑完全部再汇总。concurrency=1 时自然退化为串行。
 */
export async function runSuite(opts: RunSuiteOptions): Promise<SuiteResult> {
  if (opts.paths.length === 0) throw new Error("tracePaths 不能为空");

  const t0 = Date.now();
  const results: SuiteTraceResult[] = new Array(opts.paths.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= opts.paths.length) return;
      results[i] = await runOne(opts, opts.paths[i]);
    }
  };

  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(opts.concurrency, opts.paths.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  const ok = results.filter((r) => r.ok).length;
  return {
    total: results.length,
    ok,
    failed: results.length - ok,
    durationMs: Date.now() - t0,
    results
  };
}
