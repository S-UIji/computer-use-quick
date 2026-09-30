import puppeteer, { type Browser, type Page, type CDPSession } from "puppeteer-core";
import { parseWatchSetting, resolveWatchEnabled } from "../watch/mode.js";
import { removeAllOverlays } from "../watch/overlay.js";
import { DialogGuard } from "./dialogs.js";
import {
  BrowserUnavailableError, connectNotice, defaultProfileDir, describeConnectError, findChrome,
  isLocalBrowserUrl, launchChrome, renderGuidance, type LaunchOptions
} from "./launcher.js";

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

/** 按 CUQ_WATCH 与浏览器 UA 判定观察模式；任何异常都按未启用处理 */
async function detectWatch(browser: Browser): Promise<boolean> {
  const { setting, warning } = parseWatchSetting(process.env.CUQ_WATCH);
  if (warning) console.error(`[computer-use-quick] ${warning}`);
  if (setting !== "auto") return setting === "on";
  try {
    return resolveWatchEnabled(setting, await browser.userAgent());
  } catch (err) {
    console.error(
      `[computer-use-quick] 有头/无头判定失败，观察模式不启用：${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}

export interface SessionOptions {
  /** 观察模式显式开关；省略则每次连接时按 CUQ_WATCH 与浏览器 UA 判定 */
  watch?: boolean;
  /** 连不上时自动拉起本机 Chrome 的选项；省略则不拉起，只返回启动指引 */
  launch?: LaunchOptions;
}

export class BrowserSession {
  private handles = new Map<string, PageHandle>();
  private selected?: string;
  private browserCdp?: CDPSession;
  private browser?: Browser;
  /** 并发调用共享同一次连接 */
  private connecting?: Promise<Browser>;
  private watch = false;
  private everConnected = false;
  private notice?: string;
  /** 本会话自动拉起的 Chrome 进程号（诊断与测试用；服务端退出不关它） */
  launchedPid?: number;

  private constructor(private readonly browserURL: string, private readonly opts: SessionOptions) {}

  /** 不立即连接：第一次需要浏览器时再连，断开后下一次调用自动重连 */
  static lazy(browserURL: string, opts: SessionOptions = {}): BrowserSession {
    return new BrowserSession(browserURL, opts);
  }

  /** lazy + 立即连接一次（连不上抛 BrowserUnavailableError） */
  static async connect(browserURL: string, opts: SessionOptions = {}): Promise<BrowserSession> {
    const session = new BrowserSession(browserURL, opts);
    await session.ensureConnected();
    return session;
  }

  /** 观察模式（页面标注 + 介入检测）是否启用，每次（重）连接时判定 */
  get watchEnabled(): boolean {
    return this.watch;
  }

  /** 取出一次性告知（重连、自动拉起），由工具返回放在最前面 */
  takeNotice(): string | undefined {
    const n = this.notice;
    this.notice = undefined;
    return n;
  }

  private ensureConnected(): Promise<Browser> {
    if (this.browser?.connected) return Promise.resolve(this.browser);
    this.connecting ??= this.establish().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async establish(): Promise<Browser> {
    let browser: Browser;
    let launchedProfile: string | undefined;
    try {
      browser = await puppeteer.connect({ browserURL: this.browserURL, defaultViewport: null });
    } catch (err) {
      const reason = describeConnectError(err);
      const launch = this.opts.launch;
      if (!launch || !isLocalBrowserUrl(this.browserURL)) throw this.unavailable(reason);
      try {
        const r = await launchChrome(this.browserURL, launch);
        this.launchedPid = r.pid;
        browser = await puppeteer.connect({ browserURL: this.browserURL, defaultViewport: null });
        launchedProfile = r.profileDir;
      } catch (launchErr) {
        throw this.unavailable(reason, launchErr instanceof Error ? launchErr.message : String(launchErr));
      }
    }
    this.resetBrowserState();
    this.browser = browser;
    browser.once("disconnected", () => {
      // 旧连接的迟到事件不能清掉新连接的状态
      if (this.browser !== browser) return;
      this.browser = undefined;
      this.resetBrowserState();
    });
    this.watch = this.opts.watch ?? await detectWatch(browser);
    await this.watchTargets(browser);
    this.notice = connectNotice(this.everConnected, launchedProfile);
    this.everConnected = true;
    return browser;
  }

  private resetBrowserState(): void {
    this.handles.clear();
    this.selected = undefined;
    this.browserCdp = undefined;
  }

  private unavailable(reason: string, launchError?: string): BrowserUnavailableError {
    return new BrowserUnavailableError(renderGuidance({
      browserURL: this.browserURL, reason, launchError,
      chromePath: this.opts.launch?.chromePath ?? findChrome(),
      profileDir: this.opts.launch?.profileDir ?? defaultProfileDir()
    }));
  }

  /**
   * 浏览器级会话监听 target 销毁：被外部关闭（用户关标签页、页面崩溃）的页面，
   * 句柄条目与 CDP 会话引用在这里自动清掉。页面级会话收不到别的 target 的事件，
   * 必须在浏览器级会话上开 discover。
   */
  private async watchTargets(browser: Browser): Promise<void> {
    const browserCdp = await browser.target().createCDPSession();
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

  /** 当前登记在册的全部页面句柄（服务端退出时清理标注用） */
  allHandles(): PageHandle[] {
    return [...this.handles.values()];
  }

  async listPages(): Promise<Array<{ pageId: string; title: string; url: string }>> {
    const browser = await this.ensureConnected();
    const out: Array<{ pageId: string; title: string; url: string }> = [];
    // 标题取浏览器级 target 信息，不进页面求值：任何一个标签页开着 JS 弹窗，page.title() 都会挂住
    const infos = (await this.browserCdp?.send("Target.getTargets")) as
      { targetInfos: Array<{ targetId: string; title: string }> } | undefined;
    const titles = new Map(infos?.targetInfos.map((t) => [t.targetId, t.title]) ?? []);
    // 并行回放期间页面分散在多个 BrowserContext 里，要全部列出
    for (const context of browser.browserContexts()) {
      for (const page of await context.pages()) {
        const id = targetIdOf(page);
        out.push({ pageId: id, title: titles.get(id) ?? "", url: page.url() });
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

  /** 装配 handle：CDP session + 弹窗守卫 + 三个 enable。三处建页路径共用。 */
  private async setupHandle(page: Page): Promise<PageHandle> {
    const key = targetIdOf(page);
    const cached = this.handles.get(key);
    if (cached) return cached;
    const cdp = await page.createCDPSession();
    const handle: PageHandle = { pageId: key, page, cdp };
    // 弹窗守卫最先装：页面上若已开着弹窗（如接管用户的标签页），后面的 enable 会被它挂住
    const guard = await DialogGuard.install(handle);
    await guard.settlePending();
    await cdp.send("Accessibility.enable");
    await cdp.send("DOM.enable");
    await cdp.send("Runtime.enable");
    this.handles.set(key, handle);
    return handle;
  }

  async getPage(pageId?: string): Promise<PageHandle> {
    const browser = await this.ensureConnected();
    const id = pageId ?? this.selected;
    const pages = await browser.pages();

    let page: Page | undefined;
    if (id) page = pages.find((p) => targetIdOf(p) === id);
    page ??= pages[0];
    if (!page) throw new Error("浏览器中没有可用页面");

    const handle = await this.setupHandle(page);
    // 两次调用之间弹出的窗会挂住本次调用的一切操作：取页即处理，记录留给工具返回报告
    await DialogGuard.for(handle)?.settlePending();
    this.selected ??= handle.pageId;
    return handle;
  }

  /** 开一个新标签页并建立 handle。不改变当前选中页。 */
  async newPage(): Promise<PageHandle> {
    return this.setupHandle(await (await this.ensureConnected()).newPage());
  }

  /**
   * 开一个隔离页面：独立 BrowserContext + 页面，与日常页面零共享
   * cookie/storage（二期并行的隔离单元；heal 验证门也用它防探索痕迹污染）。
   * release 即销毁整个 Context（连带页面），可重复调用。
   */
  async newIsolatedPage(): Promise<{ handle: PageHandle; release: () => Promise<void> }> {
    const context = await (await this.ensureConnected()).createBrowserContext();
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
    // 断开前撤掉本 session 挂过的观察模式标注（总时长封顶 1s）：连接一断就没人能再清，残留会误导用户
    await removeAllOverlays([...this.handles.values()]);
    for (const h of this.handles.values()) {
      await h.cdp.detach().catch(() => {});
    }
    this.handles.clear();
    await this.browserCdp?.detach().catch(() => {});
    // 从未连上时什么都不做；先置空，断开事件到达时不会再清一遍
    const browser = this.browser;
    this.browser = undefined;
    browser?.disconnect();
  }
}
