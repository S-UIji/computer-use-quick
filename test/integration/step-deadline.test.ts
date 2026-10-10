import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { NetworkTracker } from "../../src/waiter/stability.js";
import { DiagnosticsCollector } from "../../src/diagnostics/collector.js";
import { runBatch, type BatchOptions, type BatchResult } from "../../src/executor/batch.js";
import type { StepObserver } from "../../src/executor/observer.js";
import type { Step } from "../../src/types.js";
import { takeSnapshot } from "../../src/perception/snapshot.js";
import { replayTrace } from "../../src/trace/replay.js";
import { validationCountsAgainstBudget } from "../../src/trace/heal.js";
import { ExecutionDeadlineError, runWithDeadline } from "../../src/executor/deadline.js";

let session: BrowserSession, handle: PageHandle, tracker: NetworkTracker, collector: DiagnosticsCollector;
const css = (value: string) => ({ descriptor: { strategies: [{ kind: "css" as const, value }], framePath: [] } });
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function run(steps: Step[], extra: Partial<BatchOptions> & { stepTimeoutMs?: number } = {}) {
  return runBatch({ handle, tracker, collector, refs: new Map(), vars: {}, steps, captureDescriptors: false,
    stability: { domQuietMs: 0, networkQuietMs: 0, timeoutMs: 30 }, resolveRetryMs: 0, stepTimeoutMs: 100, ...extra } as BatchOptions);
}
async function bounded<T>(promise: Promise<T>, ms = 2600): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<undefined>(r => { timer = setTimeout(() => r(undefined), ms); })]); }
  finally { clearTimeout(timer!); }
}
function observer(extra: Partial<StepObserver>): StepObserver {
  return { onRunStart: async () => {}, onStepStart: async () => {}, onStepEnd: async () => {}, onRunEnd: async () => {},
    takeInterruption: () => undefined, takeScrollCount: () => 0, ...extra };
}
beforeEach(async () => {
  session = await BrowserSession.connect(inject("browserURL"));
  handle = await session.newPage();
  await handle.page.setContent('<input id="field" value=""><button id="button" onclick="window.clicks=(window.clicks||0)+1">submit</button>');
  tracker = await NetworkTracker.attach(handle); collector = await DiagnosticsCollector.attach(handle);
});
afterEach(async () => { vi.restoreAllMocks(); await handle?.page.close().catch(() => {}); await session?.close(); });

describe("single step hard deadline", () => {
  it("cancels a sleep and never performs the following click", async () => {
    const result = await run([{ action: "sleep", ms: 600 }, { action: "click", target: css("#button") }]);
    expect(result.failure?.kind).toBe("timeout");
    expect(result.failure?.retryBlocked).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(await handle.page.evaluate(() => (window as any).clicks ?? 0)).toBe(0);
  });

  it("a late keyDown response cannot dispatch keyUp or the following step", async () => {
    const late = deferred<any>(); const sends: string[] = [];
    const original = handle.cdp.send.bind(handle.cdp);
    vi.spyOn(handle.cdp, "send").mockImplementation(((method: string, params?: any) => {
      if (method === "Input.dispatchKeyEvent") { sends.push(params.type); if (params.type === "keyDown") return late.promise; }
      return original(method as any, params);
    }) as any);
    const pending = run([{ action: "press", key: "Enter" }, { action: "click", target: css("#button") }]);
    const result = await bounded(pending);
    expect(result?.failure?.kind).toBe("timeout");
    expect(result?.failure?.retryBlocked).toBe(true);
    late.resolve({}); await pause(80);
    expect(sends).toEqual(["keyDown"]);
    expect(result?.results).toHaveLength(1);
    expect(await handle.page.evaluate(() => (window as any).clicks ?? 0)).toBe(0);
  });

  it("a hanging observer start is included in the step budget", async () => {
    const started = deferred<void>();
    const result = await bounded(run([{ action: "click", target: css("#button") }], { observer: observer({ onStepStart: () => started.promise }) }));
    expect(result?.failure?.kind).toBe("timeout");
    started.resolve(); await pause(60);
    expect(await handle.page.evaluate(() => (window as any).clicks ?? 0)).toBe(0);
    expect(result?.results).toHaveLength(1);
  });
  it("a hanging focus disable starts independent bounded recovery", async () => {
    const late = deferred<any>(); const entered = deferred<number>(); const disabled: boolean[] = [];
    let startedAt = 0;
    const original = handle.cdp.send.bind(handle.cdp);
    vi.spyOn(handle.cdp, "send").mockImplementation(((method: string, params?: any) => {
      if (method === "Emulation.setFocusEmulationEnabled" && params.enabled === false) {
        disabled.push(false); if (disabled.length === 1) { entered.resolve(Date.now() - startedAt); return late.promise; }
      }
      return original(method as any, params);
    }) as any);
    startedAt = Date.now();
    const observed = bounded(run([{ action: "press", key: "Tab" }], { stepTimeoutMs: 1000 }), 3400);
    const firstFalseAt = await Promise.race([entered.promise, observed.then(() => Number.POSITIVE_INFINITY)]);
    expect(firstFalseAt, "ordinary focus restore must enter before the step deadline").toBeLessThan(1000);
    const result = await observed;
    expect(result?.failure?.kind).toBe("timeout");
    expect(result?.failure?.retryBlocked).toBe(true);
    expect(disabled).toHaveLength(2);
    late.resolve({});
  });

  it("shares one cleanup budget between a hanging final snapshot and observer finalization", async () => {
    const late = deferred<any>(); const refs = new Map([["old", 42]]); const ended: boolean[] = [];
    const original = handle.cdp.send.bind(handle.cdp);
    vi.spyOn(handle.cdp, "send").mockImplementation(((method: string, params?: any) => {
      if (method === "Accessibility.getFullAXTree") return late.promise;
      return original(method as any, params);
    }) as any);
    const started = Date.now();
    const result = await bounded(run([{ action: "sleep", ms: 1 }], { refs,
      observer: observer({ onRunEnd: async () => { ended.push(true); await new Promise(() => {}); } }) }));
    expect(result?.failure?.kind).toBe("timeout");
    expect(result?.failure?.retryBlocked).toBe(true);
    expect(Date.now() - started).toBeLessThan(2500);
    expect(refs).toEqual(new Map([["old", 42]]));
    late.resolve({ nodes: [] }); await pause(50);
    expect(result?.ok).toBe(false);
    expect(result?.results).toHaveLength(1);
    expect(refs).toEqual(new Map([["old", 42]]));
  });

  it("late extraction responses cannot mutate returned variables", async () => {
    const late = deferred<any>(); const original = handle.cdp.send.bind(handle.cdp);
    vi.spyOn(handle.cdp, "send").mockImplementation(((method: string, params?: any) => {
      if (method === "Runtime.callFunctionOn" && params.functionDeclaration.includes("textContent")) return late.promise;
      return original(method as any, params);
    }) as any);
    const result = await bounded(run([{ action: "extract", target: css("#button"), as: "LATE" }]));
    expect(result?.failure?.kind).toBe("timeout");
    expect(result?.vars).not.toHaveProperty("LATE");
    late.resolve({ result: { value: "late pollution" } }); await pause(50);
    expect(result?.vars).not.toHaveProperty("LATE");
  });

  it("an expired queued action releases its slot without overtaking the original owner", async () => {
    const late = deferred<any>(); const original = handle.cdp.send.bind(handle.cdp); let keyDowns = 0;
    vi.spyOn(handle.cdp, "send").mockImplementation(((method: string, params?: any) => {
      if (method === "Input.dispatchKeyEvent" && params.type === "keyDown" && ++keyDowns === 1) return late.promise;
      return original(method as any, params);
    }) as any);
    const owner = run([{ action: "press", key: "Tab" }], { stepTimeoutMs: 400 });
    await pause(30);
    const waiter = await run([{ action: "press", key: "Tab" }]);
    expect(waiter.failure?.kind).toBe("timeout");
    expect(keyDowns).toBe(1);
    const first = await owner;
    expect(first.failure?.kind).toBe("timeout");
    const blocked = await run([{ action: "press", key: "Tab" }]);
    expect(blocked.failure?.retryBlocked).toBe(true);
    expect(keyDowns).toBe(1);
    // A snapshot is still possible while the abandoned command is unresolved.
    expect((await takeSnapshot(handle)).text).toContain("submit");
    late.resolve({}); await pause(30);
    // Earlier owner/waiter deadlines remain 100ms; this is an ordinary recovery compatibility check.
    const recovered = await run([{ action: "press", key: "Tab" }], { stepTimeoutMs: 1000 });
    expect(recovered.ok, JSON.stringify(recovered.failure)).toBe(true);
    expect(keyDowns).toBe(2);
  });

  it("page close wins over a hanging observer and deadline", async () => {
    const started = deferred<void>();
    const running = run([{ action: "sleep", ms: 600 }], { observer: observer({ onStepStart: () => started.promise }), stepTimeoutMs: 500 });
    await pause(30); await handle.page.close();
    const result = await bounded(running);
    expect(result?.failure?.kind).toBe("page-closed");
    expect(result?.failure?.retryBlocked).toBeUndefined();
    started.resolve();
  });

  it("a cancelled queue waiter cannot release a still-running owner's input lock", async () => {
    const late = deferred<any>(); const original = handle.cdp.send.bind(handle.cdp); let keyDowns = 0;
    vi.spyOn(handle.cdp, "send").mockImplementation(((method: string, params?: any) => {
      if (method === "Input.dispatchKeyEvent" && params.type === "keyDown" && ++keyDowns === 1) return late.promise;
      return original(method as any, params);
    }) as any);
    const owner = run([{ action: "press", key: "Tab" }], { stepTimeoutMs: 500 });
    await pause(20);
    expect((await run([{ action: "press", key: "Tab" }])).failure?.kind).toBe("timeout");
    const later = await run([{ action: "press", key: "Tab" }]);
    expect(later.failure?.kind).toBe("timeout");
    expect(keyDowns).toBe(1);
    await owner; late.resolve({});
  });

  it("failure snapshots and hanging failure observers preserve the original failure within one grace budget", async () => {
    const late = deferred<any>(); const original = handle.cdp.send.bind(handle.cdp);
    vi.spyOn(handle.cdp, "send").mockImplementation(((method: string, params?: any) => {
      if (method === "Accessibility.getFullAXTree") return late.promise;
      return original(method as any, params);
    }) as any);
    const started = Date.now();
    const result = await bounded(run([{ action: "click", target: css("#missing") }], {
      observer: observer({ onRunEnd: () => new Promise(() => {}) }) }));
    expect(result?.failure?.kind).toBe("target-not-found");
    expect(result?.failure?.retryBlocked).toBe(true);
    expect(result?.failure?.snapshot).toContain("快照获取失败");
    expect(Date.now() - started).toBeLessThan(2500);
    late.resolve({ nodes: [] });
  });

  it("an unknown enable cannot input and its same-page successor stays blocked until acknowledgement", async () => {
    const late = deferred<any>(); let enabled = 0, disabled = 0, inputs = 0; const original = handle.cdp.send.bind(handle.cdp);
    vi.spyOn(handle.cdp, "send").mockImplementation(((method: string, params?: any) => {
      if (method === "Emulation.setFocusEmulationEnabled") {
        if (params.enabled && ++enabled === 1) return late.promise;
        if (!params.enabled) disabled++;
      }
      if (method.startsWith("Input.")) inputs++;
      return original(method as any, params);
    }) as any);
    const result = await run([{ action: "press", key: "Tab" }]);
    expect(result.failure?.kind).toBe("timeout"); expect(result.failure?.retryBlocked).toBe(true);
    expect(disabled).toBe(1); expect(inputs).toBe(0);
    expect((await run([{ action: "press", key: "Tab" }])).failure?.retryBlocked).toBe(true);
    expect(inputs).toBe(0);
    late.resolve({}); await pause(40);
    expect((await run([{ action: "press", key: "Tab" }])).ok).toBe(true);
    expect(inputs).toBe(2);
  });

  it("descriptor capture belongs to the same budget as input", async () => {
    const snapshot = await takeSnapshot(handle); const buttonRef = [...snapshot.refLabels].find(([, label]) => label === "submit")![0];
    const late = deferred<any>(); let inputs = 0; const original = handle.cdp.send.bind(handle.cdp);
    vi.spyOn(handle.cdp, "send").mockImplementation(((method: string, params?: any) => {
      if (method === "Accessibility.getPartialAXTree") return late.promise;
      if (method.startsWith("Input.")) inputs++;
      return original(method as any, params);
    }) as any);
    const result = await run([{ action: "click", target: { ref: buttonRef } }], { captureDescriptors: true, refs: snapshot.refs });
    expect(result.failure?.kind).toBe("timeout"); expect(result.capturedSteps).toEqual([]); expect(inputs).toBe(0);
    late.resolve({ nodes: [] }); await pause(40);
    expect(inputs).toBe(0); expect(result.results).toHaveLength(1);
  });

  it("a hanging run-start hook prevents the first action", async () => {
    const late = deferred<void>();
    const result = await bounded(run([{ action: "click", target: css("#button") }], { observer: observer({ onRunStart: () => late.promise }) }));
    expect(result?.failure?.kind).toBe("timeout");
    late.resolve(); await pause(40);
    expect(await handle.page.evaluate(() => (window as any).clicks ?? 0)).toBe(0);
  });

  it("a hanging step-end hook cannot commit variables, captures or late success", async () => {
    const late = deferred<void>();
    const result = await bounded(run([{ action: "extract", target: css("#button"), as: "NAME" }], { observer: observer({ onStepEnd: () => late.promise }) }));
    expect(result?.failure?.kind).toBe("timeout"); expect(result?.vars).not.toHaveProperty("NAME");
    expect(result?.capturedSteps).toEqual([]); expect(result?.results).toHaveLength(1); expect(result?.results[0].ok).toBe(false);
    late.resolve(); await pause(40);
    expect(result?.vars).not.toHaveProperty("NAME"); expect(result?.results).toHaveLength(1); expect(result?.results[0].ok).toBe(false);
  });

  it("the deadline resets for each successful step", async () => {
    const result = await run([{ action: "sleep", ms: 80 }, { action: "sleep", ms: 80 }], { stepTimeoutMs: 120 });
    expect(result.ok).toBe(true); expect(result.results).toHaveLength(2);
  });

  it("a cancelled tracker initialization never leaves a cached tracker without real network listeners", async () => {
    const fresh = await session.newPage();
    try {
      await fresh.page.goto(inject("fixtureURL") + "/form.html");
      const late = deferred<void>(); const original = fresh.cdp.send.bind(fresh.cdp);
      const spy = vi.spyOn(fresh.cdp, "send").mockImplementation(((method: string, params?: any) => {
        const sent = original(method as any, params);
        return method === "Network.enable" ? late.promise.then(() => sent) : sent;
      }) as any);
      await expect(runWithDeadline(fresh, 100, () => NetworkTracker.attach(fresh))).rejects.toBeInstanceOf(ExecutionDeadlineError);
      late.resolve(); await pause(30); spy.mockRestore();
      const [ready, concurrent] = await Promise.all([NetworkTracker.attach(fresh), NetworkTracker.attach(fresh)]);
      expect(ready).toBe(concurrent);
      const started = new Promise<void>(resolve => {
        const listener = (event: any) => {
          if (!event.request.url.includes("/api/orders")) return;
          fresh.cdp.off("Network.requestWillBeSent", listener); resolve();
        };
        fresh.cdp.on("Network.requestWillBeSent", listener);
      });
      await fresh.page.evaluate(() => { void fetch("/api/orders").catch(() => {}); });
      await started;
      expect(ready.inFlight()).toBe(1);
    } finally { await fresh.page.close().catch(() => {}); }
  });

  it("a validation record whose failure diagnostic timed out never consumes heal budget", async () => {
    const late = deferred<any>(); const original = handle.cdp.send.bind(handle.cdp);
    vi.spyOn(handle.cdp, "send").mockImplementation(((method: string, params?: any) => {
      return method === "Accessibility.getFullAXTree" ? late.promise : original(method as any, params);
    }) as any);
    const record = await bounded(replayTrace({ handle, tracker, collector, vars: {},
      trace: { name: "deadline-validation", baseUrl: inject("fixtureURL"), createdAt: "",
        steps: [{ action: "assert", type: "text-equals", target: css("#button"), expected: "wrong" }] } }));
    expect(record?.failure?.kind).toBe("assert-failed");
    expect(record?.failure?.retryBlocked).toBe(true);
    expect(validationCountsAgainstBudget(record!)).toBe(false);
    late.resolve({ nodes: [] });
  });

  it.each(["create", "query", "detach"] as const)("a hanging restore probe %s keeps the page quarantined and cannot continue late queries", async phase => {
    const browserTarget = handle.page.browser().target();
    const probe = await browserTarget.createCDPSession();
    const originalQuery = probe.send.bind(probe), originalDetach = probe.detach.bind(probe);
    const late = deferred<void>(); let queries = 0, detachments = 0, navigations = 0;
    const diagnostics: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => { diagnostics.push(args.join(" ")); });
    vi.spyOn(probe, "send").mockImplementation(((method: string, params?: any) => {
      if (method === "Target.getTargetInfo") {
        queries++;
        const sent = originalQuery(method as any, params);
        void sent.catch(() => {});
        return phase === "query" ? late.promise.then(() => sent) : sent;
      }
      return originalQuery(method as any, params);
    }) as any);
    vi.spyOn(probe, "detach").mockImplementation(() => {
      detachments++;
      const detached = originalDetach();
      void detached.catch(() => {});
      return phase === "detach" ? late.promise.then(() => detached) : detached;
    });
    vi.spyOn(browserTarget, "createCDPSession").mockImplementation(() => phase === "create" ? late.promise.then(() => probe) : Promise.resolve(probe));
    const original = handle.cdp.send.bind(handle.cdp);
    vi.spyOn(handle.cdp, "send").mockImplementation(((method: string, params?: any) => {
      if (method === "Emulation.setFocusEmulationEnabled" && !params.enabled) return Promise.reject(new Error("Session closed"));
      if (method === "Page.navigate") navigations++;
      return original(method as any, params);
    }) as any);
    let other: PageHandle | undefined;
    try {
      const result = await bounded(run([{ action: "press", key: "Tab" }]), 2700);
      expect(result?.failure?.retryBlocked).toBe(true);
      const successor = await run([{ action: "navigate", url: inject("fixtureURL") + "/form.html" }], { stepTimeoutMs: 600 });
      expect(successor.ok).toBe(false); expect(successor.failure?.retryBlocked).toBe(true); expect(navigations).toBe(0);
      other = await session.newPage(); await other.page.setContent('<button>other page</button>');
      const otherResult = await runBatch({ handle: other, tracker: await NetworkTracker.attach(other), collector: await DiagnosticsCollector.attach(other),
        refs: new Map(), vars: {}, steps: [{ action: "press", key: "Tab" }], captureDescriptors: false, stepTimeoutMs: 600,
        stability: { domQuietMs: 0, networkQuietMs: 0, timeoutMs: 30 } });
      expect(otherResult.ok).toBe(true);
      const queriesBeforeRelease = queries;
      late.resolve(); await pause(70);
      expect(queries).toBe(queriesBeforeRelease);
      if (phase === "create") expect(queries).toBe(0);
      expect(detachments).toBe(1);
      if (phase === "detach") expect(diagnostics.some(message => message.includes("临时探针会话清理未确认"))).toBe(true);
    } finally {
      late.resolve(); await originalDetach().catch(() => {}); await other?.page.close().catch(() => {});
    }
  });

  it("a confirmed missing target wins over a short step deadline while temporary detach hangs", async () => {
    const browserTarget = handle.page.browser().target(); const probe = await browserTarget.createCDPSession();
    const originalDetach = probe.detach.bind(probe); const late = deferred<void>();
    vi.spyOn(browserTarget, "createCDPSession").mockResolvedValue(probe);
    vi.spyOn(probe, "send").mockRejectedValue(Object.assign(new Error("No target with given id found"), { originalMessage: "No target with given id found" }));
    vi.spyOn(probe, "detach").mockImplementation(() => {
      const detached = originalDetach(); void detached.catch(() => {});
      return late.promise.then(() => detached);
    });
    const original = handle.cdp.send.bind(handle.cdp);
    vi.spyOn(handle.cdp, "send").mockImplementation(((method: string, params?: any) => {
      if (method === "Emulation.setFocusEmulationEnabled" && !params.enabled) return Promise.reject(new Error("Session closed"));
      return original(method as any, params);
    }) as any);
    try {
      const result = await bounded(run([{ action: "press", key: "Tab" }]));
      expect(handle.page.isClosed()).toBe(false);
      expect(result?.failure?.kind).toBe("page-closed");
      expect(result?.failure?.retryBlocked).toBeUndefined();
    } finally { late.resolve(); await originalDetach().catch(() => {}); }
  });

});
