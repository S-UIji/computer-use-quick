import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BrowserSession } from "../../src/session/browser.js";
import type { StepObserver } from "../../src/executor/observer.js";
import { runMultiHeal } from "../../src/trace/heal.js";
import { healSidecarPath, loadTraceSnapshot, readHealRecords, saveTrace } from "../../src/trace/store.js";
import type { StepResult, Trace } from "../../src/types.js";

let session: BrowserSession;
const dirs: string[] = [];
beforeAll(async () => { session = await BrowserSession.connect(inject("browserURL")); });
afterAll(async () => { await session?.close(); });
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("自愈验证期间的文件事务", () => {
  it("候选全绿但原文件已外改时拒写，保留外部内容且不追加审计", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cuq-heal-transaction-it-"));
    dirs.push(dir);
    const trace: Trace = {
      name: "changed-during-validation", baseUrl: inject("fixtureURL"),
      createdAt: "2026-10-08T00:00:00.000Z",
      steps: [
        { action: "navigate", url: "/cards-v1.html" },
        { action: "click", target: { descriptor: {
          strategies: [{ kind: "css", value: "#missing-original-button" }], framePath: []
        } } },
        { action: "assert", type: "text-equals", target: { descriptor: {
          strategies: [{ kind: "css", value: "#clicked" }], framePath: []
        } }, expected: "教育事业群 · 查看在岗干部明细" }
      ]
    };
    const tracePath = await saveTrace(dir, trace);
    const { fingerprint } = await loadTraceSnapshot(tracePath);
    const external = JSON.stringify({ ...trace, createdAt: "2026-10-08T01:00:00.000Z" }, null, 4) + "\n";
    const observed: StepResult[] = [];
    const observer: StepObserver = {
      onRunStart: async () => {},
      onStepStart: async () => {},
      onStepEnd: async (result) => {
        observed.push(result);
        if (result.index === 0) await writeFile(tracePath, external, "utf8");
      },
      onRunEnd: async () => {},
      takeInterruption: () => undefined,
      takeScrollCount: () => 0
    };
    const pagesBefore = (await session.listPages()).map((page) => page.pageId).sort();
    const outcome = await runMultiHeal({
      session, tracePath, trace, expectedFingerprint: fingerprint,
      repairs: [{ stepIndex: 1, steps: [{ action: "click", target: { descriptor: {
        strategies: [{ kind: "test-id", value: "detail-edu" }], framePath: []
      } } }] }],
      vars: {}, dryRun: false, validationObserverFor: () => observer
    });

    expect(observed.map(({ index, ok }) => ({ index, ok }))).toEqual([
      { index: 0, ok: true }, { index: 1, ok: true }, { index: 2, ok: true }
    ]);
    expect(outcome).toMatchObject({ status: "rejected", reason: expect.stringContaining("改变") });
    expect(await readFile(tracePath, "utf8")).toBe(external);
    expect(await readHealRecords(tracePath)).toEqual([]);
    expect(await readdir(dir)).toEqual([basename(tracePath)]);
    expect((await session.listPages()).map((page) => page.pageId).sort()).toEqual(pagesBefore);
  });

  it("trace 已提交但审计追加失败时返回成功及告警，不谎报未写回", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cuq-heal-audit-it-"));
    dirs.push(dir);
    const trace: Trace = {
      name: "audit-write-failure", baseUrl: inject("fixtureURL"),
      createdAt: "2026-10-08T00:00:00.000Z",
      steps: [
        { action: "navigate", url: "/cards-v1.html" },
        { action: "click", target: { descriptor: {
          strategies: [{ kind: "css", value: "#missing-original-button" }], framePath: []
        } } },
        { action: "assert", type: "text-equals", target: { descriptor: {
          strategies: [{ kind: "css", value: "#clicked" }], framePath: []
        } }, expected: "教育事业群 · 查看在岗干部明细" }
      ]
    };
    const tracePath = await saveTrace(dir, trace);
    const { fingerprint } = await loadTraceSnapshot(tracePath);
    const sidecarPath = healSidecarPath(tracePath);
    // 用目录占住审计文件路径，稳定模拟权限/文件系统导致的 append 失败。
    await mkdir(sidecarPath);
    const replacement = { action: "click" as const, target: { descriptor: {
      strategies: [{ kind: "test-id" as const, value: "detail-edu" }], framePath: []
    } } };
    const pagesBefore = (await session.listPages()).map((page) => page.pageId).sort();
    const outcome = await runMultiHeal({
      session, tracePath, trace, expectedFingerprint: fingerprint,
      repairs: [{ stepIndex: 1, steps: [replacement] }], vars: {}, dryRun: false
    });

    expect(outcome).toMatchObject({
      status: "healed", dryRun: false, auditWarning: expect.stringContaining("审计"),
      validation: { ok: true }
    });
    expect((await loadTraceSnapshot(tracePath)).trace).toEqual({
      ...trace, steps: [trace.steps[0], replacement, trace.steps[2]]
    });
    expect(await readdir(sidecarPath)).toEqual([]);
    expect((await readdir(dir)).sort()).toEqual([basename(tracePath), basename(sidecarPath)].sort());
    expect((await session.listPages()).map((page) => page.pageId).sort()).toEqual(pagesBefore);
  });
});
