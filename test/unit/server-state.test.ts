import { describe, it, expect } from "vitest";
import { stepOverflowWarning, STEP_WARN_THRESHOLD } from "../../src/server.js";

describe("sessionSteps 软告警", () => {
  it("阈值默认 200", () => {
    expect(STEP_WARN_THRESHOLD).toBe(200);
  });

  it("未超阈值（含恰好 200）无告警", () => {
    expect(stepOverflowWarning(0)).toBeUndefined();
    expect(stepOverflowWarning(STEP_WARN_THRESHOLD)).toBeUndefined();
  });

  it("超阈值给出含步数与操作指引的告警行", () => {
    const w = stepOverflowWarning(201);
    expect(w).toContain("201");
    expect(w).toContain("discard_steps");
    expect(w).toContain("save_trace");
  });
});
