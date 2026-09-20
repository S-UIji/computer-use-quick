import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { BrowserSession } from "../../src/session/browser.js";
import { NetworkTracker } from "../../src/waiter/stability.js";
import { DiagnosticsCollector } from "../../src/diagnostics/collector.js";
import { runBench } from "../bench/run.js";
import type { Trace } from "../../src/types.js";

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

function trace(baseUrl: string): Trace {
  const css = (value: string) => ({
    descriptor: { strategies: [{ kind: "css" as const, value }], framePath: [] }
  });
  return {
    name: "bench-login", baseUrl, createdAt: "2026-09-11T00:00:00.000Z",
    steps: [
      { action: "navigate", url: "/form.html" },
      { action: "fill", target: css("#user"), value: "admin" },
      { action: "fill", target: css("#pwd"), value: "x" },
      { action: "click", target: css("#submit") },
      { action: "assert", type: "text-contains", target: css("#result"), expected: "欢迎" }
    ]
  };
}

describe("runBench", () => {
  it("turn 数按口径正确计算：A=步数，B=ceil(N/5)×2，C=1", async () => {
    const r = await runBench({
      handle: await session.getPage(), tracker, collector,
      trace: trace(fx.url), vars: {}, rounds: 2
    });
    expect(r.steps).toBe(5);
    expect(r.turnsA).toBe(5);
    expect(r.turnsB).toBe(2);
    expect(r.turnsC).toBe(1);
  });

  it("实测出 A、B 和 C 的中位耗时，且报告含三行对照", async () => {
    const r = await runBench({
      handle: await session.getPage(), tracker, collector,
      trace: trace(fx.url), vars: {}, rounds: 2
    });
    expect(r.medianAMs).toBeGreaterThan(0);
    expect(r.medianBMs).toBeGreaterThan(0);
    expect(r.medianCMs).toBeGreaterThan(0);
    expect(r.markdown).toContain("| A ");
    expect(r.markdown).toContain("| B ");
    expect(r.markdown).toContain("| C ");
    expect(r.markdown).not.toContain("待人工填写");
    console.log("\n" + r.markdown + "\n");
  });
});
