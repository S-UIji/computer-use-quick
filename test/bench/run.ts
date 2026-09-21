import type { PageHandle } from "../../src/session/browser.js";
import type { NetworkTracker } from "../../src/waiter/stability.js";
import type { DiagnosticsCollector } from "../../src/diagnostics/collector.js";
import type { Trace } from "../../src/types.js";
import { replayTrace, absolutize } from "../../src/trace/replay.js";
import { runBatch } from "../../src/executor/batch.js";
import { takeSnapshot } from "../../src/perception/snapshot.js";

export interface BenchOptions {
  handle: PageHandle;
  tracker: NetworkTracker;
  collector: DiagnosticsCollector;
  trace: Trace;
  vars: Record<string, string>;
  rounds?: number;
}

export interface BenchReport {
  steps: number;
  turnsA: number;
  turnsB: number;
  turnsC: number;
  medianAMs: number;
  medianBMs: number;
  medianCMs: number;
  markdown: string;
}

/** 探索模式下模型一批塞多少步。取 5 是保守估计，实际常能一批更多 */
const BATCH_SIZE = 5;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** A：单步模式——模拟现状，每步一次 snapshot + 一步 batch（1 turn = 1 snapshot + 1 action） */
async function runModeA(o: BenchOptions): Promise<number> {
  const t0 = Date.now();
  const steps = o.trace.steps.map((s) => absolutize(s, o.trace.baseUrl));
  for (let i = 0; i < steps.length; i++) {
    await takeSnapshot(o.handle);
    const r = await runBatch({
      handle: o.handle, tracker: o.tracker, collector: o.collector,
      refs: new Map(), vars: o.vars,
      steps: [steps[i]],
      captureDescriptors: false
    });
    if (!r.ok) {
      throw new Error(
        `基准测试的 A 模式在第 ${i + 1} 步失败：` +
        `${r.failure?.kind} ${r.failure?.message}`
      );
    }
  }
  return Date.now() - t0;
}

/** B：探索模式——每 BATCH_SIZE 步一次 batch，每批前先 snapshot */
async function runModeB(o: BenchOptions): Promise<number> {
  const t0 = Date.now();
  // 和 replayTrace 一样要补全相对 url，否则测的是一路失败
  const steps = o.trace.steps.map((s) => absolutize(s, o.trace.baseUrl));
  for (let i = 0; i < steps.length; i += BATCH_SIZE) {
    await takeSnapshot(o.handle);
    const r = await runBatch({
      handle: o.handle, tracker: o.tracker, collector: o.collector,
      refs: new Map(), vars: o.vars,
      steps: steps.slice(i, i + BATCH_SIZE),
      captureDescriptors: false
    });
    // runBatch 失败是返回值不是异常。不检查就会把"快速失败"当成"快速成功"测进去，
    // 那样的基准数字比没有更糟。
    if (!r.ok) {
      throw new Error(
        `基准测试的 B 模式在第 ${(r.failure?.failedIndex ?? 0) + i + 1} 步失败：` +
        `${r.failure?.kind} ${r.failure?.message}`
      );
    }
  }
  return Date.now() - t0;
}

/**
 * 每轮之间把站点存储清掉。trace 假定从登出态开始，而一轮跑完浏览器是登录态，
 * 不清理的话下一轮 navigate 会被重定向进主页、登录步骤全部落空（实测）。
 */
async function resetSiteState(o: BenchOptions): Promise<void> {
  await o.handle.page.goto(o.trace.baseUrl, { waitUntil: "load" });
  await o.handle.page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
}

export async function runBench(o: BenchOptions): Promise<BenchReport> {
  const rounds = o.rounds ?? 5;
  const steps = o.trace.steps.length;

  const aTimes: number[] = [];
  const bTimes: number[] = [];
  const cTimes: number[] = [];
  for (let i = 0; i < rounds; i++) {
    await resetSiteState(o);
    aTimes.push(await runModeA(o));
    await resetSiteState(o);
    bTimes.push(await runModeB(o));
    await resetSiteState(o);
    const rec = await replayTrace({ ...o });
    if (!rec.ok) {
      throw new Error(
        `基准测试的 C 模式回放失败（第 ${(rec.failure?.failedIndex ?? 0) + 1} 步）：` +
        `${rec.failure?.kind} ${rec.failure?.message}`
      );
    }
    cTimes.push(rec.durationMs);
  }

  const medianAMs = median(aTimes);
  const medianBMs = median(bTimes);
  const medianCMs = median(cTimes);
  const turnsA = steps;
  const turnsB = Math.ceil(steps / BATCH_SIZE) * 2;
  const turnsC = 1;

  const markdown = [
    `# 基准测试 — ${o.trace.name}`,
    "",
    `步骤数 ${steps} · 轮次 ${rounds}（取中位数）`,
    "",
    "| 方式 | 说明 | agent turn 数 | 实测耗时 |",
    "|---|---|---|---|",
    `| A | 单步模式：每步 snapshot + 1 步 batch | ${turnsA} | ${medianAMs}ms |`,
    `| B | 探索模式：snapshot + batch 交替 | ${turnsB} | ${medianBMs}ms |`,
    `| C | 回放模式：一次 replay，零模型 | ${turnsC} | ${medianCMs}ms |`,
    "",
    `**turn 数下降**：A→B 减少 ${turnsA - turnsB} 次` +
      `（${Math.round((1 - turnsB / turnsA) * 100)}%），` +
      `A→C 减少 ${turnsA - turnsC} 次（${Math.round((1 - turnsC / turnsA) * 100)}%）`,
    "",
    "> A/B/C 三种模式的工具耗时均已自动测量。",
    "> 模型思考时间未计入——实际提速取决于模型往返速度（设计文档估算 3-10s/turn）。"
  ].join("\n");

  return { steps, turnsA, turnsB, turnsC, medianAMs, medianBMs, medianCMs, markdown };
}
