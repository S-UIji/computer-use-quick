import { describe, it, expect } from "vitest";
import { decideDialog, describeDialog } from "../../src/session/dialogs.js";

describe("decideDialog：弹窗处理策略", () => {
  it("confirm/prompt 未指定时默认确定", () => {
    expect(decideDialog("confirm")).toEqual({ accept: true, source: "default" });
    expect(decideDialog("prompt")).toEqual({ accept: true, source: "default" });
  });

  it("步骤指定 dismiss 时取消", () => {
    expect(decideDialog("confirm", "dismiss")).toEqual({ accept: false, source: "step" });
  });

  it("alert 与 beforeunload 固定放行，不受步骤指定影响", () => {
    expect(decideDialog("alert", "dismiss")).toEqual({ accept: true, source: "fixed" });
    expect(decideDialog("beforeunload", "dismiss")).toEqual({ accept: true, source: "fixed" });
  });
});

describe("describeDialog：报告文案", () => {
  it("默认策略确定时写明依据，并提示怎么改成取消", () => {
    const s = describeDialog({ type: "confirm", message: "确定删除？", accepted: true, source: "default" });
    expect(s).toContain("confirm「确定删除？」");
    expect(s).toContain("默认策略确定");
    expect(s).toContain('dialog: "dismiss"');
  });

  it("按步骤要求取消时不再给改法提示", () => {
    const s = describeDialog({ type: "confirm", message: "确定删除？", accepted: false, source: "step" });
    expect(s).toContain("按步骤要求取消");
    expect(s).not.toContain('dialog: "dismiss"');
  });

  it("alert 写已关闭，beforeunload 写已放行", () => {
    expect(describeDialog({ type: "alert", message: "提示一下", accepted: true, source: "fixed" }))
      .toContain("alert「提示一下」，已关闭");
    expect(describeDialog({ type: "beforeunload", message: "", accepted: true, source: "fixed" }))
      .toContain("离开页面确认，已放行");
  });

  it("两次调用之间弹出的窗写明来历", () => {
    const s = describeDialog({ type: "alert", message: "定时弹窗", accepted: true, source: "fixed", pending: true });
    expect(s).toContain("两次调用之间");
    expect(s).toContain("定时弹窗");
  });

  it("接管前就开着、内容未知的弹窗如实说明", () => {
    const s = describeDialog({ type: "unknown", message: "", accepted: true, source: "default", pending: true });
    expect(s).toContain("接管前就已打开");
    expect(s).toContain("内容未知");
    expect(s).not.toContain("「」");
  });

  it("超长弹窗文字截断", () => {
    const s = describeDialog({ type: "alert", message: "字".repeat(200), accepted: true, source: "fixed" });
    expect(s.length).toBeLessThan(140);
    expect(s).toContain("…");
  });
});
