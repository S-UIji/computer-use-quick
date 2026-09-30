import { describe, it, expect } from "vitest";
import {
  parseLaunchSetting, isLocalBrowserUrl, browserPort, defaultProfileDir, findChrome,
  chromeArgs, describeConnectError, renderGuidance, connectNotice
} from "../../src/session/launcher.js";

describe("parseLaunchSetting", () => {
  it("空值与 off 关闭，auto 开启（大小写、空白不敏感）", () => {
    expect(parseLaunchSetting(undefined)).toEqual({ setting: "off" });
    expect(parseLaunchSetting(" OFF ")).toEqual({ setting: "off" });
    expect(parseLaunchSetting("Auto")).toEqual({ setting: "auto" });
  });
  it("非法值按关闭处理并给出告警", () => {
    const r = parseLaunchSetting("yes");
    expect(r.setting).toBe("off");
    expect(r.warning).toContain("CUQ_LAUNCH");
  });
});

describe("isLocalBrowserUrl / browserPort", () => {
  it("只认本机地址", () => {
    expect(isLocalBrowserUrl("http://127.0.0.1:9222")).toBe(true);
    expect(isLocalBrowserUrl("http://localhost:9222")).toBe(true);
    expect(isLocalBrowserUrl("http://[::1]:9222")).toBe(true);
    expect(isLocalBrowserUrl("http://10.0.0.5:9222")).toBe(false);
    expect(isLocalBrowserUrl("不是地址")).toBe(false);
  });
  it("端口取自地址，缺省按协议默认端口", () => {
    expect(browserPort("http://127.0.0.1:9333")).toBe(9333);
    expect(browserPort("http://127.0.0.1")).toBe(80);
  });
});

describe("defaultProfileDir", () => {
  it("Windows 放在 LOCALAPPDATA 下（与 README 一致）", () => {
    expect(defaultProfileDir("win32", { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "C:\\Users\\u"))
      .toBe("C:\\Users\\u\\AppData\\Local\\cuq-chrome-profile");
  });
  it("其余平台放在家目录下", () => {
    expect(defaultProfileDir("darwin", {}, "/Users/u")).toBe("/Users/u/.cuq-chrome-profile");
  });
});

describe("findChrome", () => {
  it("CUQ_CHROME_PATH 优先，且不校验存在", () => {
    expect(findChrome({ platform: "win32", env: { CUQ_CHROME_PATH: "D:\\edge.exe" }, exists: () => false }))
      .toBe("D:\\edge.exe");
  });
  it("Windows 按 ProgramFiles 等常见位置查找", () => {
    const hit = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    expect(findChrome({ platform: "win32", env: { ProgramFiles: "C:\\Program Files" }, home: "C:\\Users\\u",
      exists: (p) => p === hit })).toBe(hit);
  });
  it("macOS 查 /Applications", () => {
    const hit = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    expect(findChrome({ platform: "darwin", env: {}, home: "/Users/u", exists: (p) => p === hit })).toBe(hit);
  });
  it("都找不到返回 undefined", () => {
    expect(findChrome({ platform: "linux", env: {}, home: "/home/u", exists: () => false })).toBeUndefined();
  });
});

describe("chromeArgs", () => {
  it("带调试端口与独立 profile，headless 可选", () => {
    expect(chromeArgs(9222, "/p")).toEqual([
      "--remote-debugging-port=9222", "--user-data-dir=/p", "--no-first-run", "--no-default-browser-check"
    ]);
    expect(chromeArgs(9222, "/p", true)).toContain("--headless=new");
  });
});

describe("describeConnectError", () => {
  it("连接被拒绝翻译成人话", () => {
    const err = new Error("Failed to fetch browser webSocket URL from http://127.0.0.1:9445/json/version: fetch failed",
      { cause: new Error("connect ECONNREFUSED 127.0.0.1:9445") });
    expect(describeConnectError(err)).toBe("该端口上没有程序在监听");
  });
  it("其他错误取首行并截断", () => {
    expect(describeConnectError(new Error("第一行\n第二行"))).toBe("第一行");
    expect(describeConnectError(new Error("长".repeat(300))).length).toBeLessThan(130);
  });
});

describe("renderGuidance", () => {
  const base = { reason: "该端口上没有程序在监听", profileDir: "C:\\Users\\u\\AppData\\Local\\cuq-chrome-profile" };

  it("本机：给出完整命令、无需重启提示与自动拉起开关", () => {
    const s = renderGuidance({ ...base, browserURL: "http://127.0.0.1:9222", platform: "win32",
      chromePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" });
    expect(s).toContain("无法连接浏览器 http://127.0.0.1:9222（该端口上没有程序在监听）");
    expect(s).toContain('"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\\Users\\u\\AppData\\Local\\cuq-chrome-profile"');
    expect(s).toContain("无需重启 MCP 服务端");
    expect(s).toContain("PowerShell");
    expect(s).toContain("CUQ_LAUNCH=auto");
  });

  it("非 Windows 不提 PowerShell", () => {
    const s = renderGuidance({ ...base, browserURL: "http://127.0.0.1:9222", platform: "darwin", chromePath: "/c" });
    expect(s).not.toContain("PowerShell");
  });

  it("找不到 Chrome 时用占位并提示 CUQ_CHROME_PATH", () => {
    const s = renderGuidance({ ...base, browserURL: "http://127.0.0.1:9222", platform: "linux" });
    expect(s).toContain('"<Chrome 路径>"');
    expect(s).toContain("CUQ_CHROME_PATH");
  });

  it("自动拉起失败：写明原因，不再建议打开 CUQ_LAUNCH", () => {
    const s = renderGuidance({ ...base, browserURL: "http://127.0.0.1:9222", platform: "win32", chromePath: "c",
      launchError: "15s 内调试端口未就绪" });
    expect(s).toContain("自动拉起失败：15s 内调试端口未就绪");
    expect(s).not.toContain("CUQ_LAUNCH=auto");
  });

  it("远程地址：不给命令，只提示确认可访问", () => {
    const s = renderGuidance({ ...base, browserURL: "http://10.0.0.5:9222", chromePath: "c" });
    expect(s).toContain("请确认该地址上的 Chrome 已开启调试端口");
    expect(s).not.toContain("--remote-debugging-port");
  });
});

describe("connectNotice", () => {
  it("首次连接没有告知", () => {
    expect(connectNotice(false)).toBeUndefined();
  });
  it("重连提示旧页面与 ref 可能失效", () => {
    expect(connectNotice(true)).toContain("已重新连接");
    expect(connectNotice(true)).toContain("先 snapshot");
  });
  it("首次拉起写明 profile；断线后拉起两句合并", () => {
    expect(connectNotice(false, "/p")).toBe("浏览器未运行，已自动拉起（profile：/p）");
    const s = connectNotice(true, "/p")!;
    expect(s).toContain("已自动重新拉起（profile：/p）");
    expect(s).toContain("先 snapshot");
  });
});
