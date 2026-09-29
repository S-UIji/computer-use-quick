import { describe, it, expect } from "vitest";
import {
  attribute, AGENT_GRACE_MS, LATE_MATCH_MS, type AgentWindow, type ReportedInput
} from "../../src/watch/intervention.js";

const T = 1_000_000;
const ev = (o: Partial<ReportedInput> = {}): ReportedInput =>
  ({ type: "pointerdown", x: 100, y: 200, top: true, at: T, ...o });
const mouse = (o: Partial<AgentWindow> = {}): AgentWindow =>
  ({ kind: "mouse", x: 100, y: 200, start: T - 20, end: T - 5, ...o });

describe("attribute 介入判定", () => {
  it("顶层 pointerdown：时间窗内且坐标吻合 → agent", () => {
    expect(attribute(ev(), [mouse()])).toBe("agent");
  });

  it("顶层 pointerdown：坐标误差 2px 内算吻合，超过即用户", () => {
    expect(attribute(ev({ x: 102, y: 198 }), [mouse()])).toBe("agent");
    expect(attribute(ev({ x: 103 }), [mouse()])).toBe("user");
  });

  it("顶层 pointerdown：时间窗内但坐标不符 → 用户", () => {
    expect(attribute(ev({ x: 400, y: 50 }), [mouse()])).toBe("user");
  });

  it("顶层 pointerdown：上报晚到但坐标吻合，1s 内仍算 agent，超过算用户", () => {
    expect(attribute(ev({ at: T - 5 + LATE_MATCH_MS }), [mouse()])).toBe("agent");
    expect(attribute(ev({ at: T - 5 + LATE_MATCH_MS + 1 }), [mouse()])).toBe("user");
  });

  it("派发仍在进行中（end 未定）且坐标吻合 → agent", () => {
    expect(attribute(ev(), [mouse({ end: undefined })])).toBe("agent");
  });

  it("早于时间窗开始的事件不算 agent", () => {
    expect(attribute(ev({ at: T - 30 }), [mouse()])).toBe("user");
  });

  it("iframe pointerdown：只看时间窗（含 150ms 余量），不比坐标", () => {
    expect(attribute(ev({ top: false, x: 5, y: 5 }), [mouse()])).toBe("agent");
    expect(attribute(ev({ top: false, at: T - 5 + AGENT_GRACE_MS + 1 }), [mouse()])).toBe("user");
  });

  it("keydown：按键时间窗内 → agent；窗外或只有鼠标窗 → 用户", () => {
    const key: AgentWindow = { kind: "key", start: T - 20, end: T - 5 };
    expect(attribute(ev({ type: "keydown", x: 0, y: 0 }), [key])).toBe("agent");
    expect(attribute(ev({ type: "keydown", x: 0, y: 0, at: T + AGENT_GRACE_MS }), [key])).toBe("user");
    expect(attribute(ev({ type: "keydown", x: 0, y: 0 }), [mouse()])).toBe("user");
  });

  it("wheel：滚动时间窗内 → agent；否则只记为用户滚动", () => {
    const wheel: AgentWindow = { kind: "wheel", x: 10, y: 10, start: T - 20, end: T - 5 };
    expect(attribute(ev({ type: "wheel", x: 10, y: 10 }), [wheel])).toBe("agent");
    expect(attribute(ev({ type: "wheel" }), [])).toBe("user-scroll");
  });

  it("没有任何时间窗时，点击与按键都是用户", () => {
    expect(attribute(ev(), [])).toBe("user");
    expect(attribute(ev({ type: "keydown" }), [])).toBe("user");
  });
});
