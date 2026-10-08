import { describe, it, expect, vi } from "vitest";
import { RunWatch } from "../../src/watch/runWatch.js";
import { ProgressReporter } from "../../src/watch/progress.js";
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

describe("RunWatch 中断结束进度", () => {
  it("headless 仍推停止步号，保持已有进度和偏移，重复结束不重复推送", async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const progress = ProgressReporter.from({ _meta: { progressToken: "stop" }, sendNotification });
    const w = new RunWatch({ handle: brokenHandle(), label: "验证", watch: false, progress,
      progressOffset: 3, progressTotal: 7 });
    await w.onRunStart(4);
    await w.onStepEnd({ index: 0, action: "click", ok: true, durationMs: 1 });
    await w.onRunEnd({ ok: false, interrupted: true, failedIndex: 1 });
    await w.onRunEnd({ ok: false, interrupted: true, failedIndex: 1 });
    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(sendNotification.mock.calls[1][0].params).toMatchObject({
      progressToken: "stop", progress: 4, total: 7
    });
    expect(sendNotification.mock.calls[1][0].params.message).toContain("第 2 步");
    expect(sendNotification.mock.calls[1][0].params.message).toContain("等待用户");
  });
  it.each([{ ok: true, interrupted: false }, { ok: false, interrupted: false, failedIndex: 0 }])(
    "成功或普通失败没有中断通知", async (outcome) => {
      const sendNotification = vi.fn().mockResolvedValue(undefined);
      const progress = ProgressReporter.from({ _meta: { progressToken: "normal" }, sendNotification });
      const w = new RunWatch({ handle: brokenHandle(), label: "测试", watch: false, progress });
      await w.onRunStart(1);
      await w.onRunEnd(outcome);
      expect(sendNotification).not.toHaveBeenCalled();
    });
});
