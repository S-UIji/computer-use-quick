import puppeteer, { type Browser, type Page, type CDPSession } from "puppeteer-core";

export interface PageHandle {
  pageId: string;
  page: Page;
  cdp: CDPSession;
}

/**
 * 取页面的 target id。puppeteer 没有公开这个字段，但它就是 CDP 的 targetId
 * （已实测一致），比 url 稳定得多——同一 url 可以开多个标签页。
 * 拿不到时退回 url，至少不会崩。
 */
function targetIdOf(page: Page): string {
  const t = page.target() as unknown as { _targetId?: string };
  return t._targetId ?? page.url();
}

export class BrowserSession {
  private handles = new Map<string, PageHandle>();
  private selected?: string;
  private browserCdp?: CDPSession;

  private constructor(private browser: Browser) {}

  static async connect(browserURL: string): Promise<BrowserSession> {
    const browser = await puppeteer.connect({ browserURL, defaultViewport: null });
    const session = new BrowserSession(browser);
    await session.watchTargets();
    return session;
  }

  /**
   * 浏览器级会话监听 target 销毁：被外部关闭（用户关标签页、页面崩溃）的页面，
   * 句柄条目与 CDP 会话引用在这里自动清掉。页面级会话收不到别的 target 的事件，
   * 必须在浏览器级会话上开 discover。
   */
  private async watchTargets(): Promise<void> {
    const browserCdp = await this.browser.target().createCDPSession();
    this.browserCdp = browserCdp;
    await browserCdp.send("Target.setDiscoverTargets", { discover: true });
    browserCdp.on("Target.targetDestroyed", (e: { targetId: string }) => {
      const handle = this.handles.get(e.targetId);
      if (!handle) return; // 未入表的 target（用户自己的标签页等）安全跳过
      this.handles.delete(e.targetId);
      if (this.selected === e.targetId) this.selected = undefined;
      handle.cdp.detach().catch(() => {}); // 页面已死，detach 失败可安全忽略
    });
  }

  /** 内部句柄表规模（测试可观测性锚点） */
  handleCount(): number {
    return this.handles.size;
  }

  async listPages(): Promise<Array<{ pageId: string; title: string; url: string }>> {
    const out: Array<{ pageId: string; title: string; url: string }> = [];
    // 并行回放期间页面分散在多个 BrowserContext 里，要全部列出
    for (const context of this.browser.browserContexts()) {
      for (const page of await context.pages()) {
        out.push({ pageId: targetIdOf(page), title: await page.title(), url: page.url() });
      }
    }
    return out;
  }

  /** 当前默认作用的页面 id。未显式选页时 getPage() 用的就是它（再兜底到第一个标签页） */
  currentPageId(): string | undefined {
    return this.selected;
  }

  selectPage(pageId: string): void {
    this.selected = pageId;
  }

  /** 装配 handle：CDP session + 三个 enable。三处建页路径共用。 */
  private async setupHandle(page: Page): Promise<PageHandle> {
    const key = targetIdOf(page);
    const cached = this.handles.get(key);
    if (cached) return cached;
    const cdp = await page.createCDPSession();
    await cdp.send("Accessibility.enable");
    await cdp.send("DOM.enable");
    await cdp.send("Runtime.enable");
    const handle: PageHandle = { pageId: key, page, cdp };
    this.handles.set(key, handle);
    return handle;
  }

  async getPage(pageId?: string): Promise<PageHandle> {
    const id = pageId ?? this.selected;
    const pages = await this.browser.pages();

    let page: Page | undefined;
    if (id) page = pages.find((p) => targetIdOf(p) === id);
    page ??= pages[0];
    if (!page) throw new Error("浏览器中没有可用页面");

    const handle = await this.setupHandle(page);
    this.selected ??= handle.pageId;
    return handle;
  }

  /** 开一个新标签页并建立 handle。不改变当前选中页。 */
  async newPage(): Promise<PageHandle> {
    return this.setupHandle(await this.browser.newPage());
  }

  /**
   * 开一个隔离页面：独立 BrowserContext + 页面，与日常页面零共享
   * cookie/storage（二期并行的隔离单元；heal 验证门也用它防探索痕迹污染）。
   * release 即销毁整个 Context（连带页面），可重复调用。
   */
  async newIsolatedPage(): Promise<{ handle: PageHandle; release: () => Promise<void> }> {
    const context = await this.browser.createBrowserContext();
    const handle = await this.setupHandle(await context.newPage());
    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      this.handles.delete(handle.pageId);
      if (this.selected === handle.pageId) this.selected = undefined;
      await handle.cdp.detach().catch(() => {});
      await context.close().catch(() => {});
    };
    return { handle, release };
  }

  /** 关闭指定标签页并清理 handle（幂等，未知 id 直接忽略） */
  async closePage(pageId: string): Promise<void> {
    const handle = this.handles.get(pageId);
    if (!handle) return;
    this.handles.delete(pageId);
    if (this.selected === pageId) this.selected = undefined;
    await handle.cdp.detach().catch(() => {});
    await handle.page.close().catch(() => {});
  }

  async close(): Promise<void> {
    for (const h of this.handles.values()) {
      await h.cdp.detach().catch(() => {});
    }
    this.handles.clear();
    await this.browserCdp?.detach().catch(() => {});
    this.browser.disconnect();
  }
}
