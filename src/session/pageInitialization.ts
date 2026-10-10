import type { BrowserContext, CDPSession, Page } from "puppeteer-core";

/** 目标准备超时不适合自动重试或修复动作；尚未开始的步骤不得记录成已执行。 */
export class PageInitializationDeadlineError extends Error {
  readonly retryBlocked = true;
  readonly code = "page-initialization-deadline" as const;

  constructor(readonly timeoutMs: number, subject: string) {
    super(`${subject}初始化在 ${timeoutMs}ms 内未完成；目标可能有接管前的弹窗，请先关闭该页弹窗后重试。`);
    this.name = "PageInitializationDeadlineError";
  }
}

/** 一次页面装配的截止时间与取消门；每次 await 之后、下一次副作用之前检查。 */
export class PageInitialization {
  private active = true;
  private reason?: Error;
  private valid: () => boolean = () => true;
  private subject = "浏览器连接";
  private reject?: (error: Error) => void;
  private cleanups = new Set<() => void>();

  constructor(private readonly timeoutMs: number) {}

  bind(valid: () => boolean): void {
    this.valid = valid;
    this.checkpoint();
  }

  target(pageId: string): void { this.subject = `页面（pageId=${pageId}）`; }
  creating(isolated = false): void { this.subject = isolated ? "隔离页面" : "新建页面"; }
  listing(): void { this.subject = "页面列表"; }

  checkpoint(): void {
    if (this.active && !this.valid()) this.cancel(new Error("浏览器连接已取消或已更换，页面初始化已停止，请重试。"));
    if (!this.active) throw this.reason ?? new Error("页面初始化已取消，请重试。");
  }

  onCancel(cleanup: () => void): () => void {
    this.checkpoint();
    this.cleanups.add(cleanup);
    return () => { this.cleanups.delete(cleanup); };
  }

  /** 资源在取消后才返回时，释放资源并拒绝进入下一阶段。 */
  async wait<T>(operation: () => Promise<T>, cleanup?: (value: T) => void): Promise<T> {
    this.checkpoint();
    const value = await operation();
    try { this.checkpoint(); }
    catch (error) { cleanup?.(value); throw error; }
    return value;
  }

  cancel(reason = new Error("浏览器连接已取消，页面初始化已停止，请重试。")): void {
    if (!this.active) return;
    this.active = false;
    this.reason = reason;
    for (const cleanup of this.cleanups) {
      try { cleanup(); } catch { /* 单个临时资源失败不能阻止取消其它资源。 */ }
    }
    this.cleanups.clear();
    this.reject?.(reason);
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      this.reject = reject;
      timer = setTimeout(() => this.cancel(new PageInitializationDeadlineError(this.timeoutMs, this.subject)), this.timeoutMs);
    });
    try { return await Promise.race([operation(), cancelled]); }
    catch (error) {
      this.cancel(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      this.active = false;
      this.cleanups.clear();
      this.reject = undefined;
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/** 清理临时 session 不占用已到期的页面选择队列。 */
export async function detachPageSession(cdp: CDPSession): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const completed = Promise.resolve().then(() => cdp.detach()).then(() => true, () => true);
    const done = await Promise.race([
      completed,
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 200); })
    ]);
    if (!done) console.error("[computer-use-quick] 临时页面 session 清理在 200ms 内未完成，未确认释放；后台继续 detach。");
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** 自建隔离 context 与其 session 共享一个清理预算；无界 detach 不能阻止 context.close。 */
export async function cleanupIsolatedContext(context: BrowserContext, cdp?: CDPSession): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closing = Promise.resolve().then(() => context.close()).catch((error) => {
    console.error(`[computer-use-quick] 自建隔离 context 关闭失败，未确认资源已释放：${error instanceof Error ? error.message : String(error)}`);
  });
  const detaching = Promise.resolve().then(() => cdp?.detach()).catch(() => {});
  const completed = Promise.all([closing, detaching]).then(() => true);
  try {
    const done = await Promise.race([
      completed,
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 2000); })
    ]);
    if (!done) console.error("[computer-use-quick] 隔离资源清理在 2000ms 内未完成，未确认全部释放；后台继续关闭自建 context。");
  } finally { if (timer !== undefined) clearTimeout(timer); }
}


/** 默认 context 属于用户；新页创建取消后只能清理本次创建的页。 */
export async function cleanupCreatedPage(page: Page): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const completed = page.close().then(() => true, (error) => {
    if (!page.isClosed()) console.error(`[computer-use-quick] 自建页面关闭失败，未确认资源已释放：${error instanceof Error ? error.message : String(error)}`);
    return true;
  });
  try {
    const done = await Promise.race([
      completed,
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 2000); })
    ]);
    if (!done) console.error("[computer-use-quick] 自建页面清理在 2000ms 内未完成，未确认释放；后台继续关闭本次创建的页面。");
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
