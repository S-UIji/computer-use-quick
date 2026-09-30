import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { NetworkTracker } from "../../src/waiter/stability.js";
import { DiagnosticsCollector } from "../../src/diagnostics/collector.js";
import { runBatch, type BatchResult } from "../../src/executor/batch.js";
import { replayTrace } from "../../src/trace/replay.js";
import { takeSnapshot } from "../../src/perception/snapshot.js";
import { DialogGuard } from "../../src/session/dialogs.js";
import type { Step } from "../../src/types.js";

let session: BrowserSession;
const fx = { url: "" };

beforeAll(async () => {
  fx.url = inject("fixtureURL");
  session = await BrowserSession.connect(inject("browserURL"));
});
afterAll(async () => { await session?.close(); });

/** 弹窗没被处理时调用会无限挂住：封顶 5s，挂住就是失败而不是拖满 testTimeout */
function within<T>(p: Promise<T>, ms = 5000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${ms}ms 未返回`)), ms))]);
}

const css = (value: string) => ({ descriptor: { strategies: [{ kind: "css" as const, value }], framePath: [] } });

async function open(page: string): Promise<PageHandle> {
  const handle = await session.getPage();
  await handle.page.goto(`${fx.url}/${page}`, { waitUntil: "load" });
  return handle;
}

async function batch(handle: PageHandle, steps: Step[]): Promise<BatchResult> {
  return within(runBatch({
    handle,
    tracker: await NetworkTracker.attach(handle),
    collector: await DiagnosticsCollector.attach(handle),
    refs: new Map(), vars: {}, steps
  }));
}

const outIs = (text: string): Step => ({ action: "assert", type: "text-equals", target: css("#out"), expected: text });

describe("JS 弹窗不再挂住执行", () => {
  it("点击触发 confirm：立即返回，默认确定并在结果里报告，固化步骤记下处理方式", async () => {
    const handle = await open("dialogs.html");
    const r = await batch(handle, [{ action: "click", target: css("#confirm") }, outIs("confirmed")]);

    expect(r.ok).toBe(true);
    expect(r.results[0].error).toContain("确定删除？");
    expect((r.capturedSteps[0] as { dialog?: string }).dialog).toBe("accept");
  });

  it("步骤写 dialog: dismiss 时取消", async () => {
    const handle = await open("dialogs.html");
    const r = await batch(handle, [
      { action: "click", target: css("#confirm"), dialog: "dismiss" }, outIs("cancelled")
    ]);
    expect(r.ok).toBe(true);
    expect(r.results[0].error).toContain("取消");
  });

  it("prompt：promptText 填入指定文本，省略时用弹窗自带的默认值", async () => {
    const handle = await open("dialogs.html");
    const r = await batch(handle, [
      { action: "click", target: css("#prompt"), promptText: "小王" }, outIs("prompt:小王"),
      { action: "click", target: css("#prompt") }, outIs("prompt:默认名")
    ]);
    expect(r.ok).toBe(true);
  });

  it("navigate 到加载即 alert 的页面：不挂住，也不再误报隐式等待打满", async () => {
    const handle = await session.getPage();
    const r = await batch(handle, [{ action: "navigate", url: `${fx.url}/dialog-onload.html` }]);
    expect(r.ok).toBe(true);
    expect(r.results[0].error).toContain("欢迎回来");
    expect(r.results[0].error).not.toContain("隐式等待");
  });

  it("回放按 trace 里记下的处理方式执行", async () => {
    const handle = await session.getPage();
    const rec = await within(replayTrace({
      handle,
      tracker: await NetworkTracker.attach(handle),
      collector: await DiagnosticsCollector.attach(handle),
      vars: {},
      trace: { name: "dialog-replay", baseUrl: fx.url, createdAt: "", steps: [
        { action: "navigate", url: "/dialogs.html" },
        { action: "click", target: css("#confirm"), dialog: "dismiss" },
        outIs("cancelled")
      ] }
    }));
    expect(rec.ok).toBe(true);
  });

  it("两次调用之间弹出的窗：下次取页时先处理掉，snapshot 不再挂住，处理记录可取出报告", async () => {
    const handle = await open("dialogs.html");
    // 不经 batch 安排 alert：batch 点击后还有稳定性等待，定时器可能在执行期内就触发
    await handle.page.evaluate(() => { setTimeout(() => alert("定时弹窗"), 100); });
    await new Promise((r) => setTimeout(r, 400));

    const again = await within(session.getPage());
    await within(takeSnapshot(again));
    const handled = DialogGuard.for(again)!.takeHandled();
    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({ type: "alert", message: "定时弹窗", pending: true });
  });

  it("接管一个已经开着弹窗的标签页（如用户自己的标签）：list_pages 与取页都不挂住", async () => {
    const base = await session.getPage();
    const other = await base.page.browser().newPage(); // 不经 session：模拟会话外的标签页
    await other.goto(`${fx.url}/dialogs.html`, { waitUntil: "load" });
    await other.evaluate(() => { setTimeout(() => alert("用户标签的弹窗"), 0); });
    await new Promise((r) => setTimeout(r, 300));
    try {
      const pages = await within(session.listPages());
      const id = pages.find((p) => p.url.endsWith("/dialogs.html") && p.pageId !== base.pageId)!.pageId;
      const handle = await within(session.getPage(id));
      await within(takeSnapshot(handle));
      // 接管前就开着的弹窗只能盲关，类型与文字拿不到
      expect(DialogGuard.for(handle)!.takeHandled()[0]).toMatchObject({ type: "unknown", pending: true });
    } finally {
      await other.close().catch(() => {});
    }
  });
});
