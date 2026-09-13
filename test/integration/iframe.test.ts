import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { NetworkTracker } from "../../src/waiter/stability.js";
import { DiagnosticsCollector } from "../../src/diagnostics/collector.js";
import { listFrames, scopeNodeId } from "../../src/session/frames.js";
import { takeSnapshot } from "../../src/perception/snapshot.js";
import { buildDescriptor } from "../../src/locator/descriptor.js";
import { runBatch } from "../../src/executor/batch.js";

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

async function open(): Promise<PageHandle> {
  const h = await session.getPage();
  await h.page.goto(`${fx.url}/modal-iframe.html`, { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 300)); // 等 iframe 内文档就绪
  return h;
}

describe("listFrames", () => {
  it("列出主 frame 与内嵌 frame", async () => {
    const frames = await listFrames(await open());
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(frames.map((f) => f.key)).toContain("iframe-inner.html");
  });

  it("每个 frame 都带可用的 documentNodeId", async () => {
    for (const f of await listFrames(await open())) {
      expect(f.documentNodeId).toBeGreaterThan(0);
    }
  });
});

describe("scopeNodeId", () => {
  it("空 framePath 返回主文档", async () => {
    expect(await scopeNodeId(await open(), [])).toBeGreaterThan(0);
  });

  it("未知 frame key 抛出明确错误", async () => {
    await expect(scopeNodeId(await open(), ["不存在.html"])).rejects.toThrow(/不存在\.html/);
  });
});

describe("跨 frame 感知与操作", () => {
  it("快照包含 iframe 内的元素，并标出所属 frame", async () => {
    const snap = await takeSnapshot(await open());
    expect(snap.text).toContain("iframe-inner.html");
    expect(snap.text).toContain("备注");
    expect(snap.text).toContain("确认");
  });

  it("为 iframe 内元素生成的 descriptor 带 framePath", async () => {
    const h = await open();
    const snap = await takeSnapshot(h, { threshold: 99 });
    const ref = snap.text.split("\n").find((l) => l.includes('"确认"'))!.match(/\[(e\d+)\]/)![1];
    const d = await buildDescriptor(h, snap.refs.get(ref)!);
    expect(d.framePath).toEqual(["iframe-inner.html"]);
  });

  it("能 fill 并 click iframe 内的元素", async () => {
    const h = await open();
    const r = await runBatch({
      handle: h, tracker, collector, refs: new Map(), vars: {},
      steps: [
        { action: "fill", target: { descriptor: {
          strategies: [{ kind: "css", value: "#note" }], framePath: ["iframe-inner.html"]
        }}, value: "内嵌备注" },
        { action: "click", target: { descriptor: {
          strategies: [{ kind: "role-name", role: "button", name: "确认" }],
          framePath: ["iframe-inner.html"]
        }}}
      ]
    });
    expect(r.ok).toBe(true);

    const { result } = await h.cdp.send("Runtime.evaluate", {
      expression: `document.getElementById("inner").contentDocument.getElementById("note").value`,
      returnByValue: true
    });
    expect((result as { value: string }).value).toBe("内嵌备注");
  });

  it("主文档范围内查找不会误命中 iframe 里的元素", async () => {
    const h = await open();
    const r = await runBatch({
      handle: h, tracker, collector, refs: new Map(), vars: {},
      steps: [{ action: "click", target: { descriptor: {
        strategies: [{ kind: "role-name", role: "button", name: "确认" }], framePath: []
      }}}]
    });
    expect(r.ok).toBe(false);
    expect(r.failure?.kind).toBe("target-not-found");
  });
});
