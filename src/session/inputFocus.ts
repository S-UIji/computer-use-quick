import type { CDPSession } from "puppeteer-core";
import type { PageHandle } from "./browser.js";
import { PageClosedError } from "./pageErrors.js";
import { assertExecutionReady, createExecutionContext, ExecutionDeadlineError, executionCheckpoint, executionExpired, executionRace, executionRemainingMs, executionSignal, guardExecutionSession, markExecutionPageClosed, markInputRecoveryUnknown, registerExecutionCleanup, withExecutionCleanup, withExecutionProbe } from "../executor/deadline.js";

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

/** Only a session created for this diagnostic is detached; late cleanup never extends the tool reply. */
async function detachTemporaryProbe(probe: CDPSession, late: boolean): Promise<void> {
  const remaining = late ? 200 : Math.min(200, executionRemainingMs() ?? 200);
  if (!late && remaining <= 0) { void detachTemporaryProbe(probe, true); return; }
  const context = createExecutionContext(remaining);
  const parent = late ? undefined : executionSignal();
  const abort = (): void => context.cancel(parent?.reason instanceof Error ? parent.reason : new ExecutionDeadlineError(remaining));
  parent?.addEventListener("abort", abort, { once: true });
  let started = false;
  try {
    if (!late) executionCheckpoint();
    started = true;
    await context.race(probe.detach());
  } catch (error) {
    if (!started && !late) { void detachTemporaryProbe(probe, true); return; }
    if (error instanceof ExecutionDeadlineError) {
      try { console.error("[computer-use-quick] 临时探针会话清理未确认；已发出的 detach 仍可能完成。"); } catch { /* 诊断不延长收尾。 */ }
    }
  } finally { parent?.removeEventListener("abort", abort); context.dispose(); }
}

/** 断连也会报 Target closed；只接受页面事件或仍连接的浏览器对目标缺失的确认。 */
async function confirmedPageClosed(handle: PageHandle, error: unknown): Promise<boolean> {
  if (handle.page.isClosed()) return true;
  const message = error instanceof Error ? error.message : String(error);
  if (!/Target closed|No target with given id|Session closed/i.test(message)) return false;
  const browser = handle.page.browser();
  const targetId = (handle.page.target() as unknown as { _targetId?: string })._targetId;
  if (!browser.connected || !targetId) return false;
  return withExecutionProbe(handle, async () => {
    let created: CDPSession | undefined;
    let accepting = true, detachStarted = false;
    const dispose = (probe: CDPSession): Promise<void> => {
      if (detachStarted) return Promise.resolve();
      detachStarted = true;
      if (executionExpired()) { void detachTemporaryProbe(probe, true); return Promise.resolve(); }
      return detachTemporaryProbe(probe, false);
    };
    try {
      executionCheckpoint();
      const creation = browser.target().createCDPSession();
      void creation.then(probe => {
        created = probe;
        if (!accepting) void dispose(probe);
      }, () => {});
      const probe = await executionRace(creation);
      executionCheckpoint();
      guardExecutionSession(handle, probe as any);
      await executionRace(probe.send("Target.getTargetInfo", { targetId }));
      executionCheckpoint();
      return handle.page.isClosed();
    } catch (probeError) {
      if (handle.page.isClosed()) return true;
      const data = probeError as { originalMessage?: string };
      const confirmed = browser.connected && /^No target with given id(?: found)?\.?$/i.test(data?.originalMessage ?? "");
      if (confirmed) markExecutionPageClosed(handle);
      return confirmed;
    } finally {
      accepting = false;
      if (created) await dispose(created);
    }
  });
}

async function perform(handle: PageHandle, action: () => Promise<void>, warn: (warning: InputFocusWarning) => void, foregroundWheel: boolean): Promise<void> {
  executionCheckpoint();
  assertExecutionReady(handle);
  if (foregroundWheel) {
    warn({ message: WHEEL });
    await handle.cdp.send("Page.bringToFront");
    await action();
    return;
  }
  let attempted = false, failed = false;
  let restoration: Promise<void> | undefined;
  let cleanupRestoration: Promise<void> | undefined;
  let closureProbe: Promise<boolean> | undefined;
  const restore = (): Promise<void> => {
    if (!attempted || handle.page.isClosed()) return Promise.resolve();
    const expired = executionExpired();
    if (expired && cleanupRestoration) return cleanupRestoration;
    if (!expired && restoration) return restoration;
    const work = withExecutionCleanup(handle, async () => {
      try { await handle.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false }); }
      catch (error) {
        if (handle.page.isClosed()) throw new PageClosedError(handle.pageId);
        // Record uncertainty before a probe can suspend; a failed acknowledgement is not a safe restore.
        markInputRecoveryUnknown(handle);
        warn({ message: RESTORE, retryBlocked: true });
        if (!closureProbe && !executionExpired()) closureProbe = confirmedPageClosed(handle, error);
        if (closureProbe && await closureProbe) throw new PageClosedError(handle.pageId);
        if (!failed) throw new Error("本步可能已完成，但后台焦点模拟恢复失败；请重连后 snapshot 核实副作用，不要直接重试。");
      }
    });
    if (expired) cleanupRestoration = work;
    else restoration = work;
    return work;
  };
  const unregister = registerExecutionCleanup(restore);
  try {
    attempted = true;
    try { await handle.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }); }
    catch (error) {
      if (!unsupported(error)) throw error;
      attempted = false;
      warn({ message: FALLBACK });
      await handle.cdp.send("Page.bringToFront");
    }
    executionCheckpoint();
    await action();
  } catch (error) { failed = true; throw error; }
  finally {
    try { await restore(); }
    finally { unregister(); }
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
  const current = previous.catch(() => {}).then(() => { executionCheckpoint(); return perform(handle, action, warn, foregroundWheel); });
  pending.set(handle, current);
  const release = (): void => { if (pending.get(handle) === current) pending.delete(handle); };
  // Cancelling a waiter must not drop the queue tail while its predecessor still owns input.
  void current.then(release, release);
  await executionRace(current);
}
