import type { PageHandle } from "../session/browser.js";

export interface StabilityOptions {
  domQuietMs?: number;
  networkQuietMs?: number;
  timeoutMs?: number;
}

export class NetworkTracker {
  /** 每个页面只挂一次监听，否则同一请求会被重复计数 */
  private static instances = new WeakMap<PageHandle, NetworkTracker>();

  /**
   * 只有这些类型的请求才算「在途信号」。埋点/信标/图片类请求（Ping/Image/Beacon 等）
   * 在真实站点上常年不断，把它们计入会让隐式等待永远等不到静默、每步都白付满超时。
   * Script/Stylesheet 必须计入：SPA 路由切换靠动态 import 拉 JS chunk，
   * 漏掉它会在路由组件还没加载完时就断言 url，造成偶发失败（实测）。
   */
  private static readonly COUNTED_TYPES = new Set(["Document", "XHR", "Fetch", "Script", "Stylesheet"]);

  private pending = new Map<string, number>(); // requestId → 发起时间
  private changedAt = Date.now();

  /**
   * 在途条目的兜底存活期。两类场景靠它兜底：
   * 1. 被导航掐掉的请求 Chrome 不一定回 loadingFailed（实测：vite dev 的大体积
   *    module script 会残留成僵尸条目，永不结束）；
   * 2. 长轮询 XHR（30s+ 挂在 pending 里）本就不该阻塞稳定性判定。
   */
  private static readonly STALE_MS = 10_000;

  private constructor() {}

  static async attach(handle: PageHandle): Promise<NetworkTracker> {
    const existing = NetworkTracker.instances.get(handle);
    if (existing) return existing;

    const t = new NetworkTracker();
    NetworkTracker.instances.set(handle, t);

    await handle.cdp.send("Network.enable");
    await handle.cdp.send("Page.enable").catch(() => {});
    handle.cdp.on("Network.requestWillBeSent", (e: { requestId: string; type?: string }) => {
      // type 缺失时保守计入（老版本 CDP 或特殊请求），有类型时只认白名单
      if (e.type !== undefined && !NetworkTracker.COUNTED_TYPES.has(e.type)) return;
      t.pending.set(e.requestId, Date.now());
      t.changedAt = Date.now();
    });
    const done = (e: { requestId: string }): void => {
      // 未计入白名单的请求（信标/图片等）从头到尾不触碰静默计时
      if (!t.pending.delete(e.requestId)) return;
      t.changedAt = Date.now();
    };
    handle.cdp.on("Network.loadingFinished", done);
    handle.cdp.on("Network.loadingFailed", done);
    // 主 frame 导航 = 上一文档的在途请求全部作废，是僵尸条目最及时的清场时机
    handle.cdp.on("Page.frameNavigated", (e: { frame: { parentId?: string } }) => {
      if (!e.frame.parentId && t.pending.size > 0) t.pending.clear();
    });
    return t;
  }

  inFlight(): number {
    const now = Date.now();
    for (const [id, startedAt] of this.pending) {
      if (now - startedAt > NetworkTracker.STALE_MS) this.pending.delete(id);
    }
    return this.pending.size;
  }
  lastChangeAt(): number { return this.changedAt; }
}

/** 幂等地装上 MutationObserver（页面导航后 window 会重置，所以每次都要跑一遍） */
const OBSERVER_SCRIPT = `(function () {
  if (window.__cuqObserver) return;
  window.__cuqLastMutation = Date.now();
  window.__cuqObserver = new MutationObserver(function () {
    window.__cuqLastMutation = Date.now();
  });
  window.__cuqObserver.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, characterData: true
  });
})()`;

async function lastMutationAt(handle: PageHandle): Promise<number> {
  // 逗号表达式：先（幂等地）装上 observer，再读出最后一次变更时间
  const { result } = (await handle.cdp.send("Runtime.evaluate", {
    expression: `(${OBSERVER_SCRIPT}, window.__cuqLastMutation || 0)`,
    returnByValue: true
  })) as { result: { value: number } };
  return result.value;
}

/**
 * 隐式稳定性等待（spec §7.2）。DOM 静默 ≥ domQuietMs 且 无 in-flight 请求
 * ≥ networkQuietMs 即返回；超过 timeoutMs 无条件返回——超时只意味着页面仍在动，
 * 动作照样该执行，不该在这里抛错。
 *
 * 返回 true 表示是「打满上限」退出的：调用方应把它显形成告警，
 * 否则持续流量页面上的每一步都在静默地白付整个 timeout。
 */
export async function waitStable(
  handle: PageHandle,
  tracker: NetworkTracker,
  opts: StabilityOptions = {}
): Promise<boolean> {
  const domQuiet = opts.domQuietMs ?? 150;
  const netQuiet = opts.networkQuietMs ?? 500;
  const timeout = opts.timeoutMs ?? 5000;
  const deadline = Date.now() + timeout;

  for (;;) {
    const now = Date.now();
    if (now >= deadline) return true;

    const domOk = now - (await lastMutationAt(handle)) >= domQuiet;
    const netOk = tracker.inFlight() === 0 && now - tracker.lastChangeAt() >= netQuiet;
    if (domOk && netOk) return false;

    await new Promise((r) => setTimeout(r, 50));
  }
}
