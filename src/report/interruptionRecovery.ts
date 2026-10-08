import type { FailureContext } from "../types.js";

export type RecoveryMode = "batch" | "replay" | "heal";

/** 只根据结构化中断类型提供恢复动作，不从错误文字猜测。 */
export function interruptionRecovery(
  failure: Pick<FailureContext, "kind" | "failedIndex"> | undefined,
  mode: RecoveryMode = "replay"
): string {
  if (failure?.kind !== "user-interrupted") return "";
  const wait = "下一步：不要立即重试；先确认用户操作已完成。";
  if (mode === "batch") {
    return wait + `继续时先 snapshot 刷新页面和 ref，核实第 ${failure.failedIndex + 1} 步的执行效果，再从该步或剩余步骤重新提交。\n\n`;
  }
  if (mode === "heal") {
    return wait + "核实页面状态；使用 ref 演示时先 snapshot 并更新 ref，再以原始修复步号和修复参数重新调用 heal_step（保留 dryRun、vars 和 auth 设置）。\n\n";
  }
  return wait + "核实页面状态后，对原 trace 重新完整 replay。\n\n";
}
