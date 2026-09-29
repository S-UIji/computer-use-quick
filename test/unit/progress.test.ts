import { describe, it, expect, vi } from "vitest";
import { ProgressReporter } from "../../src/watch/progress.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("ProgressReporter", () => {
  it("客户端没带 progressToken：不发送、enabled 为 false", () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const p = ProgressReporter.from({ sendNotification });
    p.report(1, 2, "x");
    expect(p.enabled).toBe(false);
    expect(sendNotification).not.toHaveBeenCalled();
    expect(ProgressReporter.from(undefined).enabled).toBe(false);
  });

  it("带令牌：按 MCP 格式发送", () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const p = ProgressReporter.from({ _meta: { progressToken: "t1" }, sendNotification });
    p.report(1, 3, "第 1/3 步 click ✓");
    expect(p.enabled).toBe(true);
    expect(sendNotification).toHaveBeenCalledWith({
      method: "notifications/progress",
      params: { progressToken: "t1", progress: 1, total: 3, message: "第 1/3 步 click ✓" }
    });
  });

  it("total 未知时不带 total 字段", () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    ProgressReporter.from({ _meta: { progressToken: 7 }, sendNotification }).report(1, undefined, "x");
    expect(sendNotification.mock.calls[0][0].params).toEqual({ progressToken: 7, progress: 1, message: "x" });
  });

  it("progress 单调不减：回退的值被夹到上一次", () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const p = ProgressReporter.from({ _meta: { progressToken: "t" }, sendNotification });
    p.report(3, 5, "a");
    p.report(2, 5, "b");
    expect(sendNotification.mock.calls.map((c) => c[0].params.progress)).toEqual([3, 3]);
  });

  it("发送失败被吞掉，不抛、不产生未处理的 rejection", async () => {
    const sendNotification = vi.fn().mockRejectedValue(new Error("pipe closed"));
    const p = ProgressReporter.from({ _meta: { progressToken: "t" }, sendNotification });
    expect(() => p.report(1, 1, "x")).not.toThrow();
    await tick();
  });
});
