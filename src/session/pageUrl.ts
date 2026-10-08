import type { FailureContext } from "../types.js";

// 只处理明显的凭证键；不把未知业务参数都删掉，仍需保留可诊断的路由信息。
const SECRET_PARAM = /token|password|passwd|pwd|secret|credential|api[-_]?key|authorization|auth[-_]?code|^code$|^session(id)?$|密码|口令|密钥|令牌/i;

function redactParams(params: URLSearchParams): boolean {
  let changed = false;
  for (const key of new Set(params.keys())) {
    if (SECRET_PARAM.test(key)) {
      params.set(key, "[redacted]");
      changed = true;
    }
  }
  return changed;
}

/** 仅用于新增诊断字段的展示；基线比较必须使用原始 URL。 */
export function displayPageUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (!["http:", "https:", "file:", "about:"].includes(url.protocol)) {
      return `${url.protocol}（内容省略）`;
    }
    url.username = "";
    url.password = "";
    redactParams(url.searchParams);
    const hash = url.hash.slice(1);
    const queryStart = hash.indexOf("?");
    const prefix = queryStart < 0 ? "" : hash.slice(0, queryStart + 1);
    const fragmentQuery = queryStart < 0 ? hash : hash.slice(queryStart + 1);
    if (fragmentQuery.includes("=")) {
      const params = new URLSearchParams(fragmentQuery);
      if (redactParams(params)) url.hash = prefix + params.toString();
    }
    return url.href;
  } catch {
    return "（无法解析 URL）";
  }
}

export function pageChangeNotice(previous: string | undefined, current: string): string {
  if (previous === undefined || previous === current) return "";
  return `⚠ 页面自上次快照或批次结束后已变化（${displayPageUrl(previous)} → ${displayPageUrl(current)}），` +
    "ref 可能已失效，请先 snapshot 确认页面。\n\n";
}

/** 兼容旧归档；关闭后的 page.url() 只代表最后已知地址。 */
export function failureUrlNotice(failure: FailureContext): string {
  if (failure.currentUrl === undefined) return "";
  const label = failure.kind === "page-closed" ? "最后已知 URL（页面已关闭）" : "当前 URL";
  return `**${label}**：${failure.currentUrl}\n\n`;
}
