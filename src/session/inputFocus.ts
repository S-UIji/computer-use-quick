import type { PageHandle } from "./browser.js";
import { PageClosedError } from "./pageErrors.js";

export interface InputFocusWarning { message: string; retryBlocked?: boolean; }
const pending = new WeakMap<PageHandle, Promise<void>>();
const FALLBACK = "浏览器不支持后台焦点模拟；本步回退前台输入，可能切换用户标签。";
const WHEEL = "真实滚轮需要活跃渲染视图；本步回退到前台滚动，可能切换用户标签。";
const RESTORE = "后台焦点模拟未能恢复；请重新连接浏览器后 snapshot，核实本步副作用，避免直接重试。";

function unsupported(error: unknown): boolean {
  const data = error as { code?: unknown; originalMessage?: unknown };
  if (data?.code === -32601) return true;
  const raw = typeof data?.originalMessage === "string" ? data.originalMessage
    : error instanceof Error ? error.message : String(error);
  const message = raw.replace(/^Protocol error(?: \([^)]*\))?:\s*/i, "");
  return /^(?:method (?:not found|wasn't found|was not found|not supported)|['"]?Emulation\.setFocusEmulationEnabled['"]? (?:wasn't found|was not found|is not supported)|unknown method|unsupported method)\.?$/i.test(message);
}

/** 断连也会报 Target closed；只接受页面事件或仍连接的浏览器对目标缺失的确认。 */
async function confirmedPageClosed(handle: PageHandle, error: unknown): Promise<boolean> {
  if (handle.page.isClosed()) return true;
  const message = error instanceof Error ? error.message : String(error);
  if (!/Target closed|No target with given id|Session closed/i.test(message)) return false;
  const browser = handle.page.browser();
  const targetId = (handle.page.target() as unknown as { _targetId?: string })._targetId;
  if (!browser.connected || !targetId) return false;
  let probe;
  try {
    probe = await browser.target().createCDPSession();
    await probe.send("Target.getTargetInfo", { targetId });
    return handle.page.isClosed();
  } catch (probeError) {
    if (handle.page.isClosed()) return true;
    const data = probeError as { originalMessage?: string };
    return browser.connected && /^No target with given id(?: found)?\.?$/i.test(data?.originalMessage ?? "");
  } finally {
    await probe?.detach().catch(() => {});
  }
}

async function perform(handle: PageHandle, action: () => Promise<void>, warn: (warning: InputFocusWarning) => void, foregroundWheel: boolean): Promise<void> {
  if (foregroundWheel) {
    warn({ message: WHEEL });
    await handle.cdp.send("Page.bringToFront");
    await action();
    return;
  }
  let attempted = false, failed = false;
  try {
    attempted = true;
    try { await handle.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }); }
    catch (error) {
      if (!unsupported(error)) throw error;
      attempted = false;
      warn({ message: FALLBACK });
      await handle.cdp.send("Page.bringToFront");
    }
    await action();
  } catch (error) { failed = true; throw error; }
  finally {
    // 开启响应失败不代表浏览器未应用；未知结果也必须尝试恢复。
    if (attempted && !handle.page.isClosed()) {
      try { await handle.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false }); }
      catch (error) {
        if (await confirmedPageClosed(handle, error)) throw new PageClosedError(handle.pageId);
        warn({ message: RESTORE, retryBlocked: true });
        if (!failed) throw new Error("本步可能已完成，但后台焦点模拟恢复失败；请重连后 snapshot 核实副作用，不要直接重试。");
      }
    }
  }
}

/** 同页动作串行、异页并行；同页并发批次的观察生命周期不在此队列内。 */
export async function withInputFocus(
  handle: PageHandle, action: () => Promise<void>, onWarning?: (warning: InputFocusWarning) => void,
  foregroundWheel = false
): Promise<void> {
  const warn = (warning: InputFocusWarning): void => {
    try {
      if (onWarning) onWarning(warning);
      else console.error("[computer-use-quick] " + warning.message);
    } catch { /* 诊断不能阻断输入或收尾。 */ }
  };
  const previous = pending.get(handle) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => perform(handle, action, warn, foregroundWheel));
  pending.set(handle, current);
  try { await current; }
  finally { if (pending.get(handle) === current) pending.delete(handle); }
}
