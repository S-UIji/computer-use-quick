import { describe, it, expect } from "vitest";
import { describeStep } from "../../src/report/describeStep.js";
import { createVariableRedactor } from "../../src/report/variablePrivacy.js";
describe("完整观察说明", () => {
  it("完整导航保留末尾非敏感文本，紧凑反馈继续截断", () => {
    const url = "https://example.com/" + "long/".repeat(30) + "final";
    expect(describeStep({ action:"navigate",url }, undefined, undefined, Infinity)).toBe("导航到 " + url);
    expect(describeStep({ action:"navigate",url })).not.toContain("final");
  });
  it("完整名称和URL仍先脱敏，不包含填写值", () => {
    const secret = "secret-" + "x".repeat(110), prefix = "名称".repeat(80);
    const redact = createVariableRedactor({TOKEN:secret},["TOKEN"]);
    const result = describeStep({action:"fill",target:{ref:"e1"},value:"never-display"},
      new Map([["e1",prefix + secret + "末尾"]]),redact,Infinity);
    expect(result).toBe("填写「" + prefix + "$" + "{TOKEN}末尾」");
    expect(result).not.toContain("never-display"); expect(result).not.toContain(secret);
    expect(describeStep({action:"navigate",url:"https://example.com/?token=private-value"},undefined,undefined,Infinity)).not.toContain("private-value");
  });
});
