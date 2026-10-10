import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { createServer, healBudgets, lastRunByTrace } from "../../src/server.js";
import { canonicalTracePath } from "../../src/trace/store.js";
import { PageInitializationDeadlineError } from "../../src/session/pageInitialization.js";
import { runSuite } from "../../src/trace/suite.js";
import { runMultiHeal, validationCountsAgainstBudget } from "../../src/trace/heal.js";
import type { Step, Trace } from "../../src/types.js";

let session: BrowserSession, page: PageHandle, client: Client, server: ReturnType<typeof createServer>, dir: string;
const css = (value: string) => ({ descriptor: { strategies: [{ kind: "css" as const, value }], framePath: [] } });
const output = (result: any): string => result.content.filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n");
const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: { pageId: page.pageId, ...args } });
async function save(name: string, steps: Step[]): Promise<string> {
  const path = join(dir, name + ".json");
  const trace: Trace = { name, baseUrl: inject("fixtureURL"), createdAt: "", steps };
  await writeFile(path, JSON.stringify(trace));
  return canonicalTracePath(path);
}
beforeAll(async () => {
  session = await BrowserSession.connect(inject("browserURL"), { watch: false });
  server = createServer(session); client = new Client({ name: "r18-deadline", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s); await client.connect(c);
  dir = await mkdtemp(join(tmpdir(), "cuq-step-deadline-"));
});
beforeEach(async () => { page = await session.newPage(); await page.page.goto(inject("fixtureURL") + "/form.html?sentinel"); });
afterEach(async () => { vi.restoreAllMocks(); await page.page.close().catch(() => {}); });
afterAll(async () => { await client.close(); await server.close(); await session.close(); await rm(dir, { recursive: true, force: true }); });

describe("MCP 步骤截止时间入口", () => {
  it.each([99, 300001, 100.5, "100", null])("四个执行工具拒绝非法 stepTimeoutMs=%j，不发生前序输入", async stepTimeoutMs => {
    const path = await save("bad-option", [{ action: "fill", target: css("#user"), value: "should-not-write" }]);
    for (const [name, args] of [
      ["batch", { steps: [{ action: "fill", target: css("#user"), value: "should-not-write" }] }],
      ["replay", { tracePath: path }],
      ["replay_suite", { tracePaths: [path], concurrency: 1 }],
      ["heal_step", { tracePath: path, actions: [{ action: "sleep", ms: 1 }] }]
    ] as const) {
      const result = await call(name, { ...args, stepTimeoutMs });
      expect(result.isError, output(result)).toBe(true);
      expect(output(result)).toContain("stepTimeoutMs");
      expect(await page.page.$eval("#user", node => (node as HTMLInputElement).value)).toBe("");
    }
  });

  it("replay 的低截止预算生成不可重试台账，并停止后续输入", async () => {
    const path = await save("replay-low-budget", [{ action: "sleep", ms: 500 }, { action: "fill", target: css("#user"), value: "late" }]);
    const result = await call("replay", { tracePath: path, stepTimeoutMs: 100 });
    expect(output(result)).toContain("timeout");
    expect(lastRunByTrace.get(path)).toMatchObject({ ok: false, healRequired: false, failure: { kind: "timeout", retryBlocked: true } });
    expect(await page.page.$eval("#user", node => (node as HTMLInputElement).value)).toBe("");
  });

  it("每步预算允许普通长 trace 成功，不被误用为整条预算", async () => {
    const path = await save("per-step", [{ action: "sleep", ms: 600 }, { action: "sleep", ms: 600 }]);
    const result = await call("replay", { tracePath: path, stepTimeoutMs: 1000 });
    expect(output(result)).toContain("回放成功");
    expect(lastRunByTrace.get(path)?.steps).toHaveLength(2);
  });
});


const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function holdPrepare(handle: PageHandle): { release(): void; sent: string[] } {
  const send = handle.cdp.send.bind(handle.cdp);
  let release!: () => void;
  let held = false;
  const sent: string[] = [];
  vi.spyOn(handle.cdp, "send").mockImplementation((async (method: string, params: any) => {
    sent.push(method);
    if (method === "Network.enable" && !held) {
      held = true;
      await new Promise<void>(resolve => { release = resolve; });
    }
    return send(method as any, params);
  }) as any);
  return { release: () => release?.(), sent };
}

describe("执行前准备阶段截止", () => {
  it.each(["batch", "replay"] as const)("%s 准备挂起两秒后返回，迟到结果不继续启用域或执行步骤", async name => {
    const path = await save("prepare-" + name, [{ action: "fill", target: css("#user"), value: "late-prepare" }]);
    const gate = holdPrepare(page);
    const t0 = Date.now();
    const pending = call(name, name === "batch"
      ? { steps: [{ action: "fill", target: css("#user"), value: "late-prepare" }] }
      : { tracePath: path });
    try {
      const result = await Promise.race([pending, pause(2600).then(() => undefined)]);
      expect(result).toBeDefined();
      expect(Date.now() - t0).toBeLessThan(2600);
      expect(output(result)).toMatch(/准备.*超时|timeout/);
      if (name === "batch") expect(result?.isError).toBe(true);
      else expect(lastRunByTrace.get(path)).toMatchObject({ steps: [], ok: false, healRequired: false,
        failure: { kind: "timeout", retryBlocked: true, snapshot: expect.stringMatching(/准备.*无法|无法.*快照/) } });
    } finally { gate.release(); await pending; }
    await pause(30);
    expect(gate.sent).not.toContain("Log.enable");
    expect(await page.page.$eval("#user", node => (node as HTMLInputElement).value)).toBe("");
  });

  it("suite 准备超时只失败该条、不尝试第二次，其余隔离页继续完成", async () => {
    const bad = await save("suite-prepare-bad", [{ action: "sleep", ms: 1 }]);
    const good = await save("suite-prepare-good", [{ action: "sleep", ms: 1 }]);
    const original = session.newIsolatedPage.bind(session);
    let gate: ReturnType<typeof holdPrepare> | undefined;
    let resources = 0;
    vi.spyOn(session, "newIsolatedPage").mockImplementation(async slot => {
      const resource = await original(slot);
      if (++resources === 1) gate = holdPrepare(resource.handle);
      return resource;
    });
    const pending = runSuite({ session, paths: [bad, good], vars: {}, concurrency: 1, runsDir: join(dir, "suite-prepare-runs") });
    try {
      const result = await Promise.race([pending, pause(3000).then(() => undefined)]);
      expect(result).toBeDefined();
      expect(result?.results[0]).toMatchObject({ ok: false, attempts: 1,
        record: { steps: [], healRequired: false, failure: { kind: "timeout", retryBlocked: true } } });
      expect(result?.results[1].ok).toBe(true);
      expect(resources).toBe(2);
    } finally { gate?.release(); await pending; }
  });

  it("自愈验证准备超时不写回且不消耗预算", async () => {
    const path = await save("heal-prepare", [{ action: "sleep", ms: 1 }]);
    const trace: Trace = JSON.parse(await readFile(path, "utf8"));
    const before = await readFile(path, "utf8");
    const original = session.newIsolatedPage.bind(session);
    let gate: ReturnType<typeof holdPrepare> | undefined;
    vi.spyOn(session, "newIsolatedPage").mockImplementation(async slot => {
      const resource = await original(slot); gate = holdPrepare(resource.handle); return resource;
    });
    const pending = runMultiHeal({ session, tracePath: path, trace,
      repairs: [{ stepIndex: 0, steps: [{ action: "sleep", ms: 1 }] }], vars: {}, dryRun: false });
    try {
      const outcome = await Promise.race([pending, pause(2600).then(() => undefined)]);
      expect(outcome).toMatchObject({ status: "validation-failed" });
      if (outcome?.status === "validation-failed") {
        expect(outcome.validation).toMatchObject({ steps: [], healRequired: false, failure: { kind: "timeout", retryBlocked: true } });
        expect(validationCountsAgainstBudget(outcome.validation)).toBe(false);
      }
      expect(await readFile(path, "utf8")).toBe(before);
    } finally { gate?.release(); await pending; }
  });
});

it("slowMo 的插入暂停也受截止约束，失败索引仍指向下一真实步", async () => {
  const path = await save("slow-mo-budget", [{ action: "sleep", ms: 1 }, { action: "fill", target: css("#user"), value: "late-slow-mo" }]);
  const result = await call("replay", { tracePath: path, slowMoMs: 500, stepTimeoutMs: 100 });
  const record = lastRunByTrace.get(path);
  expect(output(result)).toContain("timeout");
  expect(record?.steps.map(step => step.index)).toEqual([0]);
  expect(record?.failure).toMatchObject({ failedIndex: 1, failedStep: { action: "fill" }, retryBlocked: true });
  expect(await page.page.$eval("#user", node => (node as HTMLInputElement).value)).toBe("");
});

it("suite 传入的步骤截止超时禁止第二次尝试，并保持其他用例成功", async () => {
  const bad = await save("suite-step-bad", [{ action: "sleep", ms: 500 }]);
  const good = await save("suite-step-good", [{ action: "sleep", ms: 1 }]);
  const result = await call("replay_suite", { tracePaths: [bad, good], concurrency: 1, stepTimeoutMs: 100 });
  expect(output(result)).toContain("SUITE_RESULT ok=1 failed=1 total=2");
  expect(lastRunByTrace.get(bad)).toMatchObject({ ok: false, healRequired: false, failure: { kind: "timeout", retryBlocked: true } });
  expect(output(result)).not.toContain("重试通过");
});

it.each(["demo", "validation"] as const)("heal 的 %s 低步骤预算失败不写回且保留已有预算", async stage => {
  const path = await save("heal-step-" + stage, [{ action: "click", target: css("#missing-original") }]);
  await call("replay", { tracePath: path, resolveRetryMs: 0 });
  const before = await readFile(path, "utf8");
  const budget = { perStep: new Map([[0, 1]]), total: 1 };
  healBudgets.set(path, budget);
  const replacement = [{ action: "sleep", ms: 500 }];
  const result = await call("heal_step", { tracePath: path, stepTimeoutMs: 100,
    ...(stage === "demo" ? { actions: replacement } : { repairs: [{ stepIndex: 0, steps: replacement }] }) });
  expect(result.isError, output(result)).toBe(true);
  expect(output(result)).toContain("timeout");
  expect(await readFile(path, "utf8")).toBe(before);
  expect(healBudgets.get(path)).toEqual({ perStep: new Map([[0, 1]]), total: 1 });
});

it("采集与认证注入共享准备预算，迟到启用结果不会写入 cookie", async () => {
  const path = await save("prepare-auth", [{ action: "sleep", ms: 1 }]);
  const authPath = join(dir, "prepare-auth-state.json");
  await writeFile(authPath, JSON.stringify({ cookies: [{ name: "r18_cookie", value: "private-cookie", domain: "127.0.0.1", path: "/" }], origins: [], savedAt: "" }));
  const send = page.cdp.send.bind(page.cdp);
  let count = 0;
  const sent: string[] = [];
  vi.spyOn(page.cdp, "send").mockImplementation((async (method: string, params: any) => {
    sent.push(method);
    if ((method === "Network.enable" || method === "Log.enable") && ++count <= 3) await pause(750);
    return send(method as any, params);
  }) as any);
  const t0 = Date.now();
  const result = await call("replay", { tracePath: path, auth: authPath });
  expect(Date.now() - t0).toBeLessThan(2700);
  expect(lastRunByTrace.get(path)).toMatchObject({ steps: [], failure: { kind: "timeout", retryBlocked: true } });
  expect(output(result)).not.toContain("private-cookie");
  await pause(350);
  expect(sent).not.toContain("Network.setCookies");
  expect((await page.page.cookies()).some(cookie => cookie.name === "r18_cookie")).toBe(false);
});

it("失败后的元信息挂起保留原失败类型，返回最后已知身份", async () => {
  const send = page.cdp.send.bind(page.cdp);
  vi.spyOn(page.cdp, "send").mockImplementation((async (method: string, params: any) => {
    if (method === "Target.getTargetInfo") return new Promise(() => {});
    return send(method as any, params);
  }) as any);
  const result = await call("batch", { steps: [{ action: "click", target: css("#missing") }], resolveRetryMs: 0 });
  expect(result.isError).toBe(true);
  expect(output(result)).toContain("target-not-found");
  expect(output(result)).toContain("最后已知 URL");
  expect(output(result)).not.toContain("失败：timeout");
});


it("replay 冷页初始化截止也归档为空步骤的不可重试准备失败", async () => {
  const path = await save("cold-replay-timeout", [{ action: "sleep", ms: 1 }]);
  vi.spyOn(session, "getPage").mockRejectedValue(new PageInitializationDeadlineError(100, "页面"));
  const result = await call("replay", { tracePath: path });
  expect(output(result)).toContain("timeout");
  expect(lastRunByTrace.get(path)).toMatchObject({ steps: [], ok: false, healRequired: false,
    failure: { kind: "timeout", retryBlocked: true } });
});

it("suite 创建页初始化截止生成失败台账并禁止第二次尝试", async () => {
  const path = await save("cold-suite-timeout", [{ action: "sleep", ms: 1 }]);
  vi.spyOn(session, "newIsolatedPage").mockRejectedValue(new PageInitializationDeadlineError(100, "隔离页"));
  const result = await runSuite({ session, paths: [path], vars: {}, concurrency: 1, runsDir: join(dir, "cold-suite-runs") });
  expect(result.results[0]).toMatchObject({ attempts: 1, record: { steps: [], healRequired: false,
    failure: { kind: "timeout", retryBlocked: true } } });
});

it("replay 普通失败的归档截图挂起有界，保留原 target-not-found 台账", async () => {
  const path = await save("failure-screenshot-hang", [{ action: "click", target: css("#missing") }]);
  const send = page.cdp.send.bind(page.cdp);
  let release!: () => void;
  vi.spyOn(page.cdp, "send").mockImplementation((async (method: string, params: any) => {
    if (method === "Page.captureScreenshot") await new Promise<void>(resolve => { release = resolve; });
    return send(method as any, params);
  }) as any);
  const pending = call("replay", { tracePath: path, resolveRetryMs: 0 });
  try {
    const result = await Promise.race([pending, pause(3000).then(() => undefined)]);
    expect(result).toBeDefined();
    expect(output(result)).toContain("target-not-found");
    expect(lastRunByTrace.get(path)).toMatchObject({ healRequired: false,
      failure: { kind: "target-not-found", retryBlocked: true, message: expect.stringContaining("截图无法获取") } });
  } finally { release?.(); await pending; }
});

it.each(["suite", "heal"] as const)("%s 准备失败的最后已知 URL 隐藏显式变量值", async mode => {
  const secret = "r18-preparation-private-token";
  const path = await save("prepare-privacy-" + mode, [{ action: "sleep", ms: 1 }]);
  const trace: Trace = JSON.parse(await readFile(path, "utf8"));
  const original = session.newIsolatedPage.bind(session);
  let gate: ReturnType<typeof holdPrepare> | undefined;
  vi.spyOn(session, "newIsolatedPage").mockImplementation(async slot => {
    const resource = await original(slot);
    await resource.handle.page.goto(inject("fixtureURL") + "/form.html?opaque=" + secret);
    gate = holdPrepare(resource.handle);
    return resource;
  });
  const pending = mode === "suite"
    ? runSuite({ session, paths: [path], vars: { TOKEN: secret }, concurrency: 1, runsDir: join(dir, "privacy-runs") })
        .then(result => result.results[0].record)
    : runMultiHeal({ session, tracePath: path, trace, repairs: [{ stepIndex: 0, steps: [{ action: "sleep", ms: 1 }] }], vars: { TOKEN: secret }, dryRun: false })
        .then(outcome => outcome.status === "validation-failed" ? outcome.validation : undefined);
  try {
    const record = await pending;
    expect(record?.failure?.kind).toBe("timeout");
    expect(record?.failure?.currentUrl).not.toContain(secret);
    expect(record?.failure?.currentUrl).toContain("${TOKEN}");
  } finally { gate?.release(); await pending; }
});

it("heal 验证的普通定位失败若 AX 收尾超时，保留原错且不计预算", async () => {
  const path = await save("heal-ax-timeout", [{ action: "click", target: css("#missing-original") }]);
  await call("replay", { tracePath: path, resolveRetryMs: 0 });
  const before = await readFile(path, "utf8");
  healBudgets.set(path, { perStep: new Map([[0, 1]]), total: 1 });
  const original = session.newIsolatedPage.bind(session);
  let release!: () => void;
  vi.spyOn(session, "newIsolatedPage").mockImplementation(async slot => {
    const resource = await original(slot);
    const send = resource.handle.cdp.send.bind(resource.handle.cdp);
    vi.spyOn(resource.handle.cdp, "send").mockImplementation((async (method: string, params: any) => {
      if (method === "Accessibility.getFullAXTree") await new Promise<void>(resolve => { release = resolve; });
      return send(method as any, params);
    }) as any);
    return resource;
  });
  const pending = call("heal_step", { tracePath: path, repairs: [{ stepIndex: 0,
    steps: [{ action: "click", target: css("#missing-replacement") }] }] });
  try {
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(output(result)).toContain("target-not-found");
    expect(output(result)).toContain("未计自愈次数");
    expect(output(result)).toContain("heal_required=false");
    expect(healBudgets.get(path)).toEqual({ perStep: new Map([[0, 1]]), total: 1 });
    expect(await readFile(path, "utf8")).toBe(before);
  } finally { release?.(); await pending; }
});
