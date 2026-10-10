import { describe, it, expect, beforeAll, afterAll, afterEach, inject, vi } from "vitest";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { NetworkTracker } from "../../src/waiter/stability.js";
import { DiagnosticsCollector } from "../../src/diagnostics/collector.js";
import { runBatch } from "../../src/executor/batch.js";
import { RunWatch } from "../../src/watch/runWatch.js";
import { ProgressReporter } from "../../src/watch/progress.js";
import { renderBadgeText, removeOverlay } from "../../src/watch/overlay.js";
import type { Descriptor, Step } from "../../src/types.js";

let session: BrowserSession;
let handle: PageHandle;
let tracker: NetworkTracker, collector: DiagnosticsCollector;
const fx = { url: "" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  fx.url = inject("fixtureURL");
  session = await BrowserSession.connect(inject("browserURL"));
  handle = await session.getPage();
  tracker = await NetworkTracker.attach(handle);
  collector = await DiagnosticsCollector.attach(handle);
});
afterAll(async () => { await session?.close(); });
afterEach(async () => { await removeOverlay(handle); });

const css = (value: string): { descriptor: Descriptor } => ({
  descriptor: { strategies: [{ kind: "css", value }], framePath: [] }
});

async function evalValue<T>(expression: string): Promise<T> {
  const { result } = (await handle.cdp.send("Runtime.evaluate", { expression, returnByValue: true })) as {
    result: { value: T };
  };
  return result.value;
}

/** 轮询角标文字直到包含 match。 */
async function pollBadge(match: string, ms = 5000): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const t = await evalValue<string | null>(`window.__cuqOverlay ? window.__cuqOverlay.badge.textContent : null`);
    if (t && t.includes(match)) return t;
    if (Date.now() - t0 > ms) throw new Error(`角标未出现「${match}」，最后为 ${t}`);
    await sleep(50);
  }
}

async function rawClick(x: number, y: number): Promise<void> {
  for (const type of ["mousePressed", "mouseReleased"] as const) {
    await handle.cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  }
}

const run = (steps: Step[], observer: RunWatch) =>
  runBatch({ handle, tracker, collector, refs: new Map(), vars: {}, steps, observer });

describe("RunWatch（观察模式组装）", () => {
  it("执行中角标显示进度，结束退回待命", async () => {
    const p = run([
      { action: "navigate", url: `${fx.url}/watch.html?late=2500` },
      { action: "wait", until: { type: "visible", target: css("#late") }, timeout: 8000 }
    ], new RunWatch({ handle, label: "探索", watch: true }));

    expect(await pollBadge("2/2")).toContain("详情");
    expect(await evalValue<string>(`window.__cuqOverlay.details.textContent`)).toContain("探索");
    expect(await evalValue<string>(`window.__cuqOverlay.details.textContent`)).toContain("等待");
    expect(await evalValue<string>(`window.__cuqOverlay.wrap.getAttribute("data-state")`)).toBe("active");
    expect((await p).ok).toBe(true);
    expect(await evalValue<string>(`window.__cuqOverlay.badge.textContent`)).toBe(renderBadgeText({ kind: "idle" }));
  });

  it("执行期间的真实用户点击：在步骤边界停下并标为 user-interrupted", async () => {
    const p = run([
      { action: "navigate", url: `${fx.url}/watch.html?late=2500` },
      { action: "wait", until: { type: "visible", target: css("#late") }, timeout: 8000 },
      { action: "fill", target: css("#name"), value: "不该被填" }
    ], new RunWatch({ handle, label: "探索", watch: true }));

    await pollBadge("2/3");
    await rawClick(300, 400);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.failure?.kind).toBe("user-interrupted");
    expect(r.failure?.failedIndex).toBe(2);
    expect(await evalValue<string>(`document.getElementById("name").value`)).toBe("");
    expect(await evalValue<string>(`window.__cuqOverlay.wrap.getAttribute("data-state")`)).toBe("interrupted");
  });

  it("零误报：agent 自己的点击/填写/按键/选择/悬停/滚动都不触发介入", async () => {
    const r = await run([
      { action: "navigate", url: `${fx.url}/form.html` },
      { action: "click", target: css("#user") },
      { action: "fill", target: css("#user"), value: "admin" },
      { action: "press", key: "Tab" },
      { action: "select", target: css("#region"), value: "hf" },
      { action: "hover", target: css("#submit") },
      { action: "scroll", direction: "down", amount: 100 },
      { action: "click", target: css("#submit") },
      { action: "assert", type: "text-equals", target: css("#result"), expected: "欢迎 admin" }
    ], new RunWatch({ handle, label: "探索", watch: true }));

    expect(r.ok).toBe(true);
    expect(r.failure).toBeUndefined();
    expect(r.results.map((s) => s.error ?? "").join("")).not.toMatch(/用户操作|用户滚动|用户介入/);
    expect(r.results.find((s) => s.action === "scroll")?.error).toContain("前台滚动");
  });

  it("零误报：iframe 内点击与打开新标签的点击", async () => {
    const r1 = await run([
      { action: "navigate", url: `${fx.url}/iframe-wall.html` },
      { action: "sleep", ms: 300 },
      { action: "click", target: { descriptor: {
        strategies: [{ kind: "text", tag: "a", text: "帮助文档" }], framePath: ["iframe-wall-inner.html"]
      } } }
    ], new RunWatch({ handle, label: "探索", watch: true }));
    const r2 = await run([
      { action: "navigate", url: `${fx.url}/link-navigates.html` },
      { action: "click", target: css("#pop") },
      { action: "click", target: css("#noop") }
    ], new RunWatch({ handle, label: "探索", watch: true }));

    // 关掉 target=_blank 可能开出的新标签，别影响后续用例
    for (const pg of await handle.page.browser().pages()) {
      if (pg !== handle.page) await pg.close();
    }
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect([...r1.results, ...r2.results].map((s) => s.error ?? "").join("")).not.toMatch(/用户/);
  });

  it("未启用时完全不碰页面", async () => {
    await handle.page.goto(`${fx.url}/form.html`, { waitUntil: "load" });
    const watch = new RunWatch({ handle, label: "探索", watch: false });
    const r = await run([{ action: "fill", target: css("#user"), value: "x" }], watch);
    expect(r.ok).toBe(true);
    expect(watch.inputGate).toBeUndefined();
    expect(await evalValue<boolean>(
      `document.querySelector("cuq-overlay") === null && window.__cuqInputListener === undefined`
    )).toBe(true);
  });

  it("步骤级进度：每步一条，progress 递增、说明带步号", async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const progress = ProgressReporter.from({ _meta: { progressToken: "t1" }, sendNotification });
    await run([
      { action: "navigate", url: `${fx.url}/form.html` },
      { action: "fill", target: css("#user"), value: "x" }
    ], new RunWatch({ handle, label: "探索", watch: false, progress, progressPrefix: "demo · " }));

    const params = sendNotification.mock.calls.map((c) => c[0].params);
    expect(params.map(({ progressToken, progress, total }) => ({ progressToken, progress, total }))).toEqual([
      { progressToken: "t1", progress: 1, total: 2 },
      { progressToken: "t1", progress: 2, total: 2 }
    ]);
    expect(params[0].message).toContain("导航到");
    expect(params[0].message).toContain("/form.html");
    expect(params[1].message).toContain("填写「#user」");
  });
});
