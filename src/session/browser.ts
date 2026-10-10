import puppeteer, { type Browser, type Page, type Target, type CDPSession } from "puppeteer-core";
import { parseWatchSetting, resolveWatchEnabled } from "../watch/mode.js";
import { removeAllOverlays } from "../watch/overlay.js";
import { tileWindow, type WindowSlot, type WindowArea } from "./windowLayout.js";
import { isHeadlessShell, headlessFromCommandLine } from "./browserMode.js";
import { DialogGuard } from "./dialogs.js";
import { PageInitialization, detachPageSession, cleanupIsolatedContext, cleanupCreatedPage } from "./pageInitialization.js";
import { PageClosedError, assertPageOpen } from "./pageErrors.js";
import {
  BrowserUnavailableError, connectNotice, defaultProfileDir, describeConnectError, findChrome,
  isLocalBrowserUrl, launchChrome, renderGuidance, type LaunchOptions
} from "./launcher.js";

export interface PageHandle {
  pageId: string;
  page: Page;
  cdp: CDPSession;
  /** 从真实启动参数确认；未知时保持 undefined。 */
  headless?: boolean;
}

/**
 * 取页面的 target id。puppeteer 没有公开这个字段，但它就是 CDP 的 targetId
 * （已实测一致），比 url 稳定得多——同一 url 可以开多个标签页。
 * 拿不到时退回 url，至少不会崩。
 */
function targetIdOfTarget(target: Target): string {
  return (target as unknown as { _targetId?: string })._targetId ?? target.url();
}

function targetIdOf(page: Page): string {
  return targetIdOfTarget(page.target());
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
  /** 浏览器连接与页面初始化预算；整数 100..300000ms，默认 10000ms。 */
  pageTimeoutMs?: number;
}

export class BrowserSession {
  private handles = new Map<string, PageHandle>();
  private selected?: string;
  private closedSelection?: string;
  /** 只串行化取页/恢复，不串行化页面动作或套件运行。 */
  private selecting: Promise<void> = Promise.resolve();
  private browserCdp?: CDPSession;
  private browser?: Browser;
  /** 并发调用共享同一次连接 */
  private connecting?: Promise<Browser>;
  private connectingScope?: PageInitialization;
  private preparing = new Set<PageInitialization>();
  private connectionEpoch = 0;
  private readonly pageTimeoutMs: number;
  private watch = false;
  private tileEnabled = false;
  private headless?: boolean;
  private layoutGroup?: { users: number; area?: Promise<WindowArea> };
  private everConnected = false;
  private notice?: string;
  /** 本会话自动拉起的 Chrome 进程号（诊断与测试用；服务端退出不关它） */
  launchedPid?: number;

  private constructor(private readonly browserURL: string, private readonly opts: SessionOptions) {
    this.pageTimeoutMs = opts.pageTimeoutMs ?? 10000;
    if (!Number.isInteger(this.pageTimeoutMs) || this.pageTimeoutMs < 100 || this.pageTimeoutMs > 300000) {
      throw new Error("pageTimeoutMs 必须是 100..300000 范围内的整数（毫秒）。");
    }
  }

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
    if (this.connecting) return this.connecting;
    if (this.browser?.connected) return Promise.resolve(this.browser);
    const epoch = ++this.connectionEpoch;
    const scope = new PageInitialization(this.pageTimeoutMs);
    scope.bind(() => this.connectionEpoch === epoch);
    this.connectingScope = scope;
    const connecting = scope.run(() => this.establish(scope)).finally(() => {
      if (this.connecting === connecting) this.connecting = undefined;
      if (this.connectingScope === scope) this.connectingScope = undefined;
    });
    this.connecting = connecting;
    return connecting;
  }

  private async establish(scope: PageInitialization): Promise<Browser> {
    let browser: Browser;
    let launchedProfile: string | undefined;
    const connect = () => scope.wait(
      () => puppeteer.connect({ browserURL: this.browserURL, defaultViewport: null }),
      (lateBrowser) => { lateBrowser.disconnect(); }
    );
    try {
      browser = await connect();
    } catch (err) {
      scope.checkpoint();
      const reason = describeConnectError(err);
      const launch = this.opts.launch;
      if (!launch || !isLocalBrowserUrl(this.browserURL)) throw this.unavailable(reason);
      try {
        const r = await scope.wait(() => launchChrome(this.browserURL, launch));
        this.launchedPid = r.pid;
        browser = await connect();
        launchedProfile = r.profileDir;
      } catch (launchErr) {
        scope.checkpoint();
        throw this.unavailable(reason, launchErr instanceof Error ? launchErr.message : String(launchErr));
      }
    }
    const keepBrowser = scope.onCancel(() => { browser.disconnect(); });
    const watch = this.opts.watch ?? await scope.wait(() => detectWatch(browser));
    const browserCdp = await this.watchTargets(browser, scope);
    let headless: boolean | undefined;
    // 实际模式同时用于布局与截图；不能用可覆盖的 UA 判定。
    try {
      const command = await scope.wait(() => browserCdp.send("Browser.getBrowserCommandLine"));
      if (command.arguments.length) headless = isHeadlessShell(command.arguments[0]) ||
        command.arguments.some((arg) => arg === "--headless" || arg.startsWith("--headless="));
    } catch {
      scope.checkpoint();
      try {
        const info = await scope.wait(() => browserCdp.send("SystemInfo.getInfo"));
        headless = headlessFromCommandLine(info.commandLine);
      } catch { scope.checkpoint(); /* 无法确认时不移动有头窗口或标签。 */ }
    }
    scope.checkpoint();
    this.resetBrowserState();
    this.browser = browser;
    this.browserCdp = browserCdp;
    this.watch = watch;
    this.headless = headless;
    browser.once("disconnected", () => {
      if (this.browser !== browser) return;
      this.connectionEpoch++;
      this.browser = undefined;
      for (const pending of this.preparing) pending.cancel();
      this.resetBrowserState();
    });
    this.tileEnabled = this.watch && this.headless === false;
    if (this.watch && this.headless === undefined) console.error("[computer-use-quick] 无法确认有头浏览器，窗口平铺不启用");
    this.notice = connectNotice(this.everConnected, launchedProfile);
    this.everConnected = true;
    keepBrowser();
    return browser;
  }

  private resetBrowserState(): void {
    this.handles.clear();
    this.selected = undefined;
    this.closedSelection = undefined;
    this.browserCdp = undefined;
    this.tileEnabled = false;
    this.headless = undefined;
    this.layoutGroup = undefined;
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
  private async watchTargets(browser: Browser, scope: PageInitialization): Promise<CDPSession> {
    const browserCdp = await scope.wait(() => browser.target().createCDPSession(), (lateCdp) => { void detachPageSession(lateCdp); });
    scope.onCancel(() => { void detachPageSession(browserCdp); });
    await scope.wait(() => browserCdp.send("Target.setDiscoverTargets", { discover: true }));
    browserCdp.on("Target.targetDestroyed", (e: { targetId: string }) => {
      if (this.browser !== browser) return; // 忽略旧连接的迟到销毁事件
      const handle = this.handles.get(e.targetId);
      this.forgetPage(e.targetId);
      handle?.cdp.detach().catch(() => {}); // 页面已死，detach 失败可安全忽略
    });
    return browserCdp;
  }

  private forgetPage(pageId: string): void {
    this.handles.delete(pageId);
    if (this.selected === pageId) {
      this.closedSelection = pageId;
      this.selected = undefined;
    }
  }

  get needsPageRecovery(): boolean {
    return this.closedSelection !== undefined;
  }

  /** 内部句柄表规模（测试可观测性锚点） */
  handleCount(): number {
    return this.handles.size;
  }

  /** 当前登记在册的全部页面句柄（服务端退出时清理标注用） */
  allHandles(): PageHandle[] {
    return [...this.handles.values()];
  }

  listPages(): Promise<Array<{ pageId: string; title: string; url: string }>> {
    // 列表使用独立准备作用域；等待浏览器响应时不占用取页队列。
    return this.prepare(async (scope) => {
      const browser = await this.connectForPage(scope);
      const browserCdp = this.browserCdp!;
      const selectedAtStart = this.selected;
      scope.listing();
      // 只取浏览器级元数据；context.pages() 会装配所有冷页面并被无关 alert 阻塞。
      // 取消或更换连接后，迟到的响应不能进入下面的句柄与恢复状态处理。
      const { targetInfos } = await scope.wait(() => browserCdp.send("Target.getTargets"));
      const pageIds = new Set(browser.targets().filter((target) => target.type() === "page").map(targetIdOfTarget));
      const out = targetInfos.filter((info) => pageIds.has(info.targetId))
        .map((info) => ({ pageId: info.targetId, title: info.title, url: info.url }));
      if (selectedAtStart && this.selected === selectedAtStart && !out.some((p) => p.pageId === selectedAtStart)) {
        this.forgetPage(selectedAtStart);
      }
      return out;
    });
  }

  /** 当前默认页 id；关闭后为空，由 needsPageRecovery 区分首次取页。 */
  currentPageId(): string | undefined {
    return this.selected;
  }

  selectPage(pageId: string): void {
    this.selected = pageId;
    this.closedSelection = undefined;
  }

  /** 装配完成前不登记；调用方在本次准备 scope 完成前统一提交句柄。 */
  private async setupHandle(page: Page, scope: PageInitialization): Promise<PageHandle> {
    scope.checkpoint();
    const key = targetIdOf(page);
    if (page.isClosed()) throw new PageClosedError(key);
    const cached = this.handles.get(key);
    if (cached) return cached;
    let cdp: CDPSession | undefined;
    try {
      cdp = await scope.wait(() => page.createCDPSession(), (lateCdp) => { void detachPageSession(lateCdp); });
      const temporaryCdp = cdp;
      scope.onCancel(() => { void detachPageSession(temporaryCdp); });
      const handle: PageHandle = { pageId: key, page, cdp, headless: this.headless };
      // 弹窗守卫最先装，避免后续 enable 被既有弹窗挂住。
      const guard = await DialogGuard.install(handle);
      scope.checkpoint();
      await guard.settlePending();
      scope.checkpoint();
      await cdp.send("Accessibility.enable");
      scope.checkpoint();
      await cdp.send("DOM.enable");
      scope.checkpoint();
      await cdp.send("Runtime.enable");
      scope.checkpoint();
      assertPageOpen(handle);
      return handle;
    } catch (err) {
      if (cdp) await detachPageSession(cdp);
      if (page.isClosed()) throw new PageClosedError(key);
      throw err;
    }
  }

  private prepare<T>(operation: (scope: PageInitialization) => Promise<T>): Promise<T> {
    const scope = new PageInitialization(this.pageTimeoutMs);
    this.preparing.add(scope);
    return scope.run(() => operation(scope)).finally(() => { this.preparing.delete(scope); });
  }

  private async connectForPage(scope: PageInitialization): Promise<Browser> {
    const connecting = this.ensureConnected();
    const pendingConnection = this.connectingScope;
    const stopWaiting = pendingConnection && scope.onCancel(() => { pendingConnection.cancel(); });
    let browser: Browser;
    try { browser = await scope.wait(() => connecting); }
    finally { stopWaiting?.(); }
    const epoch = this.connectionEpoch;
    scope.bind(() => this.browser === browser && this.connectionEpoch === epoch);
    return browser;
  }

  getPage(pageId?: string): Promise<PageHandle> {
    const result = this.selecting.then(() => this.prepare((scope) => this.resolvePage(pageId, scope)));
    this.selecting = result.then(() => {}, () => {});
    return result;
  }

  private async resolvePage(pageId: string | undefined, scope: PageInitialization): Promise<PageHandle> {
    const browser = await this.connectForPage(scope);
    const id = pageId ?? this.selected;
    const cached = id === undefined ? undefined : this.handles.get(id);
    // targets() 只读取已发现目标；仅对实际需要的那个目标调用 page()。
    // 与 browser.pages() 保持 BrowserContext 遍历顺序，但不装配无关 Page。
    const targets = browser.browserContexts().flatMap((context) => context.targets().filter((target) => target.type() === "page"));
    const target = id === undefined ? undefined : targets.find((candidate) => targetIdOfTarget(candidate) === id);
    let page = cached && !cached.page.isClosed() ? cached.page : undefined;
    // 包括空字符串在内，显式传入的 ID 都不能回退到别的页面。
    if (pageId !== undefined && !page && !target) {
      throw new Error(`pageId「${pageId}」不存在或已关闭，请调用 list_pages 重新选择页面。`);
    }
    if (!page && !target && this.selected) this.forgetPage(this.selected);
    const closedPageId = this.closedSelection;
    const recovering = pageId === undefined && closedPageId !== undefined;
    const chosenTarget = target ?? targets[0];
    let keepRecoveryPage: (() => void) | undefined;
    if (page) scope.target(targetIdOf(page));
    else if (!recovering && chosenTarget) scope.target(targetIdOfTarget(chosenTarget));
    if (!page) {
      if (recovering) {
        scope.creating();
        page = await scope.wait(() => browser.newPage(), (latePage) => { void cleanupCreatedPage(latePage); });
        const ownedPage = page;
        keepRecoveryPage = scope.onCancel(() => { void cleanupCreatedPage(ownedPage); });
      } else if (chosenTarget) page = await scope.wait(() => chosenTarget.page()) ?? undefined;
    }
    if (!page) throw new Error("浏览器中没有可用页面");
    scope.target(targetIdOf(page));

    try {
      const handle = await this.setupHandle(page, scope);
      await DialogGuard.for(handle)?.settlePending();
      scope.checkpoint();
      assertPageOpen(handle);
      this.handles.set(handle.pageId, handle);
      this.selectPage(handle.pageId);
      keepRecoveryPage?.();
      if (recovering) {
        const recovered = `之前操作的标签页已关闭（pageId=${closedPageId}），已新开标签页（pageId=${handle.pageId}）；旧 ref 不再适用，请先 snapshot 确认。`;
        this.notice = [this.notice, recovered].filter(Boolean).join("；");
      }
      return handle;
    } catch (err) {
      scope.checkpoint();
      if (page.isClosed()) {
        this.forgetPage(targetIdOf(page));
        // 首次隐式取页在装配途中关闭，同样不能在下次接管别人的页面。
        if (pageId === undefined) this.closedSelection ??= targetIdOf(page);
        throw new PageClosedError(targetIdOf(page));
      }
      throw err;
    }
  }

  /** 开一个新标签页并建立 handle。不改变当前选中页。 */
  newPage(): Promise<PageHandle> {
    return this.prepare(async (scope) => {
      const browser = await this.connectForPage(scope);
      scope.creating();
      let page: Page | undefined, cleaning: Promise<void> | undefined;
      const cleanup = (): Promise<void> => page ? cleaning ??= cleanupCreatedPage(page) : Promise.resolve();
      try {
        page = await scope.wait(() => browser.newPage(), (latePage) => { page = latePage; void cleanup(); });
        scope.target(targetIdOf(page));
        const keepPage = scope.onCancel(() => { void cleanup(); });
        const handle = await this.setupHandle(page, scope);
        scope.checkpoint();
        this.handles.set(handle.pageId, handle);
        keepPage();
        return handle;
      } catch (error) { await cleanup(); throw error; }
    });
  }

  /** 平铺只触碰新窗口；所有窗口管理异常均不影响执行。 */
  private async placeIsolatedWindow(handle: PageHandle, slot: WindowSlot, existing: Set<number>, group: NonNullable<BrowserSession["layoutGroup"]>, scope: PageInitialization): Promise<void> {
    try {
      const cdp = this.browserCdp!;
      const { windowId } = await scope.wait(() => cdp.send("Browser.getWindowForTarget", { targetId: handle.pageId }));
      if (existing.has(windowId)) throw new Error("隔离页未创建独立窗口，保护已有窗口");
      const area = await scope.wait(() => group.area ??= handle.page.evaluate(() => {
        const available = screen as Screen & { availLeft: number; availTop: number };
        return { left: available.availLeft, top: available.availTop, width: available.availWidth, height: available.availHeight };
      }));
      const bounds = tileWindow(area, slot);
      if (!bounds) throw new Error("槽位无效或屏幕可用区域不足");
      await scope.wait(() => cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } }));
      await scope.wait(() => cdp.send("Browser.setWindowBounds", { windowId, bounds }));
    } catch (err) {
      scope.checkpoint();
      console.error("[computer-use-quick] 窗口平铺未生效：" + (err instanceof Error ? err.message : String(err)));
    }
  }

  /**
   * 开一个隔离页面：独立 BrowserContext + 页面，与日常页面零共享
   * cookie/storage（二期并行的隔离单元；heal 验证门也用它防探索痕迹污染）。
   * release 即销毁整个 Context（连带页面），可重复调用。
   */
  newIsolatedPage(slot?: WindowSlot): Promise<{ handle: PageHandle; release: () => Promise<void> }> {
    return this.prepare(async (scope) => {
      const browser = await this.connectForPage(scope);
      scope.creating(true);
      const group = slot && this.tileEnabled ? (this.layoutGroup ??= { users: 0 }) : undefined;
      if (group) group.users++;
      let leftGroup = false;
      const leaveGroup = (): void => {
        if (leftGroup) return;
        leftGroup = true;
        if (group && --group.users === 0 && this.layoutGroup === group) this.layoutGroup = undefined;
      };
      const keepGroup = scope.onCancel(leaveGroup);
      let context: Awaited<ReturnType<Browser["createBrowserContext"]>> | undefined;
      let handle: PageHandle | undefined, cleaning: Promise<void> | undefined;
      const cleanup = (): Promise<void> => context ? cleaning ??= cleanupIsolatedContext(context, handle?.cdp) : Promise.resolve();
      try {
        let existing: Set<number> | undefined;
        const browserCdp = this.browserCdp;
        if (slot && this.tileEnabled && browserCdp) {
          try {
            const windows = await scope.wait(() => Promise.all(browser.targets().filter((target) => target.type() === "page").map(async (target) =>
              (await browserCdp.send("Browser.getWindowForTarget", { targetId: targetIdOfTarget(target) })).windowId)));
            existing = new Set(windows);
          } catch (err) {
            scope.checkpoint();
            console.error("[computer-use-quick] 无法确认已有窗口，跳过平铺：" + (err instanceof Error ? err.message : String(err)));
          }
        }
        context = await scope.wait(() => browser.createBrowserContext(), (lateContext) => { context = lateContext; void cleanup(); });
        const ownContext = context;
        const keepContext = scope.onCancel(() => { void cleanup(); });
        const page = await scope.wait(() => ownContext.newPage());
        scope.target(targetIdOf(page));
        handle = await this.setupHandle(page, scope);
        if (slot && existing && group) await this.placeIsolatedWindow(handle, slot, existing, group, scope);
        scope.checkpoint();
        const ownedHandle = handle;
        this.handles.set(ownedHandle.pageId, ownedHandle);
        keepContext();
        keepGroup();
        let releasing: Promise<void> | undefined;
        const release = (): Promise<void> => releasing ??= (async () => {
          if (this.handles.get(ownedHandle.pageId) === ownedHandle) this.forgetPage(ownedHandle.pageId);
          try { await cleanup(); }
          finally { leaveGroup(); }
        })();
        return { handle: ownedHandle, release };
      } catch (error) {
        await cleanup();
        leaveGroup();
        throw error;
      }
    });
  }

  /** 关闭指定标签页并清理 handle（幂等，未知 id 直接忽略） */
  async closePage(pageId: string): Promise<void> {
    const handle = this.handles.get(pageId);
    if (!handle) return;
    this.forgetPage(pageId);
    await handle.cdp.detach().catch(() => {});
    await handle.page.close().catch(() => {});
  }

  async close(): Promise<void> {
    this.connectionEpoch++;
    for (const pending of this.preparing) pending.cancel();
    this.connectingScope?.cancel();
    this.connecting = undefined;
    this.connectingScope = undefined;
    // 先隔离旧连接状态；等待清理期间允许重连，旧清理不能碰新连接的句柄表。
    const handles = [...this.handles.values()], browserCdp = this.browserCdp, browser = this.browser;
    this.browser = undefined;
    this.resetBrowserState();
    await removeAllOverlays(handles);
    await Promise.all(handles.map((handle) => detachPageSession(handle.cdp)));
    if (browserCdp) await detachPageSession(browserCdp);
    browser?.disconnect();
  }
}
