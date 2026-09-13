import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { NetworkTracker } from "../../src/waiter/stability.js";
import { DiagnosticsCollector } from "../../src/diagnostics/collector.js";
import { runBatch } from "../../src/executor/batch.js";
import type { Descriptor, Step } from "../../src/types.js";

let session: BrowserSession;
const fx = { url: "" };
let tracker: NetworkTracker, collector: DiagnosticsCollector;

beforeAll(async () => {
  fx.url = inject("fixtureURL");
  session = await BrowserSession.connect(inject("browserURL"));
  const h = await session.getPage();
  tracker = await NetworkTracker.attach(h);
  collector = await DiagnosticsCollector.attach(h);
});
afterAll(async () => { await session?.close(); });

const css = (value: string): { descriptor: Descriptor } => ({
  descriptor: { strategies: [{ kind: "css", value }], framePath: [] }
});

async function run(steps: Step[], vars: Record<string, string> = {}) {
  const handle: PageHandle = await session.getPage();
  return runBatch({ handle, tracker, collector, refs: new Map(), vars, steps });
}

describe("runBatch", () => {
  it("一次调用完成完整登录流程", async () => {
    const r = await run([
      { action: "navigate", url: `${fx.url}/form.html` },
      { action: "fill", target: css("#user"), value: "${USER}" },
      { action: "fill", target: css("#pwd"), value: "${PWD}" },
      { action: "click", target: css("#submit") },
      { action: "assert", type: "text-contains", target: css("#result"), expected: "欢迎 ${USER}" }
    ], { USER: "admin", PWD: "secret" });

    expect(r.ok).toBe(true);
    expect(r.results).toHaveLength(5);
    expect(r.results.every((s) => s.ok)).toBe(true);
  });

  it("fail-fast：失败步之后的步骤不执行", async () => {
    const r = await run([
      { action: "navigate", url: `${fx.url}/form.html` },
      { action: "click", target: css("#nonexistent") },
      { action: "click", target: css("#submit") }
    ]);

    expect(r.ok).toBe(false);
    expect(r.results).toHaveLength(2);
    expect(r.failure?.failedIndex).toBe(1);
  });

  it("失败上下文一次给全：类型、快照、console、网络", async () => {
    const r = await run([
      { action: "navigate", url: `${fx.url}/form.html` },
      { action: "click", target: css("#nonexistent") }
    ]);

    expect(r.failure?.kind).toBe("target-not-found");
    expect(r.failure?.snapshot).toContain("登录");
    expect(r.failure).toHaveProperty("consoleErrors");
    expect(r.failure).toHaveProperty("failedRequests");
  });

  it("断言失败时 kind 是 assert-failed", async () => {
    const r = await run([
      { action: "navigate", url: `${fx.url}/form.html` },
      { action: "assert", type: "text-equals", target: css("#result"), expected: "不可能" }
    ]);
    expect(r.failure?.kind).toBe("assert-failed");
    expect(r.failure?.message).toContain("不可能");
  });

  it("extract 产生的变量可被后续步骤引用", async () => {
    const r = await run([
      { action: "navigate", url: `${fx.url}/form.html` },
      { action: "fill", target: css("#user"), value: "zhangsan" },
      { action: "click", target: css("#submit") },
      { action: "extract", target: css("#result"), as: "GREET" },
      { action: "assert", type: "text-contains", target: css("#result"), expected: "${GREET}" }
    ]);
    expect(r.ok).toBe(true);
    expect(r.vars.GREET).toBe("欢迎 zhangsan");
  });

  it("卡片墙：用容器锚定精确点到第二张卡的按钮", async () => {
    const r = await run([
      { action: "navigate", url: `${fx.url}/cards-no-container.html` },
      { action: "click", target: { descriptor: {
        strategies: [{
          kind: "container-role-name",
          containerText: "技术平台中心", role: "button", name: "查看在岗干部明细"
        }],
        framePath: []
      }}},
      { action: "assert", type: "text-equals", target: css("#clicked"),
        expected: "技术平台中心 · 查看在岗干部明细" }
    ]);
    expect(r.ok).toBe(true);
  });

  it("表格：用行锚定精确点到第三行的删除按钮", async () => {
    const r = await run([
      { action: "navigate", url: `${fx.url}/table-dup.html` },
      { action: "click", target: { descriptor: {
        strategies: [{ kind: "row-role-name", rowText: "ORD20260913", role: "button", name: "删除" }],
        framePath: []
      }}},
      { action: "assert", type: "text-equals", target: css("#deleted"), expected: "已删除 ORD20260913" }
    ]);
    expect(r.ok).toBe(true);
  });

  it("每步都记录耗时", async () => {
    const r = await run([{ action: "navigate", url: `${fx.url}/form.html` }]);
    expect(r.results[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("sleep 步骤在结果里被标记为需要关注", async () => {
    const r = await run([
      { action: "navigate", url: `${fx.url}/form.html` },
      { action: "sleep", ms: 50 }
    ]);
    expect(r.ok).toBe(true);
    expect(r.results[1].error).toContain("sleep");
  });

  it("成功后 refs 被刷新为执行后快照的 ref 表", async () => {
    const handle = await session.getPage();
    const refs = new Map<string, number>();
    const r = await runBatch({
      handle, tracker, collector, refs, vars: {},
      steps: [{ action: "navigate", url: `${fx.url}/form.html` }]
    });
    expect(r.ok).toBe(true);
    expect(refs.size).toBeGreaterThan(0);
  });
});
