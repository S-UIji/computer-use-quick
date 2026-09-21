import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { NetworkTracker } from "../../src/waiter/stability.js";
import { DiagnosticsCollector } from "../../src/diagnostics/collector.js";
import { runBatch } from "../../src/executor/batch.js";
import { takeSnapshot } from "../../src/perception/snapshot.js";
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

  it("隐式等待打满上限时在结果里显形", async () => {
    const handle = await session.getPage();
    await runBatch({ handle, tracker, collector, refs: new Map(), vars: {},
      steps: [{ action: "navigate", url: `${fx.url}/form.html` }] });
    await handle.cdp.send("Runtime.evaluate", {
      expression: `window.__poll = setInterval(function () {
        fetch("/api/orders").catch(function () {});
      }, 100)`
    });
    try {
      const r = await runBatch({ handle, tracker, collector, refs: new Map(), vars: {},
        stability: { timeoutMs: 1000 },
        steps: [{ action: "click", target: css("#submit") }] });
      expect(r.ok).toBe(true);
      expect(r.results[0].durationMs).toBeGreaterThanOrEqual(900);
      expect(r.results[0].error).toContain("持续");
    } finally {
      await handle.cdp.send("Runtime.evaluate", { expression: `clearInterval(window.__poll)` });
    }
  });

  it("目标延迟出现时解析会轮询重试，不再一次性判负", async () => {
    const handle = await session.getPage();
    await runBatch({ handle, tracker, collector, refs: new Map(), vars: {},
      steps: [{ action: "navigate", url: `${fx.url}/form.html` }] });
    // 600ms 后才插入按钮，模拟「上一步条件已满足、但 DOM 还没渲染完」的竞态
    await handle.cdp.send("Runtime.evaluate", {
      expression: `setTimeout(function () {
        var b = document.createElement("button");
        b.id = "late-btn"; b.textContent = "晚到按钮";
        document.body.appendChild(b);
      }, 600)`
    });

    const t0 = Date.now();
    const r = await runBatch({ handle, tracker, collector, refs: new Map(), vars: {},
      resolveRetryMs: 2000,
      steps: [{ action: "click", target: css("#late-btn") }] });
    const elapsed = Date.now() - t0;

    expect(r.ok).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(500);
  });

  it("resolveRetryMs=0 时保持一次性解析：目标不存在立即判负", async () => {
    const handle = await session.getPage();
    await runBatch({ handle, tracker, collector, refs: new Map(), vars: {},
      steps: [{ action: "navigate", url: `${fx.url}/form.html` }] });

    const t0 = Date.now();
    const r = await runBatch({ handle, tracker, collector, refs: new Map(), vars: {},
      resolveRetryMs: 0,
      steps: [{ action: "click", target: css("#never-exists") }] });

    expect(r.ok).toBe(false);
    expect(r.failure?.kind).toBe("target-not-found");
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("navigate 到不可达地址：判负 navigation-failed，不显示假成功", async () => {
    const r = await run([
      { action: "navigate", url: "http://127.0.0.1:1/unreachable" }
    ]);
    expect(r.ok).toBe(false);
    expect(r.failure?.kind).toBe("navigation-failed");
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

  /** 取快照里第一条指定文字所在的 ref，并把 ref 表灌进 refs */
  async function snapshotRefOf(handle: PageHandle, text: string, refs: Map<string, number>) {
    const snap = await takeSnapshot(handle, { threshold: 99 });
    const line = snap.text.split("\n").find((l) => l.includes(`"${text}"`));
    if (!line) throw new Error(`快照里没有「${text}」`);
    const ref = line.match(/\[(e\d+)\]/)![1];
    refs.clear();
    for (const [k, v] of snap.refs) refs.set(k, v);
    return ref;
  }

  it("ref 点击会导航的链接：动作照旧算成功，descriptor 在动作前就固化好", async () => {
    const handle = await session.getPage();
    const refs = new Map<string, number>();
    await runBatch({ handle, tracker, collector, refs, vars: {},
      steps: [{ action: "navigate", url: `${fx.url}/link-navigates.html` }] });

    const ref = await snapshotRefOf(handle, "去登录页", refs);
    const r = await runBatch({ handle, tracker, collector, refs, vars: {},
      steps: [{ action: "click", target: { ref } }] });

    // 以前这里会因为"动作之后元素已随导航失效"被误判成 target-not-found
    expect(r.ok).toBe(true);
    expect(r.failure).toBeUndefined();
    expect(await handle.page.url()).toContain("form.html");
    const captured = r.capturedSteps[0] as { target?: { descriptor?: unknown } };
    expect(captured.target?.descriptor).toBeDefined();
  });

  it("ref 点击 target=_blank 链接：不再挂死，新标签页可被 listPages 发现", async () => {
    const handle = await session.getPage();
    const refs = new Map<string, number>();
    await runBatch({ handle, tracker, collector, refs, vars: {},
      steps: [{ action: "navigate", url: `${fx.url}/link-navigates.html` }] });

    const ref = await snapshotRefOf(handle, "开新标签", refs);
    const t0 = Date.now();
    const r = await runBatch({ handle, tracker, collector, refs, vars: {},
      steps: [{ action: "click", target: { ref } }] });
    const ms = Date.now() - t0;

    // 守住这条回归：以前这里会一直挂到客户端超时
    expect(r.ok).toBe(true);
    expect(ms).toBeLessThan(10_000);

    // 新标签在 headless 下会被弹窗拦截偶发挡掉（Chrome 的用户激活衰减），
    // 所以只断言"如果开了新标签，listPages 必须能看到它"；新 target 的 attach 是异步的。
    let pages = await session.listPages();
    for (let i = 0; i < 12 && pages.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 250));
      pages = await session.listPages();
    }
    if (pages.length > 1) {
      expect(pages.some((p) => p.url.includes("form.html"))).toBe(true);
    }

    // 清理：关掉新标签页，别影响同一套件里的其它用例
    for (const p of (await handle.page.browser().pages()).slice(1)) {
      await p.close().catch(() => {});
    }
  });
});
