import type { Step, StepResult } from "../types.js";

/** 检测到的用户介入摘要。刻意不含按键值：用户可能正在输入密码 */
export interface UserInterruption {
  type: "pointerdown" | "keydown";
  x: number;
  y: number;
}

/** agent 输入登记口：派发前 begin，派发返回后调用它返回的关闭函数 */
export interface InputGate {
  begin(kind: "mouse" | "key" | "wheel", point?: { x: number; y: number }): () => void;
}

export interface RunOutcome {
  ok: boolean;
  /** 失败时停在第几步（0-based，批次序号） */
  failedIndex?: number;
  interrupted: boolean;
}

/**
 * 步骤生命周期钩子。执行层只负责在固定时机调用，标注、进度推送、介入检测都由实现方处理。
 * 契约：所有方法都不得抛错——观察能力是尽力而为，不能让步骤因它失败。
 */
export interface StepObserver {
  onRunStart(total: number): Promise<void>;
  onStepStart(index: number, step: Step, description?: string, details?: string): Promise<void>;
  onStepEnd(result: StepResult): Promise<void>;
  onRunEnd(outcome: RunOutcome): Promise<void>;
  /** 取出自上次调用以来检测到的用户介入（取出即清空） */
  takeInterruption(): UserInterruption | undefined;
  /** 取出自上次调用以来检测到的用户滚动次数（只告警、不中止） */
  takeScrollCount(): number;
  /** 未启用介入检测时为 undefined，sendInput 直接派发 */
  readonly inputGate?: InputGate;
}

export function describeInterruption(u: UserInterruption): string {
  return u.type === "pointerdown" ? `pointerdown @ ${Math.round(u.x)},${Math.round(u.y)}` : "keydown";
}
