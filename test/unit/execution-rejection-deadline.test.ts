import { describe, expect, it } from "vitest";
import { createExecutionContext, ExecutionDeadlineError } from "../../src/executor/deadline.js";
import { PageClosedError } from "../../src/session/pageErrors.js";
describe("截止时间与拒绝结果", () => {
  it("事件循环忙到预算之后才抛错仍是deadline，不可用普通错误绕过", async () => {
    const context = createExecutionContext(20);
    const ordinary = new Error("ordinary operation failed");
    const work = Promise.resolve().then(() => {
      const until = Date.now() + 35;
      while (Date.now() < until) { /* finite real CPU work blocks timer scheduling */ }
      throw ordinary;
    });
    try { await expect(context.race(work)).rejects.toBeInstanceOf(ExecutionDeadlineError); }
    finally { context.dispose(); }
  });
  it("预算内普通失败仍保留原错误", async () => {
    const context = createExecutionContext(1000), ordinary = new Error("ordinary failure");
    try { await expect(context.race(Promise.reject(ordinary))).rejects.toBe(ordinary); }
    finally { context.dispose(); }
  });
  it("已确认关闭的取消原因仍优先", async () => {
    const context = createExecutionContext(20), closed = new PageClosedError("owned-page");
    context.cancel(closed);
    try { await expect(context.race(Promise.reject(new Error("other")))).rejects.toBe(closed); }
    finally { context.dispose(); }
  });
});
