import type { SuiteResult, TraceEvent } from "../trace/suite.js";
import { renderSuiteFailureGroups } from "./suiteFailureGroups.js";

/**
 * 并行 suite 的聚合报告：概览 + 每条 compact + 失败全量上下文。
 * 失败上下文不截断——它的下一个消费者是 heal_step，信息少了会让自愈多烧模型 turn。
 */
export function renderSuiteResult(r: SuiteResult): string {
  const flakyPart = r.flaky > 0 ? `（flaky ${r.flaky}）` : "";
  const lines: string[] = [
    `# replay_suite：${r.total} 条 — ${r.ok} 成功 / ${r.failed} 失败${flakyPart}，墙钟 ${(r.durationMs / 1000).toFixed(1)}s`,
    ""
  ];

  for (const t of r.results) {
    const attemptNote = !t.ok && t.attempts === 2 ? "，尝试 2 次" : !t.ok && t.attempts === 1 ? "，未自动重试" : "";
    if (t.ok) {
      const mark = t.flaky ? `✓ ${t.name}（flaky，重试后通过）` : `✓ ${t.name}`;
      lines.push(`${mark} — ${t.stepCount} 步，${(t.durationMs / 1000).toFixed(1)}s，漂移 ${t.driftCount}`);
    } else if (t.interrupted) {
      lines.push(
        `✋ ${t.name} — 被用户打断（停在第 ${(t.record?.failure?.failedIndex ?? 0) + 1} 步），` +
        `${(t.durationMs / 1000).toFixed(1)}s${attemptNote}`
      );
    } else if (t.error !== undefined) {
      const label = t.attempts === 0 ? "预检未通过，未执行" : "未预期异常";
      lines.push(`✗ ${t.name} — ${label}：${t.error}${attemptNote}`);
    } else {
      const f = t.record?.failure;
      lines.push(
        `✗ ${t.name} — 第 ${(f?.failedIndex ?? 0) + 1} 步失败（${f?.kind ?? "unknown"}），` +
        `${(t.durationMs / 1000).toFixed(1)}s，漂移 ${t.driftCount}${attemptNote}`
      );
    }
  }

  // 被用户打断的不是页面问题，heal_step 也会拒修，不列入可自愈段
  const failed = r.results.filter((t) => !t.ok && t.record && !t.interrupted && !t.pageClosed && !t.record.failure?.retryBlocked && t.record.failure?.kind !== "page-closed");
  if (failed.length > 0) {
    lines.push("", "## 失败上下文（可接 heal_step 自愈）", "");
    lines.push(...renderSuiteFailureGroups(failed));
  }

  const blocked = r.results.filter((t) => !t.ok && t.record?.failure?.retryBlocked);
  if (blocked.length) {
    lines.push("", "## 需要人工恢复（停止后续重试）", "");
    lines.push(...renderSuiteFailureGroups(blocked));
    lines.push("请按失败提示恢复页面或连接，并 snapshot 核实副作用，避免直接重试。", "");
  }

  const closed = r.results.filter((t) => !t.ok && (t.pageClosed || t.record?.failure?.kind === "page-closed"));
  if (closed.length > 0) {
    lines.push("", "## 页面关闭 page-closed（停止后续重试，无需 heal_step）", "");
    lines.push(...renderSuiteFailureGroups(closed));
    lines.push("请恢复页面后重新运行。", "");
  }

  if (r.results.some((t) => t.interrupted)) {
    lines.push("", "被用户打断的用例不是页面问题，无需 heal_step，重新运行即可。", "");
  }

  // 机读收尾行：固定格式、固定位置（最后一行），CI 日志 grep 出退出依据。值纯数字无空格。
  lines.push(`SUITE_RESULT ok=${r.ok} failed=${r.failed} total=${r.total} wall_ms=${r.durationMs}`);

  return lines.join("\n");
}

/** 用例级进度说明（replay_suite 推送 notifications/progress 用） */
export function renderTraceEvent(e: TraceEvent): string {
  if (e.kind === "started") return e.name + " 开始（第 " + e.attempt + " 次，" + e.totalSteps + " 步）";
  if (e.kind === "step") return e.name + " 已完成 " + e.completedSteps + "/" + e.totalSteps + " 步";
  const t = e.result;
  const name = e.traceIndex === undefined ? t.name : "#" + (e.traceIndex + 1) + " " + t.name;
  const kind = t.attempts === 0 ? "preflight-failed"
    : t.record?.failure?.kind ?? (t.error !== undefined ? "unexpected-error" : "unknown");
  if (e.kind === "retrying") return `${name} ✗ ${kind}，重试中`;
  if (t.ok) return `${name} ✓ ${(t.durationMs / 1000).toFixed(1)}s${t.flaky ? "（flaky）" : ""}`;
  if (t.interrupted) return `${name} ✋ 被用户打断`;
  return `${name} ✗ ${kind}`;
}
