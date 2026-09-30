import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/** 自动拉起开关：CUQ_LAUNCH=auto|off */
export type LaunchSetting = "off" | "auto";

/** 解析环境变量；非法值按 off 处理，并返回一行告警供调用方输出到 stderr */
export function parseLaunchSetting(raw: string | undefined): { setting: LaunchSetting; warning?: string } {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "" || v === "off") return { setting: "off" };
  if (v === "auto") return { setting: "auto" };
  return { setting: "off", warning: `CUQ_LAUNCH=${JSON.stringify(raw)} 不是 auto/off，按 off 处理` };
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** 自动拉起只对本机地址有意义：远程浏览器拉不起来，CI 里也不该冒出有头窗口 */
export function isLocalBrowserUrl(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function browserPort(url: string): number {
  const u = new URL(url);
  return Number(u.port || (u.protocol === "https:" ? 443 : 80));
}

/** 与 README 的启动命令同一目录：用户手动登录过的状态，自动拉起后照样可用 */
export function defaultProfileDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string {
  if (platform === "win32") {
    return win32.join(env.LOCALAPPDATA ?? win32.join(home, "AppData", "Local"), "cuq-chrome-profile");
  }
  return posix.join(home, ".cuq-chrome-profile");
}

function chromeCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  if (platform === "win32") {
    const roots = [
      env.ProgramFiles ?? "C:\\Program Files",
      env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
      env.LOCALAPPDATA ?? win32.join(home, "AppData", "Local")
    ];
    return roots.map((r) => win32.join(r, "Google", "Chrome", "Application", "chrome.exe"));
  }
  if (platform === "darwin") {
    const app = "Google Chrome.app/Contents/MacOS/Google Chrome";
    return [posix.join("/Applications", app), posix.join(home, "Applications", app)];
  }
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium",
    "/usr/bin/chromium-browser", "/snap/bin/chromium"];
}

/** CUQ_CHROME_PATH 优先（设了就用，不校验存在，用 Edge 等时靠它）；否则查平台常见位置 */
export function findChrome(p: {
  platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string; exists?: (path: string) => boolean;
} = {}): string | undefined {
  const env = p.env ?? process.env;
  if (env.CUQ_CHROME_PATH) return env.CUQ_CHROME_PATH;
  const exists = p.exists ?? existsSync;
  return chromeCandidates(p.platform ?? process.platform, env, p.home ?? homedir()).find(exists);
}

export function chromeArgs(port: number, profileDir: string, headless = false): string[] {
  return [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`,
    "--no-first-run", "--no-default-browser-check",
    ...(headless ? ["--headless=new"] : [])
  ];
}

/** 连接失败的原因说成人话：最常见的「没开」单独翻译，其余取首行 */
export function describeConnectError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? String((err as { cause?: unknown }).cause ?? "") : "";
  if (/ECONNREFUSED/.test(`${message} ${cause}`)) return "该端口上没有程序在监听";
  const first = message.split("\n")[0];
  return first.length > 120 ? first.slice(0, 120) + "…" : first;
}

export function renderGuidance(g: {
  browserURL: string; reason: string; launchError?: string;
  platform?: NodeJS.Platform; chromePath?: string; profileDir: string;
}): string {
  if (!isLocalBrowserUrl(g.browserURL)) {
    return `无法连接浏览器 ${g.browserURL}（${g.reason}）。\n` +
      "请确认该地址上的 Chrome 已开启调试端口且本机可以访问；恢复后直接重试本次调用即可。";
  }
  const platform = g.platform ?? process.platform;
  const cmd = `"${g.chromePath ?? "<Chrome 路径>"}" --remote-debugging-port=${browserPort(g.browserURL)} ` +
    `--user-data-dir="${g.profileDir}"`;
  const notes = [
    platform === "win32" ? "PowerShell 里在命令前加 &。" : "",
    g.chromePath ? "" : "未在常见位置找到 Chrome，可用环境变量 CUQ_CHROME_PATH 指定。",
    "--user-data-dir 必须是独立目录：Chrome 136 起默认 profile 下调试端口会被忽略。"
  ].filter(Boolean).join("");
  return [
    `无法连接浏览器 ${g.browserURL}（${g.reason}）。`,
    ...(g.launchError ? [`自动拉起失败：${g.launchError}`] : []),
    "请先启动 Chrome 并保持运行，然后直接重试本次调用，无需重启 MCP 服务端：",
    "",
    `  ${cmd}`,
    "",
    `（${notes}）`,
    ...(g.launchError ? [] : ["也可以在 MCP 配置的 env 里设 CUQ_LAUNCH=auto，由服务端自动拉起。"])
  ].join("\n");
}

const STALE = "之前的标签页、ref 和已记录的探索步骤可能已失效，先 snapshot";

/** (重)连接成功后给模型的一次性告知；首次正常连接没有告知 */
export function connectNotice(reconnect: boolean, launchedProfile?: string): string | undefined {
  if (launchedProfile !== undefined) {
    return reconnect
      ? `浏览器连接曾断开，已自动重新拉起（profile：${launchedProfile}）：${STALE}`
      : `浏览器未运行，已自动拉起（profile：${launchedProfile}）`;
  }
  return reconnect ? `浏览器连接曾断开，已重新连接：${STALE}` : undefined;
}

/** 浏览器连不上：message 就是给模型 / 用户看的完整指引 */
export class BrowserUnavailableError extends Error {
  override name = "BrowserUnavailableError";
}

export interface LaunchOptions {
  /** 省略则 findChrome() */
  chromePath?: string;
  /** 省略则 defaultProfileDir() */
  profileDir?: string;
  /** 测试用：不在桌面弹窗口 */
  headless?: boolean;
  /** 等调试端口就绪的上限，默认 15000ms */
  readyTimeoutMs?: number;
}

/**
 * 拉起本机 Chrome 并等调试端口就绪。detached + unref：Chrome 活过服务端进程，服务端退出不关它，
 * 下次会话直接复用。同 profile 已被一个未开调试端口的 Chrome 占用时，新进程会把参数转交给它后退出，
 * 端口永远不会就绪——超时说明里点出这种情况。
 */
export async function launchChrome(
  browserURL: string,
  opts: LaunchOptions = {}
): Promise<{ pid: number | undefined; profileDir: string }> {
  const chromePath = opts.chromePath ?? findChrome();
  if (!chromePath) throw new Error("未在常见位置找到 Chrome，可用环境变量 CUQ_CHROME_PATH 指定");
  const profileDir = opts.profileDir ?? defaultProfileDir();
  const timeoutMs = opts.readyTimeoutMs ?? 15_000;

  const child = spawn(chromePath, [...chromeArgs(browserPort(browserURL), profileDir, opts.headless), "about:blank"],
    { detached: true, stdio: "ignore" });
  const spawnFailed = new Promise<never>((_, rej) => {
    child.once("error", (e) => rej(new Error(`无法启动 ${chromePath}：${e.message}`)));
  });
  child.unref();

  const ready = (async () => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`${browserURL}/json/version`)).ok) return;
      } catch { /* 还没起来 */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(
      `Chrome 已启动，但 ${timeoutMs / 1000}s 内调试端口未就绪：端口可能被占用，` +
      `或该 profile 已被另一个未开调试端口的 Chrome 占用（${profileDir}）`
    );
  })();
  // 输掉竞速的一方稍后才 reject，没人接会变成未处理的 rejection
  spawnFailed.catch(() => {});
  ready.catch(() => {});
  await Promise.race([ready, spawnFailed]);
  return { pid: child.pid, profileDir };
}
