import type { TraceEvent, TraceProgressInfo } from "../trace/suite.js";
import { renderTraceEvent } from "../report/suiteReport.js";
import type { ProgressReporter } from "./progress.js";

const INTERVAL_MS = 250;
type ActiveTrace = TraceProgressInfo & { completedSteps: number };

/** 数字按用例计数，文字汇总各用例的真实步数；定时器只在当前工具调用内存活。 */
export class SuiteProgress {
  private readonly active = new Map<number, ActiveTrace>();
  private readonly finished = new Set<string>();
  private doneCount = 0;
  private lastSent = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(private readonly progress: ProgressReporter, private readonly total: number) {}

  start(): void {
    if (this.disposed) return;
    this.report("套件开始：共 " + this.total + " 条用例，正在准备回放。");
  }

  accept(event: TraceEvent): void {
    if (this.disposed || !this.progress.enabled) return;
    if (event.kind === "started") {
      this.active.set(event.traceIndex, { ...event, completedSteps: 0 });
      this.schedule();
      return;
    }
    if (event.kind === "step") {
      this.active.set(event.traceIndex, { ...event });
      this.schedule();
      return;
    }
    if (event.kind === "done") {
      const identity = event.traceIndex === undefined ? "path:" + event.result.path : "index:" + event.traceIndex;
      if (this.finished.has(identity)) return;
      this.finished.add(identity);
      this.doneCount = Math.min(this.total, this.doneCount + 1);
      if (event.traceIndex !== undefined) this.active.delete(event.traceIndex);
    }
    this.clearTimer();
    this.report(renderTraceEvent(event));
    // 即时终态不能吞掉其他用例最近的步骤变化。
    if (this.active.size) this.schedule();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.active.clear();
  }

  private schedule(): void {
    if (this.timer || this.disposed || !this.progress.enabled) return;
    const delay = Math.max(0, INTERVAL_MS - (Date.now() - this.lastSent));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.disposed || !this.active.size) return;
      const parts = [...this.active.values()].sort((a, b) => a.traceIndex - b.traceIndex).map(trace =>
        "#" + (trace.traceIndex + 1) + " " + trace.name + " 已完成 " + trace.completedSteps + "/" +
        trace.totalSteps + " 步" + (trace.attempt === 2 ? "（重试）" : ""));
      this.report("进行中：" + parts.join("、"));
    }, delay);
  }

  private report(message: string): void {
    this.lastSent = Date.now();
    this.progress.report(this.doneCount, this.total, message);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
