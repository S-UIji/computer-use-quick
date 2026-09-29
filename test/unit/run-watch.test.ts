import { describe, it, expect } from "vitest";
import { RunWatch } from "../../src/watch/runWatch.js";
import type { PageHandle } from "../../src/session/browser.js";

/** 所有 CDP 调用都失败的假句柄：模拟页面已关闭 / 会话断开 */
const brokenHandle = (): PageHandle => ({
  pageId: "broken",
  page: {} as PageHandle["page"],
  cdp: {
    send: async () => { throw new Error("Session closed"); },
    on: () => undefined,
    off: () => undefined
  } as unknown as PageHandle["cdp"]
});

describe("RunWatch 尽力而为", () => {
  it("启用但 CDP 全部失败：所有钩子不抛错，并给出介入检测未启用的原因", async () => {
    const w = new RunWatch({ handle: brokenHandle(), label: "探索", watch: true });
    await w.onRunStart(2);
    await w.onStepStart(0, { action: "press", key: "Tab" });
    await w.onStepEnd({ index: 0, action: "press", ok: true, durationMs: 1 });
    await w.onRunEnd({ ok: true, interrupted: false });
    expect(w.setupWarning).toContain("介入检测未能启用");
    expect(w.setupWarning).toContain("Session closed");
    expect(w.takeInterruption()).toBeUndefined();
    expect(w.takeScrollCount()).toBe(0);
  });

  it("未启用：不提供输入门，也没有告警", async () => {
    const w = new RunWatch({ handle: brokenHandle(), label: "探索", watch: false });
    await w.onRunStart(1);
    expect(w.inputGate).toBeUndefined();
    expect(w.setupWarning).toBeUndefined();
  });
});
