import { describe, it, expect } from "vitest";
import { renderRunRecord } from "../../src/report/runRecord.js";
import type { RunRecord } from "../../src/types.js";

const base: RunRecord = {
  traceName: "smoke-login",
  startedAt: "2026-09-11T00:00:00.000Z",
  durationMs: 4200,
  ok: true,
  steps: [
    { index: 0, action: "navigate", ok: true, durationMs: 1200 },
    { index: 1, action: "click", ok: true, durationMs: 300, strategyIndex: 0 }
  ],
  drifts: [],
  healRequired: false
};

describe("renderRunRecord", () => {
  it("成功时标题带对勾和总耗时", () => {
    const md = renderRunRecord(base);
    expect(md).toContain("✅");
    expect(md).toContain("4200ms");
    expect(md).toContain("smoke-login");
  });

  it("逐步列出耗时", () => {
    const md = renderRunRecord(base);
    expect(md).toContain("navigate");
    expect(md).toContain("1200ms");
  });

  it("有漂移时单列一节告警，但不影响成功状态", () => {
    const md = renderRunRecord({
      ...base,
      drifts: [{ index: 1, expected: "test-id", actual: "container-role-name" }]
    });
    expect(md).toContain("漂移");
    expect(md).toContain("test-id");
    expect(md).toContain("container-role-name");
    expect(md).toContain("✅");
  });

  it("失败时标题带叉号并附失败上下文", () => {
    const md = renderRunRecord({
      ...base, ok: false, healRequired: true,
      failure: {
        failedIndex: 1,
        failedStep: { action: "click", target: { descriptor: { strategies: [], framePath: [] } } },
        kind: "target-not-found",
        message: "全部策略均未命中",
        snapshot: 'button "登录"',
        consoleErrors: ["Uncaught TypeError"],
        failedRequests: ["500 /api/x"]
      }
    });
    expect(md).toContain("❌");
    expect(md).toContain("heal_required=true");
    expect(md).toContain("全部策略均未命中");
    expect(md).toContain("Uncaught TypeError");
    expect(md).toContain("500 /api/x");
  });

  it("无漂移时不输出漂移小节", () => {
    expect(renderRunRecord(base)).not.toContain("漂移");
  });
});
