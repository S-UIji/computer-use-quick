import type { InputGate, RunOutcome, StepObserver, UserInterruption } from "../../src/executor/observer.js";
import type { Step, StepResult } from "../../src/types.js";

export interface FakeObserverOptions {
  /** 第 n 次结算（0-based，每步一次）时交出一次用户介入 */
  interruptAt?: number;
  /** 第 n 次结算时报告 2 次用户滚动 */
  scrollAt?: number;
  inputGate?: InputGate;
}

/** 可编排的假观察者：记录调用序列，按预设在指定结算点交出「用户介入」 */
export class FakeObserver implements StepObserver {
  readonly events: string[] = [];
  readonly inputGate?: InputGate;
  private takes = 0;
  private scrollTakes = 0;

  constructor(private readonly o: FakeObserverOptions = {}) {
    this.inputGate = o.inputGate;
  }

  async onRunStart(total: number): Promise<void> {
    this.events.push(`start:${total}`);
  }

  async onStepStart(index: number, step: Step): Promise<void> {
    this.events.push(`step:${index}:${step.action}`);
  }

  async onStepEnd(r: StepResult): Promise<void> {
    this.events.push(`end:${r.index}:${r.ok ? "ok" : "fail"}`);
  }

  async onRunEnd(o: RunOutcome): Promise<void> {
    this.events.push(`done:${o.ok}:${o.failedIndex ?? "-"}:${o.interrupted}`);
  }

  takeInterruption(): UserInterruption | undefined {
    return this.takes++ === this.o.interruptAt ? { type: "pointerdown", x: 12.4, y: 30.6 } : undefined;
  }

  takeScrollCount(): number {
    return this.scrollTakes++ === this.o.scrollAt ? 2 : 0;
  }
}

/** 记录 sendInput 登记情况的输入门 */
export class RecordingGate implements InputGate {
  readonly begins: Array<{ kind: string; point?: { x: number; y: number } }> = [];
  closed = 0;

  begin(kind: "mouse" | "key" | "wheel", point?: { x: number; y: number }): () => void {
    this.begins.push({ kind, point });
    return () => { this.closed++; };
  }
}
