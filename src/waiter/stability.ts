import type { PageHandle } from "../session/browser.js";

export interface StabilityOptions {
  domQuietMs?: number;
  networkQuietMs?: number;
  timeoutMs?: number;
}

export class NetworkTracker {
  /** 每个页面只挂一次监听，否则同一请求会被重复计数 */
  private static instances = new WeakMap<PageHandle, NetworkTracker>();

  private pending = new Set<string>();
  private changedAt = Date.now();

  private constructor() {}

  static async attach(handle: PageHandle): Promise<NetworkTracker> {
    const existing = NetworkTracker.instances.get(handle);
    if (existing) return existing;

    const t = new NetworkTracker();
    NetworkTracker.instances.set(handle, t);

    await handle.cdp.send("Network.enable");
    handle.cdp.on("Network.requestWillBeSent", (e: { requestId: string }) => {
      t.pending.add(e.requestId);
      t.changedAt = Date.now();
    });
    const done = (e: { requestId: string }): void => {
      t.pending.delete(e.requestId);
      t.changedAt = Date.now();
    };
    handle.cdp.on("Network.loadingFinished", done);
    handle.cdp.on("Network.loadingFailed", done);
    return t;
  }

  inFlight(): number { return this.pending.size; }
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
 */
export async function waitStable(
  handle: PageHandle,
  tracker: NetworkTracker,
  opts: StabilityOptions = {}
): Promise<void> {
  const domQuiet = opts.domQuietMs ?? 150;
  const netQuiet = opts.networkQuietMs ?? 500;
  const timeout = opts.timeoutMs ?? 5000;
  const deadline = Date.now() + timeout;

  for (;;) {
    const now = Date.now();
    if (now >= deadline) return;

    const domOk = now - (await lastMutationAt(handle)) >= domQuiet;
    const netOk = tracker.inFlight() === 0 && now - tracker.lastChangeAt() >= netQuiet;
    if (domOk && netOk) return;

    await new Promise((r) => setTimeout(r, 50));
  }
}
