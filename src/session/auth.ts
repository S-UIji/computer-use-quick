import { readFile } from "node:fs/promises";
import type { PageHandle } from "./browser.js";

/**
 * 认证态（storageState 风格）：cookie + 各源 localStorage。
 * 捕获自登录后的页面，注入到运行/验证 Context——页面脚本运行前播种，
 * 否则 SPA 启动时读不到 localStorage。
 */

export interface AuthCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export interface AuthOrigin {
  origin: string;
  localStorage: Record<string, string>;
}

export interface AuthState {
  cookies: AuthCookie[];
  origins: AuthOrigin[];
  savedAt: string;
}

/** 从当前页面捕获认证态：cookie（Network 域）+ localStorage（evaluate dump） */
export async function captureAuth(handle: PageHandle): Promise<AuthState> {
  await handle.cdp.send("Network.enable").catch(() => {});
  const { cookies } = (await handle.cdp.send("Network.getCookies", {})) as {
    cookies: AuthCookie[];
  };

  const origin = new URL(handle.page.url()).origin;
  const { result } = (await handle.cdp.send("Runtime.evaluate", {
    expression: `JSON.stringify(Object.fromEntries(Object.entries(localStorage)))`,
    returnByValue: true
  })) as { result: { value?: string } };
  const localStorage: Record<string, string> = result.value ? JSON.parse(result.value) : {};

  return { cookies, origins: [{ origin, localStorage }], savedAt: new Date().toISOString() };
}

/**
 * 注入认证态到目标页面：cookie 直接写入；
 * localStorage 经 addScriptToEvaluateOnNewDocument 播种——必须抢在页面脚本运行前，
 * 且 origin 不匹配时安全跳过（不同源的页面不该被写入）。
 */
export async function applyAuth(handle: PageHandle, auth: AuthState): Promise<void> {
  await handle.cdp.send("Network.enable").catch(() => {});
  if (auth.cookies.length > 0) {
    await handle.cdp.send("Network.setCookies", {
      cookies: auth.cookies.map((c) => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path,
        expires: c.expires, httpOnly: c.httpOnly, secure: c.secure,
        // CDP 的 sameSite 是受限枚举，捕获侧按 string 存，写回时收窄
        sameSite: c.sameSite as "Strict" | "Lax" | "None" | undefined
      }))
    });
  }

  for (const o of auth.origins) {
    if (Object.keys(o.localStorage).length === 0) continue;
    const source = `(function () {
      if (location.origin !== ${JSON.stringify(o.origin)}) return;
      var d = ${JSON.stringify(o.localStorage)};
      for (var k in d) { try { localStorage.setItem(k, d[k]); } catch (e) {} }
    })()`;
    // Page 域必须先 enable，否则脚本不会挂到新文档上
    await handle.cdp.send("Page.enable").catch(() => {});
    await handle.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source });
  }
}

/** 从文件加载认证态；文件不存在或结构非法时返回 undefined（按未配置处理） */
export async function loadAuth(path: string): Promise<AuthState | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<AuthState>;
    if (!Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) return undefined;
    return {
      cookies: parsed.cookies,
      origins: parsed.origins,
      savedAt: parsed.savedAt ?? ""
    };
  } catch {
    return undefined;
  }
}
