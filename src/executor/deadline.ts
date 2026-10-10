import { AsyncLocalStorage } from "node:async_hooks";
import type { PageHandle } from "../session/browser.js";
import { PageClosedError, assertPageOpen } from "../session/pageErrors.js";

export const DEFAULT_STEP_TIMEOUT_MS = 30_000;
export const DEFAULT_DEADLINE_MS = DEFAULT_STEP_TIMEOUT_MS;
export const MIN_DEADLINE_MS = 100;
export const MAX_DEADLINE_MS = 300_000;
export const FINALIZATION_TIMEOUT_MS = 2000;

export class ExecutionDeadlineError extends Error {
  readonly code = "execution-deadline";
  readonly retryBlocked = true;
  constructor(public readonly deadlineMs: number) {
    super(`步骤执行超时（${deadlineMs}ms），已停止后续动作；已发出的命令可能完成，请 snapshot 核实副作用，禁止自动重试`);
    this.name = "ExecutionDeadlineError";
  }
}
export class ExecutionQuarantinedError extends Error {
  readonly retryBlocked = true;
  constructor() {
    super("该页仍有未决协议命令或焦点恢复状态未知，已阻止后续动作；请等待旧命令结算，恢复未知时重新连接后 snapshot 核实副作用");
    this.name = "ExecutionQuarantinedError";
  }
}
class ExecutionStoppedError extends Error {
  constructor() { super("该执行域已结束，拒绝迟到的协议调用"); }
}

export interface ExecutionContext {
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly expired: boolean;
  checkpoint(): void;
  remainingMs(): number;
  race<T>(promise: Promise<T>): Promise<T>;
  cancel(error: Error): void;
  dispose(): void;
}
export function validateStepTimeoutMs(value: number | undefined): number {
  const n = value ?? DEFAULT_STEP_TIMEOUT_MS;
  if (!Number.isInteger(n) || n < MIN_DEADLINE_MS || n > MAX_DEADLINE_MS) {
    throw new Error(`stepTimeoutMs 必须是 ${MIN_DEADLINE_MS} 至 ${MAX_DEADLINE_MS} 的整数`);
  }
  return n;
}
export const validateDeadlineMs = validateStepTimeoutMs;

/** 内部收尾预算可小于公有 stepTimeoutMs 下限。必须由所属执行在 finally dispose。 */
export function createExecutionContext(value = DEFAULT_STEP_TIMEOUT_MS): ExecutionContext {
  if (!Number.isFinite(value) || value < 0) throw new Error("执行预算必须是非负有限毫秒数");
  const startedAt = Date.now(), deadlineAt = startedAt + value;
  const controller = new AbortController();
  let reason: Error | undefined;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = (error: Error): void => {
    if (reason) return;
    reason = error;
    expired = error instanceof ExecutionDeadlineError;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    controller.abort(error);
  };
  timer = setTimeout(() => cancel(new ExecutionDeadlineError(value)), value);
  const context: ExecutionContext = {
    deadlineMs: value, signal: controller.signal, startedAt, deadlineAt,
    get expired() { return expired; },
    checkpoint() {
      if (!reason && Date.now() >= deadlineAt) cancel(new ExecutionDeadlineError(value));
      if (reason) throw reason;
    },
    remainingMs() { return Math.max(0, deadlineAt - Date.now()); },
    race<T>(promise: Promise<T>): Promise<T> {
      // Observe rejected work even if the caller has already expired.
      void promise.catch(() => {});
      try { context.checkpoint(); } catch (error) { return Promise.reject(error); }
      return new Promise<T>((resolve, reject) => {
        const aborted = (): void => { cleanup(); reject(reason); };
        const cleanup = (): void => controller.signal.removeEventListener("abort", aborted);
        controller.signal.addEventListener("abort", aborted, { once: true });
        promise.then(value => {
          cleanup();
          try { context.checkpoint(); resolve(value); } catch (error) { reject(error); }
        }, error => {
          cleanup();
          try { context.checkpoint(); reject(error); } catch (deadline) { reject(deadline); }
        });
      });
    },
    cancel,
    dispose() { cancel(new ExecutionStoppedError()); }
  };
  return context;
}

interface PageExecutionState { pending: Set<Promise<unknown>>; focusUnknown: boolean; confirmedClosed: boolean; }
const pageStates = new WeakMap<PageHandle, PageExecutionState>();
function stateFor(handle: PageHandle): PageExecutionState {
  let state = pageStates.get(handle);
  if (!state) { state = { pending: new Set(), focusUnknown: false, confirmedClosed: false }; pageStates.set(handle, state); }
  return state;
}
export function executionPageClosed(handle: PageHandle): boolean {
  return handle.page.isClosed() || stateFor(handle).confirmedClosed;
}
function assertExecutionPageOpen(handle: PageHandle): void {
  assertPageOpen(handle);
  if (stateFor(handle).confirmedClosed) throw new PageClosedError(handle.pageId);
}
export function markExecutionPageClosed(handle: PageHandle): void {
  stateFor(handle).confirmedClosed = true;
  const domain = domains.getStore();
  if (domain?.handle === handle) domain.context.cancel(new PageClosedError(handle.pageId));
}
export function markInputRecoveryUnknown(handle: PageHandle): void { stateFor(handle).focusUnknown = true; }
export function assertExecutionReady(handle: PageHandle): void {
  assertExecutionPageOpen(handle);
  const state = stateFor(handle);
  if (state.focusUnknown || state.pending.size) throw new ExecutionQuarantinedError();
}

interface ExecutionDomain {
  handle: PageHandle;
  context: ExecutionContext;
  finalizer: FinalizationBudget;
  mode: "action" | "finalize" | "focus-restore" | "notification" | "probe";
  pending: Set<Promise<unknown>>;
  cleanups: Set<() => Promise<void>>;
  cleanupWork: Set<Promise<void>>;
}
const domains = new AsyncLocalStorage<ExecutionDomain>();
export function executionCheckpoint(): void { domains.getStore()?.context.checkpoint(); }
export function executionRace<T>(promise: Promise<T>): Promise<T> { return domains.getStore()?.context.race(promise) ?? promise; }
export function executionSignal(): AbortSignal | undefined { return domains.getStore()?.context.signal; }
export function executionRemainingMs(): number | undefined { return domains.getStore()?.context.remainingMs(); }
export function executionExpired(): boolean { return domains.getStore()?.context.signal.aborted ?? false; }
export function executionSleep(ms: number): Promise<void> {
  const domain = domains.getStore();
  if (!domain) return new Promise(resolve => setTimeout(resolve, ms));
  domain.context.checkpoint();
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<void>(resolve => { timer = setTimeout(resolve, ms); });
  return domain.context.race(promise).finally(() => clearTimeout(timer));
}

// These calls obtain a snapshot or release diagnostic handles. Arbitrary JS evaluation is not a read.
const READ_COMMANDS = new Set([
  "Page.enable", "Page.getFrameTree", "DOM.getDocument", "DOM.describeNode", "DOM.resolveNode",
  "DOM.requestNode", "DOM.querySelector", "DOM.querySelectorAll", "Accessibility.getFullAXTree",
  "Runtime.releaseObject", "Runtime.releaseObjectGroup", "Target.getTargetInfo"
]);
type SendSession = { send: (...args: any[]) => Promise<any> };
const guardedSessions = new WeakMap<object, { wrapper: SendSession["send"] }>();
function guardSession(handle: PageHandle, session: SendSession | undefined): void {
  if (!session || guardedSessions.get(session)?.wrapper === session.send) return;
  const original = session.send;
  const wrapper: SendSession["send"] = function (this: SendSession, ...args: any[]): Promise<any> {
    const domain = domains.getStore();
    const own = domain;
    try {
      assertExecutionPageOpen(handle);
      own?.context.checkpoint();
      if (own?.mode === "notification") throw new PageClosedError(own.handle.pageId);
      const state = stateFor(handle);
      const isRestore = own?.handle === handle && own.mode === "focus-restore" && args[0] === "Emulation.setFocusEmulationEnabled" && args[1]?.enabled === false;
      if (own && (state.focusUnknown || state.pending.size) && !isRestore && !READ_COMMANDS.has(args[0])) {
        throw new ExecutionQuarantinedError();
      }
      if (own?.mode === "probe" && !READ_COMMANDS.has(args[0])) throw new ExecutionQuarantinedError();
      if (own?.mode === "focus-restore" && !isRestore) throw new ExecutionQuarantinedError();
    } catch (error) { return Promise.reject(error); }
    let sent: Promise<any>;
    try { sent = Promise.resolve(original.apply(this, args)); } catch (error) { return Promise.reject(error); }
    if (!own) return sent;
    own.pending.add(sent);
    const state = stateFor(handle);
    // Only commands abandoned by cancellation are quarantined; normal same-page CDP remains usable.
    const abandoned = (): void => { state.pending.add(sent); };
    own.context.signal.addEventListener("abort", abandoned, { once: true });
    void sent.then(() => settle(), () => settle());
    const settle = (): void => {
      own.context.signal.removeEventListener("abort", abandoned);
      own.pending.delete(sent); state.pending.delete(sent);
    };
    return own.context.race(sent);
  };
  session.send = wrapper;
  guardedSessions.set(session, { wrapper });
}
export function guardExecutionSession(handle: PageHandle, session: SendSession): void { guardSession(handle, session); }

function installGuards(handle: PageHandle): void {
  guardSession(handle, handle.cdp as unknown as SendSession);
  const primary = (handle.page as unknown as { _client?: () => SendSession })._client?.();
  if (primary !== handle.cdp as unknown as SendSession) guardSession(handle, primary);
}

/** One lazy 2000ms budget is shared by focus recovery, failure snapshots and observer finalization. */
export class FinalizationBudget {
  private context?: ExecutionContext;
  private readonly closed = (): void => this.context?.cancel(new PageClosedError(this.handle.pageId));
  constructor(private readonly handle: PageHandle, private readonly timeoutMs = FINALIZATION_TIMEOUT_MS) {}
  async run<T>(task: () => Promise<T>, mode: "finalize" | "focus-restore" | "probe" = "finalize"): Promise<T> {
    if (!this.context) {
      this.context = createExecutionContext(this.timeoutMs);
      this.handle.page.on?.("close", this.closed);
    }
    assertExecutionPageOpen(this.handle);
    const domain: ExecutionDomain = { handle: this.handle, context: this.context, finalizer: this, mode,
      pending: new Set(), cleanups: new Set(), cleanupWork: new Set() };
    installGuards(this.handle);
    const work = domains.run(domain, () => Promise.resolve().then(() => { executionCheckpoint(); return task(); }));
    return this.context.race(work);
  }
  /** A closed page still needs non-CDP completion notifications; keep the original grace deadline. */
  async runObserver<T>(task: () => Promise<T>): Promise<T> {
    if (!executionPageClosed(this.handle)) return this.run(task);
    if (!this.context) {
      this.context = createExecutionContext(this.timeoutMs);
      this.handle.page.on?.("close", this.closed);
    }
    const remaining = this.context.remainingMs();
    if (remaining === 0) throw new ExecutionDeadlineError(this.timeoutMs);
    const context = createExecutionContext(remaining);
    const domain: ExecutionDomain = { handle: this.handle, context, finalizer: this, mode: "notification",
      pending: new Set(), cleanups: new Set(), cleanupWork: new Set() };
    try {
      installGuards(this.handle);
      const work = domains.run(domain, () => Promise.resolve().then(() => { executionCheckpoint(); return task(); }));
      return await context.race(work);
    } finally { context.dispose(); }
  }
  dispose(): void { this.context?.dispose(); this.handle.page.off?.("close", this.closed); }
}

export function registerExecutionCleanup(cleanup: () => Promise<void>): () => void {
  const domain = domains.getStore();
  if (!domain) return () => {};
  domain.cleanups.add(cleanup);
  return () => domain.cleanups.delete(cleanup);
}
/** Recovery probes share the batch grace deadline, including calls made before step expiry. */
export async function withExecutionProbe<T>(handle: PageHandle, task: () => Promise<T>): Promise<T> {
  const domain = domains.getStore();
  if (domain?.handle === handle) return domain.finalizer.run(task, "probe");
  const finalizer = new FinalizationBudget(handle);
  try { return await finalizer.run(task, "probe"); }
  finally { finalizer.dispose(); }
}

export function withExecutionCleanup<T>(handle: PageHandle, task: () => Promise<T>): Promise<T> {
  const domain = domains.getStore();
  if (domain?.handle === handle && domain.context.signal.aborted) return domain.finalizer.run(task, "focus-restore");
  return task();
}

/** The timed-out task retains its expired ALS domain, so a late continuation can never dispatch again. */
export async function runWithDeadline<T>(
  handle: PageHandle, timeoutMs: number, task: () => Promise<T>, sharedFinalizer?: FinalizationBudget
): Promise<T> {
  const finalizer = sharedFinalizer ?? new FinalizationBudget(handle);
  const context = createExecutionContext(timeoutMs);
  const domain: ExecutionDomain = { handle, context, finalizer, mode: "action", pending: new Set(), cleanups: new Set(), cleanupWork: new Set() };
  const closed = (): void => context.cancel(new PageClosedError(handle.pageId));
  handle.page.on?.("close", closed);
  const abort = (): void => {
    for (const cleanup of domain.cleanups) {
      const work = domains.run(domain, () => Promise.resolve().then(cleanup).catch(() => {}));
      domain.cleanupWork.add(work);
      void work.finally(() => domain.cleanupWork.delete(work));
    }
  };
  context.signal.addEventListener("abort", abort, { once: true });
  try {
    installGuards(handle);
    assertExecutionPageOpen(handle);
    const work = domains.run(domain, () => Promise.resolve().then(() => { executionCheckpoint(); return task(); }));
    return await context.race(work);
  } catch (error) {
    if (domain.cleanupWork.size) await Promise.all(domain.cleanupWork);
    if (executionPageClosed(handle)) throw new PageClosedError(handle.pageId);
    throw error;
  } finally {
    context.signal.removeEventListener("abort", abort);
    context.dispose();
    handle.page.off?.("close", closed);
    if (!sharedFinalizer) finalizer.dispose();
  }
}
