import { basename } from "node:path";
import type { BrowserSession } from "../session/browser.js";
import { NetworkTracker } from "../waiter/stability.js";
import { DiagnosticsCollector } from "../diagnostics/collector.js";
import type { RunRecord } from "../types.js";
import { loadTrace } from "./store.js";
import { replayTrace } from "./replay.js";
import { archiveRun } from "../report/archive.js";
import type { AuthState } from "../session/auth.js";
import { applyAuth } from "../session/auth.js";

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
  /** 尝试次数（1 = 未重试；2 = 重试过） */
  attempts: number;
  /** 首次失败、重试通过——抖动而非真挂 */
  flaky?: boolean;
}

export interface SuiteResult {
  total: number;
  ok: number;
  failed: number;
  /** 重试后通过（flaky）的条数 */
  flaky: number;
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
  /** 归档根目录（默认 ./traces/runs；测试指向临时目录） */
  runsDir?: string;
  /** 认证态（session 默认或调用方显式指定）；注入到每个运行 Context */
  auth?: AuthState;
  /** 重录全部视觉基线并一律通过（等价 Playwright --update-snapshots） */
  updateBaselines?: boolean;
  /** 视觉基线根目录（默认 traces/baselines；测试指向临时目录） */
  baselineRoot?: string;
}

/** 单次尝试：独立 Context 完整重跑 + 归档（失败时抓截图进现场包） */
async function attemptOnce(
  opts: RunSuiteOptions,
  path: string,
  suffix: string
): Promise<SuiteTraceResult> {
  const t0 = Date.now();
  const { handle, release } = await opts.session.newIsolatedPage();
  try {
    const tracker = await NetworkTracker.attach(handle);
    const collector = await DiagnosticsCollector.attach(handle);
    if (opts.auth) await applyAuth(handle, opts.auth);
    const trace = await loadTrace(path);
    const rec = await replayTrace({
      handle, tracker, collector, trace, vars: opts.vars,
      slowMoMs: opts.slowMoMs, resolveRetryMs: opts.resolveRetryMs,
      visual: {
        traceName: trace.name,
        updateBaselines: opts.updateBaselines,
        baselineRoot: opts.baselineRoot
      }
    });

    // 失败现场包：截图必须在 Context release 前抓
    let screenshot: string | undefined;
    if (!rec.ok) {
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
      record: rec,
      attempts: suffix ? 2 : 1
    };
  } catch (err) {
    // 未预期异常兜底为单条失败：trace 读不出/Context 创建失败等，
    // 不得向上抛——一条的意外不能拖垮整批
    return {
      path, name: basename(path), ok: false, durationMs: Date.now() - t0,
      stepCount: 0, driftCount: 0,
      error: err instanceof Error ? err.message : String(err),
      attempts: suffix ? 2 : 1
    };
  } finally {
    await release();
  }
}

/** 单条运行：失败则用全新 Context 完整重跑 1 次，以最终结果为准 */
async function runOne(opts: RunSuiteOptions, path: string): Promise<SuiteTraceResult> {
  const first = await attemptOnce(opts, path, "");
  if (first.ok) return first;
  const second = await attemptOnce(opts, path, "-retry");
  return { ...second, flaky: second.ok || undefined };
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
    flaky: results.filter((r) => r.flaky).length,
    durationMs: Date.now() - t0,
    results
  };
}
