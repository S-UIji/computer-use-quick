import { describe, it, expect } from "vitest";
import { renderBadgeText } from "../../src/watch/overlay.js";

describe("renderBadgeText 角标文案", () => {
  it("执行中：标签、步号、动作", () => {
    expect(renderBadgeText({ kind: "active", label: "smoke-login", step: 3, total: 16, action: "click" }))
      .toBe("🤖 computer-use-quick 正在操作 · smoke-login · 第 3/16 步 click · 请勿操作页面");
  });

  it("待命", () => {
    expect(renderBadgeText({ kind: "idle" })).toBe("⏸ 待命 · agent 可能随时继续，操作页面会干扰它");
  });

  it("已被打断", () => {
    expect(renderBadgeText({ kind: "interrupted", stopStep: 3 }))
      .toBe("✋ 检测到你的操作，执行已停止（第 3 步未完成）");
  });
});
