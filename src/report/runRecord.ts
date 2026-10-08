import type { RunRecord } from "../types.js";
import { failureUrlNotice } from "../session/pageUrl.js";
import { interruptionRecovery, type RecoveryMode } from "./interruptionRecovery.js";

export function renderRunRecord(rec: RunRecord, mode: RecoveryMode = "replay"): string {
  const stopAt = (rec.failure?.failedIndex ?? 0) + 1;
  const head = rec.ok
    ? `✅ ${rec.traceName} 回放成功 — ${rec.steps.length} 步，合计 ${rec.durationMs}ms`
    : rec.failure?.kind === "user-interrupted"
      ? `✋ ${rec.traceName} 被用户打断 — 停在第 ${stopAt} 步，已耗时 ${rec.durationMs}ms`
      : `❌ ${rec.traceName} 回放失败 — 在第 ${stopAt} 步中断，已耗时 ${rec.durationMs}ms`;

  const recovery = rec.ok ? "" : interruptionRecovery(rec.failure, mode);
  const lines = [`# ${head}`, "", ...(recovery ? [recovery.trimEnd(), ""] : []), "## 逐步耗时", ""];
  for (const s of rec.steps) {
    const mark = s.ok ? "·" : "✗";
    const strat = s.strategyIndex !== undefined && s.strategyIndex >= 0
      ? `（命中第 ${s.strategyIndex + 1} 条策略）` : "";
    // 步骤告警（基线已创建/已更新、固化失败、等待打满等）在台账里显形——与 batch 响应一致
    const note = s.error ? ` ⚠ ${s.error}` : "";
    lines.push(`${mark} ${s.index + 1}. ${s.action} — ${s.durationMs}ms ${strat}${note}`);
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
      ...(f.currentUrl === undefined ? [] : [failureUrlNotice(f).trimEnd(), ""]),
      "**失败步骤**", "```json", JSON.stringify(f.failedStep, null, 2), "```", "",
      "**当前快照**", "```", f.snapshot, "```", "",
      `**console 报错**`, f.consoleErrors.join("\n") || "（无）", "",
      `**失败请求**`, f.failedRequests.join("\n") || "（无）"
    );
  }

  return lines.join("\n");
}
