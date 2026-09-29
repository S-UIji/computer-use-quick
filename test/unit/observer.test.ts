import { describe, it, expect } from "vitest";
import { describeInterruption } from "../../src/executor/observer.js";

describe("describeInterruption", () => {
  it("点击带取整坐标", () => {
    expect(describeInterruption({ type: "pointerdown", x: 12.4, y: 30.6 })).toBe("pointerdown @ 12,31");
  });

  it("按键只报类型，不带任何按键信息", () => {
    expect(describeInterruption({ type: "keydown", x: 0, y: 0 })).toBe("keydown");
  });
});
