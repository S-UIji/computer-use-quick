import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as batch from "../../src/executor/batch.js";
import { runHeal } from "../../src/trace/heal.js";
import {
  assertNoSecrets, atomicWriteTrace, loadTraceSnapshot,
  readHealRecords, saveTrace, TraceChangedError
} from "../../src/trace/store.js";
import type { Step, Trace } from "../../src/types.js";

const dirs: string[] = [];
async function temporaryTrace(): Promise<{ dir: string; tracePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cuq-heal-transaction-"));
  dirs.push(dir);
  return { dir, tracePath: await saveTrace(dir, trace) };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const trace: Trace = {
  name: "transaction", baseUrl: "http://example.test", createdAt: "2026-10-08T00:00:00.000Z",
  steps: [
    { action: "navigate", url: "/before" },
    { action: "click", target: { descriptor: {
      strategies: [{ kind: "css", value: "#old" }], framePath: []
    } } }
  ]
};

const repaired: Trace = {
  ...trace,
  steps: [trace.steps[0], { action: "click", target: { descriptor: {
    strategies: [{ kind: "css", value: "#new" }], framePath: []
  } } }]
};

describe("演示捕获完整性", () => {
  it.each([0, 1])("演示两步成功但仅捕获 %i 步时不创建验证页或写回", async (capturedCount) => {
    const { dir, tracePath } = await temporaryTrace();
    const before = await readFile(tracePath, "utf8");
    const demoSteps: Step[] = [{ action: "sleep", ms: 1 }, { action: "sleep", ms: 2 }];
    vi.spyOn(batch, "runBatch").mockResolvedValue({
      ok: true,
      results: demoSteps.map((step, index) => ({ index, action: step.action, ok: true, durationMs: 1 })),
      vars: {}, snapshot: "", capturedSteps: demoSteps.slice(0, capturedCount), artifacts: []
    });
    const newIsolatedPage = vi.fn().mockRejectedValue(new Error("不应创建验证页"));
    type Options = Parameters<typeof runHeal>[0];
    const outcome = await runHeal({
      session: { newIsolatedPage } as unknown as Options["session"],
      handle: { pageId: "demo", page: { isClosed: () => false } } as unknown as Options["handle"],
      tracker: {} as Options["tracker"], collector: {} as Options["collector"],
      refs: new Map(), tracePath, trace, stepIndex: 1, demoSteps, vars: {}, dryRun: false
    });

    expect(outcome).toMatchObject({ status: "rejected", reason: expect.stringContaining("捕获不完整") });
    expect(newIsolatedPage).not.toHaveBeenCalled();
    expect(await readFile(tracePath, "utf8")).toBe(before);
    expect(await readHealRecords(tracePath)).toEqual([]);
    expect(await readdir(dir)).toEqual([basename(tracePath)]);
  });
});

describe("原文件指纹和条件原子写回", () => {
  it("snapshot 的指纹对应同一次读取的原始字节，空白变化也使指纹改变", async () => {
    const { tracePath } = await temporaryTrace();
    const before = await readFile(tracePath);
    const first = await loadTraceSnapshot(tracePath);
    expect(first.trace).toEqual(trace);
    expect(first.fingerprint).toBe(createHash("sha256").update(before).digest("hex"));

    const reformatted = JSON.stringify(trace) + "\r\n";
    await writeFile(tracePath, reformatted, "utf8");
    const second = await loadTraceSnapshot(tracePath);
    expect(second.trace).toEqual(first.trace);
    expect(second.fingerprint).toBe(createHash("sha256").update(reformatted).digest("hex"));
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it("旧指纹拒绝写回，保留外部内容且不残留临时文件", async () => {
    const { dir, tracePath } = await temporaryTrace();
    const { fingerprint } = await loadTraceSnapshot(tracePath);
    const external = JSON.stringify({ ...trace, baseUrl: "http://external.test" }, null, 4) + "\n";
    await writeFile(tracePath, external, "utf8");

    await expect(atomicWriteTrace(tracePath, repaired, fingerprint)).rejects.toBeInstanceOf(TraceChangedError);
    expect(await readFile(tracePath, "utf8")).toBe(external);
    expect(await readdir(dir)).toEqual([basename(tracePath)]);
    expect(await readHealRecords(tracePath)).toEqual([]);
  });

  it("当前指纹允许完整写回且不残留临时文件", async () => {
    const { dir, tracePath } = await temporaryTrace();
    const { fingerprint } = await loadTraceSnapshot(tracePath);
    await atomicWriteTrace(tracePath, repaired, fingerprint);

    const saved = await loadTraceSnapshot(tracePath);
    expect(saved.trace).toEqual(repaired);
    expect(saved.fingerprint).not.toBe(fingerprint);
    expect(await readdir(dir)).toEqual([basename(tracePath)]);
  });
});

describe("等待条件不能落盘短期 ref", () => {
  it.each(["visible", "hidden"] as const)("拒绝 wait.until.%s 的 ref 目标", (type) => {
    expect(() => assertNoSecrets({ ...trace, steps: [
      { action: "wait", until: { type, target: { ref: "e8" } } }
    ] })).toThrow(/ref/);
  });

  it("允许等待条件内的稳定 descriptor", () => {
    expect(() => assertNoSecrets({ ...trace, steps: [
      { action: "wait", until: { type: "visible", target: { descriptor: {
        strategies: [{ kind: "css", value: "#ready" }], framePath: []
      } } } }
    ] })).not.toThrow();
  });
});
