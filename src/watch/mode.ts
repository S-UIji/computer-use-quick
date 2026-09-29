/** 观察模式开关：CUQ_WATCH=auto|on|off */
export type WatchSetting = "auto" | "on" | "off";

/** 解析环境变量；非法值按 auto 处理，并返回一行告警供调用方输出到 stderr */
export function parseWatchSetting(raw: string | undefined): { setting: WatchSetting; warning?: string } {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return { setting: "auto" };
  if (v === "auto" || v === "on" || v === "off") return { setting: v };
  return { setting: "auto", warning: `CUQ_WATCH=${JSON.stringify(raw)} 不是 auto/on/off，按 auto 处理` };
}

/**
 * auto 只在有头浏览器上启用——headless 下无人观看，也不可能有用户输入。
 * UA 取不到（探测失败）时按未启用处理：宁可少提示，也不碰 CI 路径。
 */
export function resolveWatchEnabled(setting: WatchSetting, userAgent: string | undefined): boolean {
  if (setting === "on") return true;
  if (setting === "off") return false;
  return userAgent !== undefined && !userAgent.includes("HeadlessChrome");
}
