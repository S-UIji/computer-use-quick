import type { RunRecord } from "../types.js";

export function renderRunRecord(rec: RunRecord): string {
  const head = rec.ok
    ? `✅ ${rec.traceName} 回放成功 — ${rec.steps.length} 步，合计 ${rec.durationMs}ms`
    : `❌ ${rec.traceName} 回放失败 — 在第 ${(rec.failure?.failedIndex ?? 0) + 1} 步中断，已耗时 ${rec.durationMs}ms`;

  const lines = [`# ${head}`, "", "## 逐步耗时", ""];
  for (const s of rec.steps) {
    const mark = s.ok ? "·" : "✗";
    const strat = s.strategyIndex !== undefined && s.strategyIndex >= 0
      ? `（命中第 ${s.strategyIndex + 1} 条策略）` : "";
    lines.push(`${mark} ${s.index + 1}. ${s.action} — ${s.durationMs}ms ${strat}`);
  }

  if (rec.drifts.length > 0) {
    lines.push("", "## ⚠ 定位漂移告警", "");
    lines.push("以下步骤的首选定位策略已失效，回放仍成功但页面结构可能已改版：", "");
    for (const d of rec.drifts) {
      lines.push(`- 第 ${d.index + 1} 步：期望 ${d.expected}，实际回退到 ${d.actual}`);
    }
  }

  if (rec.failure) {
    const f = rec.failure;
    lines.push(
      "", `## 失败上下文（heal_required=${rec.healRequired}）`, "",
      `**类型**：${f.kind}`, `**信息**：${f.message}`, "",
      "**失败步骤**", "```json", JSON.stringify(f.failedStep, null, 2), "```", "",
      "**当前快照**", "```", f.snapshot, "```", "",
      `**console 报错**`, f.consoleErrors.join("\n") || "（无）", "",
      `**失败请求**`, f.failedRequests.join("\n") || "（无）"
    );
  }

  return lines.join("\n");
}
