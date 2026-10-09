import { describe, it, expect } from "vitest";
import { headlessFromCommandLine } from "../../src/session/browserMode.js";

describe("真实启动参数判定", () => {
  it.each([
    ['"C:\\Program Files\\Chrome\\chrome.exe" --headless=new --port=9222', true],
    ['"/opt/chrome" "--user-agent=Mozilla/5.0 --headless" --port=9222', false],
    ['"/opt/chrome" --user-agent="Mozilla/5.0 --headless=new" --port=9222', false],
    ['"/opt/chrome" --headless --user-agent="normal Chrome"', true],
    ['"/opt/chrome-headless-shell" --user-agent="normal Chrome"', true],
    ['"C:\\Chrome\\headless_shell.exe" --port=9222', true],
    ['"/opt/chrome" --user-agent="unterminated --headless', undefined],
    ['', undefined]
  ])("只有完整参数开关决定模式：%s", (command, want) => {
    expect(headlessFromCommandLine(command)).toBe(want);
  });
});
