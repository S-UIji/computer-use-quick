import { beforeAll, afterAll, describe, it, expect, inject, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserSession } from "../../src/session/browser.js";
import { NetworkTracker } from "../../src/waiter/stability.js";
import { DiagnosticsCollector } from "../../src/diagnostics/collector.js";
import { runBatch } from "../../src/executor/batch.js";
import { runSuite } from "../../src/trace/suite.js";
import { checkHealGate, validationCountsAgainstBudget, runHeal } from "../../src/trace/heal.js";
import { renderSuiteResult } from "../../src/report/suiteReport.js";
import { FakeObserver } from "../fixtures/fake-observer.js";
import type { Step, Trace } from "../../src/types.js";
import { PageClosedError } from "../../src/session/pageErrors.js";

let session: BrowserSession, dir: string;
beforeAll(async () => {
  session = await BrowserSession.connect(inject("browserURL"));
  dir = await mkdtemp(join(tmpdir(), "cuq-r7-"));
});
afterAll(async () => { await session.close(); await rm(dir, { recursive: true, force: true }); });

describe("页面关闭失败", () => {

  it("自愈验证页关闭不写回且不消耗预算", async () => {
    const handle = await session.newPage();
    const tracker = await NetworkTracker.attach(handle);
    const collector = await DiagnosticsCollector.attach(handle);
    const path = join(dir, "heal-closed.json");
    const trace: Trace = { name: "heal-closed", baseUrl: inject("fixtureURL"), createdAt: "",
      steps: [{ action: "sleep", ms: 1 }] };
    const original = JSON.stringify(trace);
    await writeFile(path, original);
    try {
      const outcome = await runHeal({
        session, handle, tracker, collector, refs: new Map(), tracePath: path, trace,
        stepIndex: 0, demoSteps: [{ action: "sleep", ms: 1 }], vars: {}, dryRun: false,
        validationObserverFor: (page) => {
          const observer = new FakeObserver();
          observer.onRunStart = async () => { await page.page.close(); };
          return observer;
        }
      });
      expect(outcome.status).toBe("validation-failed");
      if (outcome.status === "validation-failed") {
        expect(outcome.validation.failure?.kind).toBe("page-closed");
        expect(validationCountsAgainstBudget(outcome.validation)).toBe(false);
      }
      expect(await readFile(path, "utf8")).toBe(original);
    } finally { await handle.page.close().catch(() => {}); }
  });

  it.each(["create", "attach"] as const)("suite 在 %s 阶段关闭页只失败该用例且不重试", async (when) => {
    const path = join(dir, "early-closed.json");
    await writeFile(path, JSON.stringify({
      name: "early-closed", baseUrl: inject("fixtureURL"), createdAt: "",
      steps: [{ action: "navigate", url: "/form.html" }]
    }));
    const original = session.newIsolatedPage.bind(session);
    const spy = vi.spyOn(session, "newIsolatedPage").mockImplementation(async () => {
      if (when === "create") throw new PageClosedError("closed-during-setup");
      const resource = await original();
      await resource.handle.page.close();
      return resource;
    });
    try {
      const result = await runSuite({ session, paths: [path], vars: {}, concurrency: 1,
        runsDir: join(dir, "early-runs") });
      expect(result.failed).toBe(1);
      expect(result.results[0].record?.failure?.kind).toBe("page-closed");
      expect(result.results[0].attempts).toBe(1);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });

  it.each(["before", "during", "after"] as const)("%s：步骤/收尾关闭仍返回失败上下文并收尾", async (when) => {
    const handle = await session.newPage();
    const tracker = await NetworkTracker.attach(handle);
    const collector = await DiagnosticsCollector.attach(handle);
    const observer = new FakeObserver();
    const steps: Step[] = [{ action: "sleep", ms: 150 }];
    if (when !== "after") steps.push({ action: "navigate", url: inject("fixtureURL") + "/form.html" });
    let closing: Promise<void> | undefined;
    if (when === "before") {
      observer.onStepStart = async (i) => { if (i === 0) await handle.page.close(); };
    } else if (when === "during") {
      observer.onStepStart = async (i) => {
        if (i === 0) closing = new Promise((r) => setTimeout(r, 40)).then(() => handle.page.close());
      };
    } else {
      observer.onStepEnd = async () => { await handle.page.close(); };
    }
    try {
      const r = await runBatch({ handle, tracker, collector, refs: new Map(), vars: {}, steps, observer });
      expect(r.ok).toBe(false);
      expect(r.failure?.kind).toBe("page-closed");
      expect(r.failure?.message).toMatch(/标签页.*已关闭/);
      expect(r.failure?.message).toContain("list_pages");
      expect(r.results.some((s) => s.action === "navigate")).toBe(false);
      expect(observer.events).toContain("done:false:0:false");
    } finally {
      await closing;
      await handle.page.close().catch(() => {});
    }
  });

  it("关闭的 suite 用例不重试、不自愈且报告给出恢复建议", async () => {
    const path = join(dir, "closed.json");
    await writeFile(path, JSON.stringify({
      name: "closed", baseUrl: inject("fixtureURL"), createdAt: "",
      steps: [{ action: "sleep", ms: 1 }, { action: "navigate", url: "/form.html" }]
    }));
    const events: string[] = [];
    const r = await runSuite({
      session, paths: [path], vars: {}, concurrency: 1, runsDir: join(dir, "runs"),
      observerFor: (handle) => {
        const observer = new FakeObserver();
        observer.onStepStart = async (i) => { if (i === 0) await handle.page.close(); };
        return observer;
      },
      onTraceEvent: (e) => events.push(e.kind)
    });
    const result = r.results[0];
    expect(result.record?.failure?.kind).toBe("page-closed");
    expect(result.attempts).toBe(1);
    expect(result.record?.healRequired).toBe(false);
    expect(events).toEqual(["done"]);
    const report = renderSuiteResult(r);
    expect(report).toContain("page-closed");
    expect(report).not.toContain("可接 heal_step 自愈");
    expect(report).toContain("无需 heal_step");
    expect(report.trim().split("\n").at(-1)).toMatch(/^SUITE_RESULT ok=0 failed=1 total=1/);
    const budget = { perStep: new Map<number, number>(), total: 0 };
    const gate = checkHealGate({ lastFailureKind: result.record!.failure!.kind, budget, stepIndex: 0 });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toContain("标签页");
    expect(validationCountsAgainstBudget(result.record!)).toBe(false);
    expect(budget.total).toBe(0);
  });
});
