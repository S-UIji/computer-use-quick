import { describe, it, expect } from "vitest";
import { renderBadgeText } from "../../src/watch/overlay.js";

describe("renderBadgeText 角标文案", () => {
  it("执行中：紧凑状态和步数", () => {
    expect(renderBadgeText({ kind: "active", label: "smoke-login", step: 3, total: 16, action: "click" }))
      .toBe("正在操作 · 3/16 · 悬停详情");
  });

  it("待命", () => {
    expect(renderBadgeText({ kind: "idle" })).toBe("agent 待命");
  });

  it("已被打断", () => {
    expect(renderBadgeText({ kind: "interrupted", stopStep: 3 }))
      .toBe("检测到你的操作，执行已停止（第 3 步未完成）");
  });
});
