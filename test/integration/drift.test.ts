import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { NetworkTracker } from "../../src/waiter/stability.js";
import { DiagnosticsCollector } from "../../src/diagnostics/collector.js";
import { takeSnapshot } from "../../src/perception/snapshot.js";
import { buildDescriptor } from "../../src/locator/descriptor.js";
import { resolve } from "../../src/locator/resolve.js";
import { replayTrace } from "../../src/trace/replay.js";
import type { Descriptor, Trace } from "../../src/types.js";

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

async function open(path: string): Promise<PageHandle> {
  const h = await session.getPage();
  await h.page.goto(`${fx.url}/${path}`, { waitUntil: "load" });
  return h;
}

/** 在 v1 上为第二张卡的按钮建 descriptor */
async function descriptorFromV1(): Promise<Descriptor> {
  const h = await open("cards-v1.html");
  const snap = await takeSnapshot(h, { threshold: 99 });
  const line = snap.text.split("\n").filter((l) => l.includes("查看在岗干部明细"))[1];
  const ref = line.match(/\[(e\d+)\]/)![1];
  return buildDescriptor(h, snap.refs.get(ref)!);
}

function traceWith(d: Descriptor, page: string, name: string, assertText?: string): Trace {
  const steps: Trace["steps"] = [
    { action: "navigate", url: `/${page}` },
    { action: "click", target: { descriptor: d } }
  ];
  if (assertText) {
    steps.push({
      action: "assert", type: "text-equals",
      target: { descriptor: { strategies: [{ kind: "css", value: "#clicked" }], framePath: [] } },
      expected: assertText
    });
  }
  return { name, baseUrl: fx.url, createdAt: "2026-09-11T00:00:00.000Z", steps };
}

describe("改版漂移", () => {
  it("v1 上首选策略是 test-id", async () => {
    expect((await descriptorFromV1()).strategies[0].kind).toBe("test-id");
  });

  it("v1 的 descriptor 在 v2 上仍能命中，但回退到了容器锚定", async () => {
    const d = await descriptorFromV1();
    const h = await open("cards-v2.html");
    const r = await resolve(h, d);
    expect(r.strategyIndex).toBeGreaterThan(0);
    expect(r.strategyKind).toBe("container-role-name");
  });

  it("命中的确实是正确的那张卡的按钮", async () => {
    const d = await descriptorFromV1();
    const rec = await replayTrace({
      handle: await session.getPage(), tracker, collector, vars: {},
      trace: traceWith(d, "cards-v2.html", "drift-check", "技术平台中心 · 查看在岗干部明细")
    });
    expect(rec.ok).toBe(true);
  });

  it("回放成功但 run-record 里有漂移告警", async () => {
    const d = await descriptorFromV1();
    const rec = await replayTrace({
      handle: await session.getPage(), tracker, collector, vars: {},
      trace: traceWith(d, "cards-v2.html", "drift-warn")
    });
    expect(rec.ok).toBe(true);
    expect(rec.drifts.length).toBeGreaterThan(0);
    expect(rec.drifts[0].expected).toBe("test-id");
    expect(rec.drifts[0].actual).toBe("container-role-name");
  });

  it("在原版 v1 上回放不产生漂移告警", async () => {
    const d = await descriptorFromV1();
    const rec = await replayTrace({
      handle: await session.getPage(), tracker, collector, vars: {},
      trace: traceWith(d, "cards-v1.html", "no-drift")
    });
    expect(rec.ok).toBe(true);
    expect(rec.drifts).toHaveLength(0);
  });
});
