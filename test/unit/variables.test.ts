import { describe, it, expect } from "vitest";
import { interpolate, interpolateStep } from "../../src/executor/variables.js";
import type { Step } from "../../src/types.js";

describe("interpolate", () => {
  it("替换已知变量", () => {
    expect(interpolate("你好 ${NAME}", { NAME: "世界" })).toBe("你好 世界");
  });

  it("替换同一变量的多次出现", () => {
    expect(interpolate("${A}-${A}", { A: "x" })).toBe("x-x");
  });

  it("未知变量抛错而非静默留占位符", () => {
    expect(() => interpolate("${MISSING}", {})).toThrow(/MISSING/);
  });

  it("无变量的文本原样返回", () => {
    expect(interpolate("纯文本", {})).toBe("纯文本");
  });
});

describe("interpolateStep", () => {
  it("替换 fill 的 value", () => {
    const s: Step = { action: "fill", target: { ref: "e1" }, value: "${USER}" };
    expect(interpolateStep(s, { USER: "admin" })).toMatchObject({ value: "admin" });
  });

  it("替换 navigate 的 url", () => {
    const s: Step = { action: "navigate", url: "${BASE}/login" };
    expect(interpolateStep(s, { BASE: "http://x" })).toMatchObject({ url: "http://x/login" });
  });

  it("替换 assert 的 expected", () => {
    const s: Step = { action: "assert", type: "text-contains", expected: "欢迎 ${USER}" };
    expect(interpolateStep(s, { USER: "admin" })).toMatchObject({ expected: "欢迎 admin" });
  });

  it("不含变量的 step 原样返回", () => {
    const s: Step = { action: "press", key: "Enter" };
    expect(interpolateStep(s, {})).toEqual(s);
  });
});
