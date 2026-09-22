import type { SuiteResult } from "../trace/suite.js";
import { renderRunRecord } from "./runRecord.js";

/**
 * 并行 suite 的聚合报告：概览 + 每条 compact + 失败全量上下文。
 * 失败上下文不截断——它的下一个消费者是 heal_step，信息少了会让自愈多烧模型 turn。
 */
export function renderSuiteResult(r: SuiteResult): string {
  const lines: string[] = [
    `# replay_suite：${r.total} 条 — ${r.ok} 成功 / ${r.failed} 失败，墙钟 ${(r.durationMs / 1000).toFixed(1)}s`,
    ""
  ];

  for (const t of r.results) {
    if (t.ok) {
      lines.push(`✓ ${t.name} — ${t.stepCount} 步，${(t.durationMs / 1000).toFixed(1)}s，漂移 ${t.driftCount}`);
    } else if (t.error !== undefined) {
      lines.push(`✗ ${t.name} — 未预期异常：${t.error}`);
    } else {
      const f = t.record?.failure;
      lines.push(
        `✗ ${t.name} — 第 ${(f?.failedIndex ?? 0) + 1} 步失败（${f?.kind ?? "unknown"}），` +
        `${(t.durationMs / 1000).toFixed(1)}s，漂移 ${t.driftCount}`
      );
    }
  }

  const failed = r.results.filter((t) => !t.ok && t.record);
  if (failed.length > 0) {
    lines.push("", "## 失败上下文（可接 heal_step 自愈）", "");
    for (const t of failed) {
      lines.push(`### ${t.name}`, "", renderRunRecord(t.record!), "");
    }
  }

  // 机读收尾行：固定格式、固定位置（最后一行），CI 日志 grep 出退出依据。值纯数字无空格。
  lines.push(`SUITE_RESULT ok=${r.ok} failed=${r.failed} total=${r.total} wall_ms=${r.durationMs}`);

  return lines.join("\n");
}
