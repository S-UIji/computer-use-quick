import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import puppeteer, { type Browser, type Page, type Target } from "puppeteer-core";
import type { Step, Trace } from "../../src/types.js";

// 真 MCP / stdio 回归。归档与 trace 只落临时 cwd；共享 Chrome 中只操作本文件拥有的页面。
// 前置：npm run build。多点模式不在此演示页执行，只有 legacy actions 使用 snapshot refs。
let browser: Browser;
let client: Client;
let work: string;
let operationPage: Page;
let operationId: string;

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
type Repair = { stepIndex: number; steps: Step[] };

function text(result: ToolResult): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

function css(value: string) {
  return { descriptor: { strategies: [{ kind: "css" as const, value }], framePath: [] } };
}

function click(value: string): Step {
  return { action: "click", target: css(value) };
}

function expectClicked(name: string): Step {
  return { action: "assert", type: "text-equals", target: css("#clicked"),
    expected: `${name} · 查看在岗干部明细` };
}

function twoFaultSteps(): Step[] {
  return [
    { action: "navigate", url: "/cards-v1.html" },
    click("#missing-first"),
    expectClicked("教育事业群"),
    click("#missing-second"),
    expectClicked("技术平台中心")
  ];
}

async function writeTrace(name: string, steps: Step[]): Promise<string> {
  const path = join(work, `${name}.json`);
  const trace: Trace = { name, baseUrl: inject("fixtureURL"), createdAt: "", steps };
  await writeFile(path, JSON.stringify(trace, null, 2) + "\n", "utf8");
  return path;
}

async function audit(path: string): Promise<Array<{ repairs?: Repair[] }>> {
  try {
    return (await readFile(path.replace(/\.json$/, ".heal.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function replay(tracePath: string): Promise<ToolResult> {
  return client.callTool({ name: "replay", arguments: {
    tracePath, pageId: operationId, resolveRetryMs: 0
  } });
}

async function heal(tracePath: string, args: Record<string, unknown>): Promise<ToolResult> {
  return client.callTool({ name: "heal_step", arguments: {
    tracePath, pageId: operationId, ...args
  } }, undefined, { timeout: 30_000 });
}

function pendingRepairs(result: ToolResult): Repair[] {
  const payloads = [...text(result).matchAll(/```json\s*([\s\S]*?)```/g)]
    .map((match) => JSON.parse(match[1]) as { repairs?: Repair[] });
  const parsed = payloads.find((payload) => Array.isArray(payload.repairs));
  expect(parsed, text(result)).toBeDefined();
  return parsed!.repairs!;
}

beforeAll(async () => {
  browser = await puppeteer.connect({ browserURL: inject("browserURL"), defaultViewport: null });
});

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "cuq-mcp-multi-heal-"));
  operationPage = await browser.newPage();
  operationId = (operationPage.target() as Target & { _targetId: string })._targetId;
  await operationPage.goto(`${inject("fixtureURL")}/cards-v1.html`);
  client = new Client({ name: "r5-multi-heal", version: "1" });
  const env = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined));
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/index.js")],
    cwd: work,
    env: { ...env, CUQ_BROWSER_URL: inject("browserURL"), CUQ_WATCH: "off", CUQ_LAUNCH: "" },
    stderr: "pipe"
  }));
  const initial = await client.callTool({ name: "snapshot", arguments: { pageId: operationId } });
  expect(initial.isError).not.toBe(true);
});

afterEach(async () => {
  await client?.close();
  if (operationPage && !operationPage.isClosed()) await operationPage.close();
  if (work) await rm(work, { recursive: true, force: true });
});

afterAll(() => { browser?.disconnect(); });

describe("MCP 多点自愈（真实 SDK / stdio）", () => {
  it("legacy 1→3 揭露后续故障，重复验证不误扣预算，两点合并全绿后只写一条审计", async () => {
    const path = await writeTrace("two-faults", twoFaultSteps());
    const before = await readFile(path, "utf8");
    expect(text(await replay(path))).toContain("target-not-found");
    const snapshot = text(await client.callTool({ name: "snapshot", arguments: { pageId: operationId } }));
    const ref = snapshot.split("\n").find((line) => line.includes('button "查看在岗干部明细"'))
      ?.match(/\[(e\d+)\]/)?.[1];
    expect(ref).toBeDefined();

    const first = await heal(path, { actions: [
      { action: "click", target: { ref } }, { action: "sleep", ms: 1 }, { action: "sleep", ms: 1 }
    ] });
    expect(first.isError).toBe(true);
    expect(text(first)).toMatch(/原\s*第\s*4\s*步/);
    expect(text(first)).toMatch(/候选\s*第\s*6\s*步/);
    const repairs = pendingRepairs(first);
    expect(repairs).toHaveLength(1);
    expect(repairs[0].stepIndex).toBe(1);
    expect(repairs[0].steps).toHaveLength(3);
    expect(JSON.stringify(repairs)).not.toContain('"ref"');
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await audit(path)).toEqual([]);

    // 共四轮验证都在未修复的后续步骤失败：既不能耗尽第一点的 2 次预算，也不能耗尽总额 3 次。
    for (let i = 0; i < 3; i++) {
      const again = await heal(path, { repairs });
      expect(again.isError).toBe(true);
      expect(text(again)).toContain("target-not-found");
      expect(text(again)).toMatch(/原\s*第\s*4\s*步/);
      expect(pendingRepairs(again)).toEqual(repairs);
    }
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await audit(path)).toEqual([]);

    const combined = [...repairs, { stepIndex: 3, steps: [click('[data-testid="detail-tech"]')] }];
    const fixed = await heal(path, { repairs: combined });
    expect(fixed.isError, text(fixed)).not.toBe(true);
    expect(text(fixed)).toContain("自愈成功");
    const saved = JSON.parse(await readFile(path, "utf8")) as Trace;
    expect(saved.steps).toHaveLength(7);
    expect(saved.steps[0]).toEqual(twoFaultSteps()[0]);
    expect(saved.steps[4]).toEqual(twoFaultSteps()[2]);
    expect(saved.steps[6]).toEqual(twoFaultSteps()[4]);
    const records = await audit(path);
    expect(records).toHaveLength(1);
    expect(records[0].repairs?.map((repair) => repair.stepIndex)).toEqual([1, 3]);
    expect(text(await replay(path))).not.toContain("❌");
    const noPending = await heal(path, { actions: [{ action: "sleep", ms: 1 }] });
    expect(noPending.isError).toBe(true);
    expect(text(noPending)).toMatch(/没有待修复|无待修复/);
  }, 60_000);

  it("dryRun 成功和失败都不写回、不耗尽或清零预算，也不覆盖原始失败记录", async () => {
    const path = await writeTrace("dry-budget", twoFaultSteps().slice(0, 3));
    const before = await readFile(path, "utf8");
    expect(text(await replay(path))).toContain("target-not-found");
    const bad = [{ stepIndex: 1, steps: [click("#bad-replacement")] }];
    const good = [{ stepIndex: 1, steps: [click('[data-testid="detail-edu"]')] }];

    const failure1 = await heal(path, { repairs: bad });
    expect(failure1.isError).toBe(true);
    expect(text(failure1)).toContain("target-not-found");
    const dryFailure = await heal(path, { repairs: bad, dryRun: true });
    expect(dryFailure.isError).toBe(true);
    expect(text(dryFailure)).toContain("target-not-found");
    expect(text(dryFailure)).toMatch(/dry-?run/i);
    const drySuccess = await heal(path, { repairs: good, dryRun: true });
    expect(drySuccess.isError, text(drySuccess)).not.toBe(true);
    expect(text(drySuccess)).toMatch(/dry-?run/i);
    // 不传 stepIndex：证明成功 dry-run 没有把磁盘 trace 的 lastRun 改成绿色候选记录。
    const defaultIndexDry = await heal(path, { step: good[0].steps[0], dryRun: true });
    expect(defaultIndexDry.isError, text(defaultIndexDry)).not.toBe(true);
    expect(text(defaultIndexDry)).toMatch(/dry-?run/i);
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await audit(path)).toEqual([]);

    const failure2 = await heal(path, { repairs: bad });
    expect(failure2.isError).toBe(true);
    expect(text(failure2)).toContain("target-not-found");
    const exhausted = await heal(path, { repairs: good });
    expect(exhausted.isError).toBe(true);
    expect(text(exhausted)).toMatch(/上限|耗尽/);
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await audit(path)).toEqual([]);
  }, 60_000);

  it("无对应失败证据、重复索引、混用旧参数以及嵌套 ref 均在执行前拒绝", async () => {
    const path = await writeTrace("invalid-repairs", twoFaultSteps());
    const before = await readFile(path, "utf8");
    expect(text(await replay(path))).toContain("target-not-found");
    const valid = { stepIndex: 1, steps: [click('[data-testid="detail-edu"]')] };
    const invalid: Array<{ args: Record<string, unknown>; reason: RegExp }> = [
      { args: { repairs: [{ stepIndex: 3, steps: [click('[data-testid="detail-tech"]')] }] },
        reason: /证据|失败记录|replay/i },
      { args: { repairs: [{ stepIndex: 2, steps: [{ action: "sleep", ms: 1 }] }] },
        reason: /assert|断言|证据|失败记录/ },
      { args: { repairs: [valid, valid] }, reason: /重复/ },
      { args: { repairs: [valid], stepIndex: 1 }, reason: /互斥|只能|同时|混用/ },
      { args: { repairs: [valid], actions: [{ action: "sleep", ms: 1 }] }, reason: /互斥|只能|同时|混用/ },
      { args: { repairs: [{ stepIndex: 1, steps: [{ action: "wait",
        until: { type: "visible", target: { ref: "e1" } }, timeout: 1 }] }] }, reason: /ref|descriptor/i }
    ];
    for (const { args, reason } of invalid) {
      const result = await heal(path, args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(text(result)).toMatch(reason);
      expect(await operationPage.$eval("#clicked", (element) => element.textContent)).toBe("未点击");
      expect(await readFile(path, "utf8")).toBe(before);
      expect(await audit(path)).toEqual([]);
    }
  });

  it("原始 assert 失败不能借自愈替换为非断言", async () => {
    const path = await writeTrace("assert-locator", [
      { action: "navigate", url: "/cards-v1.html" },
      { action: "assert", type: "visible", target: css("#missing-assert-target") }
    ]);
    const before = await readFile(path, "utf8");
    expect(text(await replay(path))).toContain("assert-failed");
    const result = await heal(path, { repairs: [{ stepIndex: 1, steps: [{ action: "sleep", ms: 1 }] }] });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/assert|断言/);
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await audit(path)).toEqual([]);
  });

  it("磁盘 trace 字节改变后，旧失败证据不能用于修复", async () => {
    const path = await writeTrace("stale-evidence", twoFaultSteps().slice(0, 3));
    expect(text(await replay(path))).toContain("target-not-found");
    // 连仅格式的变化也必须重建证据，不能以语义相似冒充相同原始版本。
    const changed = (await readFile(path, "utf8")) + "\n";
    await writeFile(path, changed, "utf8");
    const result = await heal(path, { repairs: [{ stepIndex: 1,
      steps: [click('[data-testid="detail-edu"]')] }] });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/replay/i);
    expect(await readFile(path, "utf8")).toBe(changed);
    expect(await audit(path)).toEqual([]);
  });
  it("同一 trace 并发失败修复只执行一个，busy 拒绝不消耗验证预算", async () => {
    const path = await writeTrace("parallel-budget", twoFaultSteps().slice(0, 3));
    const before = await readFile(path, "utf8");
    expect(text(await replay(path))).toContain("target-not-found");
    const bad = [{ stepIndex: 1, steps: [{ action: "sleep", ms: 500 }, click("#parallel-missing")] }];
    const results = await Promise.all([
      heal(path, { repairs: bad }),
      heal(`${work}/./parallel-budget.json`, { repairs: bad })
    ]);
    expect(results.filter((result) => /正在自愈/.test(text(result)))).toHaveLength(1);
    expect(results.filter((result) => /target-not-found/.test(text(result)))).toHaveLength(1);
    expect(results.every((result) => result.isError === true)).toBe(true);
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await audit(path)).toEqual([]);

    const secondFailure = await heal(path, { repairs: bad });
    expect(secondFailure.isError).toBe(true);
    expect(text(secondFailure)).toContain("target-not-found");
    const exhausted = await heal(path, { repairs: [{ stepIndex: 1,
      steps: [click('[data-testid="detail-edu"]')] }] });
    expect(exhausted.isError).toBe(true);
    expect(text(exhausted)).toMatch(/上限|耗尽/);
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await audit(path)).toEqual([]);
  });

  it("同一 trace 并发成功修复只写回一次、只产生一条审计", async () => {
    const path = await writeTrace("parallel-success", twoFaultSteps().slice(0, 3));
    expect(text(await replay(path))).toContain("target-not-found");
    const repairs = [{ stepIndex: 1,
      steps: [{ action: "sleep", ms: 500 }, click('[data-testid="detail-edu"]')] }];
    const results = await Promise.all([
      heal(path, { repairs }),
      heal(process.platform === "win32" ? `${work}/./parallel-success.json`.toUpperCase() : `${work}/./parallel-success.json`, { repairs })
    ]);
    const busy = results.filter((result) => /正在自愈/.test(text(result)));
    const successful = results.filter((result) => result.isError !== true);
    expect(busy).toHaveLength(1);
    expect(busy[0].isError).toBe(true);
    expect(successful).toHaveLength(1);
    expect(text(successful[0])).toContain("自愈成功");
    const saved = JSON.parse(await readFile(path, "utf8")) as Trace;
    expect(saved.steps).toHaveLength(4);
    const records = await audit(path);
    expect(records).toHaveLength(1);
    expect(records[0].repairs?.map((repair) => repair.stepIndex)).toEqual([1]);
    expect(text(await replay(path))).not.toContain("❌");
  });
});
