export interface ProgressNotification {
  method: "notifications/progress";
  params: { progressToken: string | number; progress: number; total?: number; message?: string };
}

/** 工具处理函数 extra 的最小子集（结构兼容 MCP SDK 的 RequestHandlerExtra） */
export interface ProgressExtra {
  _meta?: { progressToken?: string | number };
  sendNotification: (n: ProgressNotification) => Promise<void>;
}

/**
 * MCP 进度推送：客户端在 tools/call 的 _meta 里带 progressToken 才推送，否则为空操作。
 * 推送失败静默吞掉——进度只是体验增强，不能让工具因此报错。progress 保证单调不减。
 */
export class ProgressReporter {
  private last = 0;

  private constructor(
    private readonly extra: ProgressExtra | undefined,
    private readonly token: string | number | undefined
  ) {}

  static from(extra: ProgressExtra | undefined): ProgressReporter {
    return new ProgressReporter(extra, extra?._meta?.progressToken);
  }

  get enabled(): boolean {
    return this.token !== undefined;
  }

  report(progress: number, total: number | undefined, message: string): void {
    if (this.token === undefined || !this.extra) return;
    this.last = Math.max(this.last, progress);
    try {
      this.extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken: this.token, progress: this.last, ...(total !== undefined ? { total } : {}), message }
      }).catch(() => { /* 尽力而为 */ });
    } catch { /* 同步抛错同样吞掉 */ }
  }
}
