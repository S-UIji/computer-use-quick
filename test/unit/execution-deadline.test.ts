import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PageHandle } from "../../src/session/browser.js";
import { createExecutionContext, ExecutionDeadlineError, ExecutionQuarantinedError, executionSleep, FinalizationBudget, runWithDeadline, validateStepTimeoutMs } from "../../src/executor/deadline.js";
import { PageClosedError } from "../../src/session/pageErrors.js";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fakeHandle(send: (method: string, params?: any) => Promise<any> = async () => ({})) {
  const page = new EventEmitter() as any; page.isClosed = () => false;
  const primary = { send }; page._client = () => primary;
  return { handle: { pageId: "fake", page, cdp: { send } } as unknown as PageHandle, primary };
}
afterEach(() => vi.useRealTimers());

describe("ExecutionContext", () => {
  it("checkpoint rejects and a raced late result stays rejected", async () => {
    vi.useFakeTimers(); const ctx = createExecutionContext(100); const late = deferred<string>();
    const result = ctx.race(late.promise); const rejected = expect(result).rejects.toBeInstanceOf(ExecutionDeadlineError);
    await vi.advanceTimersByTimeAsync(100); await rejected;
    late.resolve("late"); expect(() => ctx.checkpoint()).toThrow(ExecutionDeadlineError);
    expect(ctx.expired).toBe(true); expect(ctx.remainingMs()).toBe(0); ctx.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("dispose removes a completed execution's deadline timer", async () => {
    vi.useFakeTimers(); const ctx = createExecutionContext(100);
    await expect(ctx.race(Promise.resolve("ok"))).resolves.toBe("ok");
    ctx.dispose(); expect(vi.getTimerCount()).toBe(0);
  });

  it("guard setup errors do not leak an execution timer", async () => {
    vi.useFakeTimers(); const { handle } = fakeHandle();
    (handle.page as any)._client = () => { throw new Error("client unavailable"); };
    await expect(runWithDeadline(handle, 100, async () => {})).rejects.toThrow("client unavailable");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a cancelled sleep clears its long timer", async () => {
    vi.useFakeTimers(); const { handle } = fakeHandle();
    const running = runWithDeadline(handle, 100, () => executionSleep(60_000));
    const rejected = expect(running).rejects.toBeInstanceOf(ExecutionDeadlineError);
    await vi.advanceTimersByTimeAsync(100); await rejected; expect(vi.getTimerCount()).toBe(0);
  });

  it("guards both CDP sessions without replacing the page handle", async () => {
    vi.useFakeTimers(); const sent: string[] = []; const late = deferred<void>();
    const { handle, primary } = fakeHandle(async method => { sent.push(method); return {}; });
    const identity = handle; const byIdentity = new WeakMap([[handle, "registered"]]);
    const running = runWithDeadline(handle, 100, async () => {
      await late.promise;
      await primary.send("Input.insertText", { text: "late" });
      await handle.cdp.send("Page.navigate", { url: "https://late.example" });
    });
    const rejected = expect(running).rejects.toBeInstanceOf(ExecutionDeadlineError);
    await vi.advanceTimersByTimeAsync(100); await rejected;
    late.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([]); expect(handle).toBe(identity); expect(byIdentity.get(handle)).toBe("registered");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an expired continuation cannot dispatch through another guarded page", async () => {
    vi.useFakeTimers(); const late = deferred<void>(); const sent: string[] = [];
    const other = fakeHandle(async method => { sent.push(method); return {}; }).handle;
    await runWithDeadline(other, 100, async () => {});
    const running = runWithDeadline(fakeHandle().handle, 100, async () => {
      await late.promise; await other.cdp.send("Input.insertText", { text: "late cross-page" });
    });
    const rejected = expect(running).rejects.toBeInstanceOf(ExecutionDeadlineError);
    await vi.advanceTimersByTimeAsync(100); await rejected;
    late.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([]);
  });

  it("quarantines unresolved commands on one page while another page remains usable", async () => {
    vi.useFakeTimers(); const late = deferred<any>(); const sent: string[] = [];
    const { handle } = fakeHandle(async method => { sent.push(method); return method === "Input.insertText" ? late.promise : {}; });
    const other = fakeHandle().handle;
    const running = runWithDeadline(handle, 100, () => handle.cdp.send("Input.insertText", { text: "once" }));
    const rejected = expect(running).rejects.toBeInstanceOf(ExecutionDeadlineError);
    await vi.advanceTimersByTimeAsync(100); await rejected;
    await expect(runWithDeadline(handle, 100, () => handle.cdp.send("Page.navigate", { url: "about:blank" }))).rejects.toBeInstanceOf(ExecutionQuarantinedError);
    await expect(runWithDeadline(other, 100, () => other.cdp.send("Input.insertText", { text: "other" }))).resolves.toEqual({});
    await expect(handle.cdp.send("Page.getFrameTree")).resolves.toEqual({});
    expect(sent).toEqual(["Input.insertText", "Page.getFrameTree"]);
    late.resolve({}); await vi.advanceTimersByTimeAsync(0);
    await expect(runWithDeadline(handle, 100, () => handle.cdp.send("Page.navigate", { url: "about:blank" }))).resolves.toEqual({});
    expect(vi.getTimerCount()).toBe(0);
  });

  it("quarantine permits only an identity-checked overlay release and keeps generic JS blocked", async () => {
    vi.useFakeTimers();
    const pending = deferred<any>();
    const attributes = new Set(["data-agent-input"]);
    const overlay = { inputOwner: "owned", cancelledInputThrough: 0, inputLocks: new Set([7]),
      wrap: { removeAttribute: (name:string) => attributes.delete(name) } };
    const { handle } = fakeHandle(async (method, params) => {
      if (method === "Page.navigate") return pending.promise;
      if (method === "Runtime.evaluate") return { result: { value: runInNewContext(params.expression, { window: { __cuqOverlay: overlay } }) } };
      return {};
    });
    const running = runWithDeadline(handle, 100, () => handle.cdp.send("Page.navigate", {url:"about:blank"}));
    const rejected = expect(running).rejects.toBeInstanceOf(ExecutionDeadlineError);
    await vi.advanceTimersByTimeAsync(100); await rejected;
    const finalizer = new FinalizationBudget(handle);
    await expect(finalizer.run(() => handle.cdp.send("Runtime.evaluate", { expression:"window.changed=true", returnByValue:true })))
      .rejects.toBeInstanceOf(ExecutionQuarantinedError);
    await finalizer.restoreOverlayInput("another-owner", 7);
    expect(attributes.has("data-agent-input")).toBe(true);
    await finalizer.restoreOverlayInput("owned", 7);
    expect(attributes.has("data-agent-input")).toBe(false);
    expect(overlay.cancelledInputThrough).toBe(7);
    await expect(finalizer.run(() => handle.cdp.send("Input.insertText", {text:"forbidden"})))
      .rejects.toBeInstanceOf(ExecutionQuarantinedError);
    finalizer.dispose();pending.resolve({});await vi.advanceTimersByTimeAsync(0);expect(vi.getTimerCount()).toBe(0);
  });

  it("a close event interrupts a hung task before its deadline", async () => {
    vi.useFakeTimers(); const { handle } = fakeHandle();
    const running = runWithDeadline(handle, 1000, () => new Promise(() => {}));
    const rejected = expect(running).rejects.toBeInstanceOf(PageClosedError);
    await vi.advanceTimersByTimeAsync(0); (handle.page as any).isClosed = () => true; handle.page.emit("close");
    await rejected; expect(vi.getTimerCount()).toBe(0); expect(handle.page.listenerCount("close")).toBe(0);
  });

  it("finalization also stops immediately when the page closes", async () => {
    vi.useFakeTimers(); const { handle } = fakeHandle(); const finalizer = new FinalizationBudget(handle);
    const running = finalizer.run(() => new Promise(() => {}));
    const rejected = expect(running).rejects.toBeInstanceOf(PageClosedError);
    await vi.advanceTimersByTimeAsync(0); (handle.page as any).isClosed = () => true; handle.page.emit("close");
    await vi.advanceTimersByTimeAsync(2000); await rejected; finalizer.dispose();
    expect(vi.getTimerCount()).toBe(0); expect(handle.page.listenerCount("close")).toBe(0);
  });

  it("a closed-page observer can notify but cannot dispatch on another page", async () => {
    vi.useFakeTimers(); const { handle } = fakeHandle(); const sent: string[] = [];
    const other = fakeHandle(async method => { sent.push(method); return {}; }).handle;
    await runWithDeadline(other, 100, async () => {});
    (handle.page as any).isClosed = () => true;
    const finalizer = new FinalizationBudget(handle); let notified = false;
    await finalizer.runObserver(async () => {
      notified = true;
      await expect(other.cdp.send("Input.insertText", { text: "forbidden" })).rejects.toBeInstanceOf(PageClosedError);
    });
    finalizer.dispose(); expect(notified).toBe(true); expect(sent).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });

  it("closing a page does not reset the shared observer grace budget", async () => {
    vi.useFakeTimers(); const { handle } = fakeHandle(); const finalizer = new FinalizationBudget(handle);
    const first = finalizer.run(() => new Promise(() => {}));
    const closed = expect(first).rejects.toBeInstanceOf(PageClosedError);
    await vi.advanceTimersByTimeAsync(1500); (handle.page as any).isClosed = () => true; handle.page.emit("close"); await closed;
    const observer = finalizer.runObserver(() => new Promise(() => {}));
    const expired = expect(observer).rejects.toBeInstanceOf(ExecutionDeadlineError);
    await vi.advanceTimersByTimeAsync(500); await expired; finalizer.dispose(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each([99, 300001, 100.5, NaN, Infinity])("rejects invalid public timeout %s before execution", value => {
    expect(() => validateStepTimeoutMs(value)).toThrow();
  });
});
