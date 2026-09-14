import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { BrowserSession } from "../../src/session/browser.js";
import { NetworkTracker } from "../../src/waiter/stability.js";
import { DiagnosticsCollector } from "../../src/diagnostics/collector.js";
import { replayTrace } from "../../src/trace/replay.js";
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

function loginTrace(baseUrl: string): Trace {
  const css = (value: string) => ({
    descriptor: { strategies: [{ kind: "css" as const, value }], framePath: [] }
  });
  return {
    name: "smoke-login", baseUrl, createdAt: "2026-09-11T00:00:00.000Z",
    steps: [
      { action: "navigate", url: "/form.html" },
      { action: "fill", target: css("#user"), value: "${USER}" },
      { action: "fill", target: css("#pwd"), value: "${PWD}" },
      { action: "click", target: css("#submit") },
      { action: "assert", type: "text-contains", target: css("#result"), expected: "欢迎 ${USER}" }
    ]
  };
}

async function run(trace: Trace, vars: Record<string, string>, slowMoMs?: number) {
  return replayTrace({
    handle: await session.getPage(), tracker, collector, trace, vars, slowMoMs
  });
}

describe("replayTrace", () => {
  it("整条用例回放成功，逐步台账完整", async () => {
    const rec = await run(loginTrace(fx.url), { USER: "admin", PWD: "s3cret" });
    expect(rec.ok).toBe(true);
    expect(rec.healRequired).toBe(false);
    expect(rec.steps).toHaveLength(5);
    expect(rec.steps.every((s) => s.ok)).toBe(true);
  });

  it("相对 url 被 baseUrl 补全", async () => {
    const rec = await run(loginTrace(fx.url), { USER: "a", PWD: "b" });
    expect(rec.steps[0].ok).toBe(true);
  });

  it("凭证从 vars 注入，trace 里只有占位符", async () => {
    const t = loginTrace(fx.url);
    expect(JSON.stringify(t)).not.toContain("s3cret");
    expect((await run(t, { USER: "admin", PWD: "s3cret" })).ok).toBe(true);
  });

  it("缺变量时失败并给出明确信息", async () => {
    const rec = await run(loginTrace(fx.url), { USER: "admin" });
    expect(rec.ok).toBe(false);
    expect(rec.failure?.message).toContain("PWD");
  });

  it("定位失败时标 heal_required 并带完整失败上下文", async () => {
    const t = loginTrace(fx.url);
    t.steps[3] = {
      action: "click",
      target: { descriptor: { strategies: [{ kind: "css", value: "#gone" }], framePath: [] } }
    };
    const rec = await run(t, { USER: "a", PWD: "b" });
    expect(rec.ok).toBe(false);
    expect(rec.healRequired).toBe(true);
    expect(rec.failure?.kind).toBe("target-not-found");
    expect(rec.failure?.snapshot).toContain("登录");
  });

  it("slowMoMs 让总耗时明显变长，但台账里不含 sleep 步骤", async () => {
    const fast = await run(loginTrace(fx.url), { USER: "a", PWD: "b" });
    const slow = await run(loginTrace(fx.url), { USER: "a", PWD: "b" }, 200);
    expect(slow.durationMs).toBeGreaterThan(fast.durationMs + 500);
    expect(slow.steps).toHaveLength(5);
    expect(slow.steps.some((s) => s.action === "sleep")).toBe(false);
  });

  it("回放一条 5 步用例，全程零模型往返（记录基线数字）", async () => {
    const rec = await run(loginTrace(fx.url), { USER: "a", PWD: "b" });
    // 同样 5 步若每步一次 agent turn，按每 turn 3s 保守计需要约 15s
    expect(rec.durationMs).toBeLessThan(15_000);
    console.log(`[基线] 5 步 replay 实测 ${rec.durationMs}ms`);
  });
});
