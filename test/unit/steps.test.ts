import { describe, it, expect } from "vitest";
import { recordSteps, discardSteps, sessionSteps } from "../../src/server.js";
import type { Step } from "../../src/types.js";

const step = (ms: number): Step => ({ action: "sleep", ms });

describe("sessionSteps 记录与丢弃", () => {
  it("recordSteps 累积，discardSteps 丢弃最近 N 步", () => {
    const page = "unit-steps-1";
    recordSteps(page, [step(1), step(2), step(3)]);
    expect(sessionSteps.get(page)).toHaveLength(3);

    expect(discardSteps(page, 2)).toBe(2);
    expect(sessionSteps.get(page)).toHaveLength(1);
  });

  it("省略 count 时清空；空页丢弃返回 0", () => {
    const page = "unit-steps-2";
    recordSteps(page, [step(1)]);
    expect(discardSteps(page)).toBe(1);
    expect(sessionSteps.get(page)).toHaveLength(0);
    expect(discardSteps(page)).toBe(0);
  });

  it("count 超过已记录条数时按实际丢弃", () => {
    const page = "unit-steps-3";
    recordSteps(page, [step(1), step(2)]);
    expect(discardSteps(page, 99)).toBe(2);
    expect(sessionSteps.get(page)).toHaveLength(0);
  });
});
