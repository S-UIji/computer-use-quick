import type { PageHandle } from "../session/browser.js";
import type { Step, StepResult } from "../types.js";
import type { InputGate, RunOutcome, StepObserver, UserInterruption } from "../executor/observer.js";
import { showOverlay } from "./overlay.js";
import { InterventionMonitor } from "./intervention.js";
import type { ProgressReporter } from "./progress.js";

export interface RunWatchOptions {
  handle: PageHandle;
  /** 角标上的标签：探索 / 用例名 / 自愈演示 · 第 k 步 / 自愈验证 */
  label: string;
  /** 是否启用页面标注与介入检测（通常取 session.watchEnabled） */
  watch: boolean;
  /** 步骤级进度；省略则不推送（suite 的隔离页由 server 另推用例级进度） */
  progress?: ProgressReporter;
  /** 进度说明前缀，如 "smoke-login · " */
  progressPrefix?: string;
  /** 进度基数：heal 验证阶段接在演示步之后 */
  progressOffset?: number;
  /** 进度总数覆盖：heal 两阶段合计 */
  progressTotal?: number;
}

/** 把页面标注、介入检测、进度推送组装成执行层的 StepObserver。所有方法都不抛错 */
export class RunWatch implements StepObserver {
  readonly inputGate?: InputGate;
  /** 介入检测没能启用时的原因，由 server 附在工具结果里 */
  setupWarning?: string;
  private total = 0;
  private readonly monitor?: InterventionMonitor;

  constructor(private readonly opts: RunWatchOptions) {
    if (!opts.watch) return;
    const m = InterventionMonitor.for(opts.handle);
    this.monitor = m;
    this.inputGate = {
      begin: (kind, point) => {
        const w = m.beginAgentInput(kind, point);
        return () => m.endAgentInput(w);
      }
    };
  }

  async onRunStart(total: number): Promise<void> {
    this.total = total;
    if (!this.monitor) return;
    await this.monitor.arm();
    if (this.monitor.installError) this.setupWarning = `介入检测未能启用：${this.monitor.installError}`;
  }

  async onStepStart(index: number, step: Step): Promise<void> {
    if (!this.monitor) return;
    await showOverlay(this.opts.handle, {
      kind: "active", label: this.opts.label, step: index + 1, total: this.total, action: step.action
    });
  }

  async onStepEnd(result: StepResult): Promise<void> {
    const { progress, progressPrefix = "", progressOffset = 0, progressTotal } = this.opts;
    progress?.report(
      progressOffset + result.index + 1,
      progressTotal ?? this.total,
      `${progressPrefix}第 ${result.index + 1}/${this.total} 步 ${result.action} ${result.ok ? "✓" : "✗"}`
    );
  }

  async onRunEnd(outcome: RunOutcome): Promise<void> {
    if (!this.monitor) return;
    await this.monitor.disarm();
    await showOverlay(
      this.opts.handle,
      outcome.interrupted && outcome.failedIndex !== undefined
        ? { kind: "interrupted", stopStep: outcome.failedIndex + 1 }
        : { kind: "idle" }
    );
  }

  takeInterruption(): UserInterruption | undefined {
    return this.monitor?.takeUserInput();
  }

  takeScrollCount(): number {
    return this.monitor?.takeScrollCount() ?? 0;
  }
}
