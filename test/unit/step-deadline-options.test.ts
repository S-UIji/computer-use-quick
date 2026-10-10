import { afterEach, describe, expect, it, vi } from "vitest";
import { readPageContext } from "../../src/session/pageContext.js";
import { replayTrace } from "../../src/trace/replay.js";
import { runSuite } from "../../src/trace/suite.js";
import { runHeal, runMultiHeal } from "../../src/trace/heal.js";
import type { PageHandle } from "../../src/session/browser.js";

afterEach(() => vi.useRealTimers());
const makeHandle = (send: (method: string) => Promise<any>): PageHandle => ({
  pageId: "metadata", page: { url: () => "http://example.test/page?token=private", isClosed: () => false } as any,
  cdp: { send } as any
});

describe("页面元信息共享截止预算", () => {
  it("首个 TargetInfo 挂起时在两秒内返回最后已知脱敏 URL", async () => {
    vi.useFakeTimers();
    let settled = false;
    let context: Awaited<ReturnType<typeof readPageContext>> | undefined;
    const pending = readPageContext(makeHandle(async () => new Promise(() => {})))
      .then(value => { settled = true; context = value; });
    await vi.advanceTimersByTimeAsync(2001);
    expect(settled).toBe(true);
    await pending;
    expect(context).toMatchObject({ current: false, closed: false });
    expect(context?.url).not.toContain("private");
  });

  it("过期 TargetInfo 的迟到结果不会继续读取 DOM", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    let release!: (value: any) => void;
    const pending = readPageContext(makeHandle(async method => {
      sent.push(method);
      return new Promise(resolve => { release = resolve; });
    }));
    await vi.advanceTimersByTimeAsync(2001);
    release({ targetInfo: { url: "http://example.test/page" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(["Target.getTargetInfo"]);
    expect(await pending).toMatchObject({ current: false });
  });

  it("多个 TargetInfo 与标题读取共用两秒总预算", async () => {
    vi.useFakeTimers();
    let settled = false;
    const url = "http://example.test/page";
    const pending = readPageContext(makeHandle(async method => {
      if (method === "Target.getTargetInfo") {
        await new Promise(resolve => setTimeout(resolve, 1400));
        return { targetInfo: { url } };
      }
      return { root: { nodeId: 1, documentURL: url, children: [] } };
    })).then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(2001);
    expect(settled).toBe(true);
    expect(await pending).toMatchObject({ current: false });
  });
});


describe("直接执行 API 截止参数预检", () => {
  const trace = { name: "preflight", baseUrl: "http://example.test", createdAt: "", steps: [
    { action: "fill", target: { ref: "e1" }, value: "${MISSING}" }
  ] };
  it.each(["replay", "suite", "heal", "multi-heal"])("%s 在变量检查和资源访问前拒绝非法预算", async name => {
    const opts = { stepTimeoutMs: 99, trace, tracePath: "missing-file", paths: ["missing-file"], vars: {},
      stepIndex: 0, demoSteps: trace.steps, repairs: [{ stepIndex: 0, steps: trace.steps }], dryRun: false } as any;
    const run = { replay: replayTrace, suite: runSuite, heal: runHeal, "multi-heal": runMultiHeal }[name]!;
    await expect(run(opts)).rejects.toThrow(/stepTimeoutMs/);
  });
});
