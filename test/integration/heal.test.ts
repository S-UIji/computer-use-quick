import { describe, it, expect, beforeAll, afterAll, afterEach, inject } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { NetworkTracker } from "../../src/waiter/stability.js";
import { DiagnosticsCollector } from "../../src/diagnostics/collector.js";
import { takeSnapshot } from "../../src/perception/snapshot.js";
import { replayTrace } from "../../src/trace/replay.js";
import { runHeal } from "../../src/trace/heal.js";
import { saveTrace, loadTrace, readHealRecords } from "../../src/trace/store.js";
import type { Trace } from "../../src/types.js";

let session: BrowserSession;
const fx = { url: "" };
let tracker: NetworkTracker, collector: DiagnosticsCollector;

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "cuq-heal-it-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

beforeAll(async () => {
  fx.url = inject("fixtureURL");
  session = await BrowserSession.connect(inject("browserURL"));
  const h = await session.getPage();
  tracker = await NetworkTracker.attach(h);
  collector = await DiagnosticsCollector.attach(h);
});
afterAll(async () => { await session?.close(); });

async function open(path: string): Promise<PageHandle> {
  const h = await session.getPage();
  await h.page.goto(`${fx.url}/${path}`, { waitUntil: "load" });
  return h;
}

/** 点不到的按钮：role-name 策略在 cards-v1 上必然 target-not-found */
function brokenTrace(name: string): Trace {
  return {
    name, baseUrl: fx.url, createdAt: "2026-09-21T00:00:00.000Z",
    steps: [
      { action: "navigate", url: "/cards-v1.html" },
      { action: "click", target: { descriptor: {
        strategies: [{ kind: "role-name", role: "button", name: "不存在的按钮" }],
        framePath: []
      } } },
      { action: "assert", type: "text-equals",
        target: { descriptor: {
          strategies: [{ kind: "css", value: "#clicked" }], framePath: []
        } },
        expected: "教育事业群 · 查看在岗干部明细" }
    ]
  };
}

/** 在失败页面上找「查看在岗干部明细」第一个按钮的 ref（模拟模型 snapshot 后选目标） */
async function refOfFirstDetailButton(): Promise<{ ref: string; refs: Map<string, number> }> {
  const snap = await takeSnapshot(await session.getPage(), { threshold: 99 });
  const line = snap.text.split("\n").filter((l) => l.includes("查看在岗干部明细"))[0];
  return { ref: line.match(/\[(e\d+)\]/)![1], refs: snap.refs };
}

describe("自愈闭环（heal_step 编排）", () => {
  it("replay 失败 → 演示修复 → 验证门 → 写回 → 再 replay 全绿", async () => {
    const d = await tmp();
    const tracePath = await saveTrace(d, brokenTrace("heal-happy"));
    const trace = await loadTrace(tracePath);
    const handle = await open("cards-v1.html");

    // 1. replay 在点不到的按钮上失败
    const rec = await replayTrace({ handle, tracker, collector, trace, vars: {} });
    expect(rec.ok).toBe(false);
    expect(rec.failure?.kind).toBe("target-not-found");
    expect(rec.failure?.failedIndex).toBe(1);
    expect(rec.healRequired).toBe(true);

    // 2. 模型在失败页面上 snapshot，找到正确按钮的 ref，演示修复
    const { ref, refs } = await refOfFirstDetailButton();
    const tabsBefore = (await session.listPages()).length;
    const outcome = await runHeal({
      session, handle, tracker, collector, refs,
      tracePath, trace, stepIndex: 1,
      demoSteps: [{ action: "click", target: { ref } }],
      vars: {}, dryRun: false
    });

    // 3. 验证门通过、已写回
    expect(outcome.status).toBe("healed");
    if (outcome.status !== "healed") return;
    expect(outcome.validation.ok).toBe(true);

    const healed = await loadTrace(tracePath);
    expect(healed.steps).toHaveLength(3);
    const fixed = healed.steps[1] as { target: { descriptor: { strategies: Array<{ kind: string; value?: string }> } } };
    expect(fixed.target.descriptor.strategies[0].kind).toBe("test-id");
    expect(fixed.target.descriptor.strategies[0].value).toBe("detail-edu");
    expect(healed.steps[2]).toEqual(trace.steps[2]);

    // 4. sidecar 留档可审计
    const records = await readHealRecords(tracePath);
    expect(records).toHaveLength(1);
    expect(records[0].stepIndex).toBe(1);
    expect((records[0].originalStep as { target?: unknown }).target).toBeDefined();

    // 5. 验证标签页已关闭，不留垃圾
    expect((await session.listPages()).length).toBe(tabsBefore);

    // 6. 再 replay 全绿
    const rerun = await replayTrace({ handle, tracker, collector, trace: healed, vars: {} });
    expect(rerun.ok).toBe(true);
    expect(rerun.failure).toBeUndefined();
  });

  it("演示步本身失败时返回失败上下文，不写回", async () => {
    const d = await tmp();
    const tracePath = await saveTrace(d, brokenTrace("heal-demo-fail"));
    const trace = await loadTrace(tracePath);
    const handle = await open("cards-v1.html");

    await replayTrace({ handle, tracker, collector, trace, vars: {} });
    const before = await readFile(tracePath, "utf8");

    const outcome = await runHeal({
      session, handle, tracker, collector,
      refs: new Map([["e404", 404]]),
      tracePath, trace, stepIndex: 1,
      demoSteps: [{ action: "click", target: { ref: "e404" } }],
      vars: {}, dryRun: false
    });

    expect(outcome.status).toBe("demo-failed");
    if (outcome.status === "demo-failed") {
      // 伪造的 backendNodeId 会走不通解析/执行链路，具体归类取决于在哪一层失败；
      // 关键承诺是：失败上下文一次性给全、不写回
      expect(outcome.failure.message).toBeTruthy();
      expect(outcome.failure.snapshot).toBeTruthy();
    }
    expect(await readFile(tracePath, "utf8")).toBe(before);
    expect(await readHealRecords(tracePath)).toEqual([]);
  });

  it("验证门失败时不写回，返回新失败上下文", async () => {
    const d = await tmp();
    // 修复演示点的是第二张卡（技术平台中心），但断言期望第一张卡的文案 → 验证门必挂
    const t = brokenTrace("heal-validation-fail");
    (t.steps[2] as { expected: string }).expected = "教育事业群 · 查看在岗干部明细";
    const tracePath = await saveTrace(d, t);
    const trace = await loadTrace(tracePath);
    const handle = await open("cards-v1.html");

    await replayTrace({ handle, tracker, collector, trace, vars: {} });
    const snap = await takeSnapshot(await session.getPage(), { threshold: 99 });
    // 第二个「查看在岗干部明细」按钮 → 技术平台中心
    const line = snap.text.split("\n").filter((l) => l.includes("查看在岗干部明细"))[1];
    const ref = line.match(/\[(e\d+)\]/)![1];

    const outcome = await runHeal({
      session, handle, tracker, collector, refs: snap.refs,
      tracePath, trace, stepIndex: 1,
      demoSteps: [{ action: "click", target: { ref } }],
      vars: {}, dryRun: false
    });

    expect(outcome.status).toBe("validation-failed");
    if (outcome.status === "validation-failed") {
      expect(outcome.validation.ok).toBe(false);
      expect(outcome.validation.failure?.kind).toBe("assert-failed");
    }
    // 磁盘上仍是原 trace（失败后预算记账在 server 层，这里只验证不写回）
    const onDisk = await loadTrace(tracePath);
    expect(onDisk.steps[1]).toEqual(trace.steps[1]);
  });
});

describe("dryRun（任务 4.3）", () => {
  it("验证通过但不写回、不留 sidecar", async () => {
    const d = await tmp();
    const tracePath = await saveTrace(d, brokenTrace("heal-dryrun"));
    const trace = await loadTrace(tracePath);
    const handle = await open("cards-v1.html");

    await replayTrace({ handle, tracker, collector, trace, vars: {} });
    const before = await readFile(tracePath, "utf8");
    const { ref, refs } = await refOfFirstDetailButton();

    const outcome = await runHeal({
      session, handle, tracker, collector, refs,
      tracePath, trace, stepIndex: 1,
      demoSteps: [{ action: "click", target: { ref } }],
      vars: {}, dryRun: true
    });

    expect(outcome.status).toBe("healed");
    if (outcome.status === "healed") {
      expect(outcome.dryRun).toBe(true);
      expect(outcome.validation.ok).toBe(true);
    }
    expect(await readFile(tracePath, "utf8")).toBe(before);
    expect(await readHealRecords(tracePath)).toEqual([]);
  });
});
