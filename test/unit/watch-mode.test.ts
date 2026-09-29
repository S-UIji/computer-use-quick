import { describe, it, expect } from "vitest";
import { parseWatchSetting, resolveWatchEnabled } from "../../src/watch/mode.js";

const HEADED_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
const HEADLESS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36";

describe("parseWatchSetting", () => {
  it("缺省与空串为 auto，且无告警", () => {
    expect(parseWatchSetting(undefined)).toEqual({ setting: "auto" });
    expect(parseWatchSetting("")).toEqual({ setting: "auto" });
  });

  it("大小写与首尾空白不敏感", () => {
    expect(parseWatchSetting(" ON ")).toEqual({ setting: "on" });
    expect(parseWatchSetting("Off")).toEqual({ setting: "off" });
    expect(parseWatchSetting("auto")).toEqual({ setting: "auto" });
  });

  it("非法值按 auto 处理，并给出含原值的告警", () => {
    const r = parseWatchSetting("yes");
    expect(r.setting).toBe("auto");
    expect(r.warning).toContain("yes");
    expect(r.warning).toContain("auto");
  });
});

describe("resolveWatchEnabled", () => {
  it("auto：有头启用、headless 不启用", () => {
    expect(resolveWatchEnabled("auto", HEADED_UA)).toBe(true);
    expect(resolveWatchEnabled("auto", HEADLESS_UA)).toBe(false);
  });

  it("auto：UA 取不到（探测失败）时不启用", () => {
    expect(resolveWatchEnabled("auto", undefined)).toBe(false);
  });

  it("on / off 无视 UA", () => {
    expect(resolveWatchEnabled("on", HEADLESS_UA)).toBe(true);
    expect(resolveWatchEnabled("off", HEADED_UA)).toBe(false);
  });
});
