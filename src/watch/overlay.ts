import type { PageHandle } from "../session/browser.js";
import { PIXEL_FOX } from "./fox.js";

export type OverlayState =
  | { kind: "active"; label: string; step: number; total: number; action: string; description?: string }
  | { kind: "idle" }
  | { kind: "interrupted"; stopStep: number };

/** 角标文案（纯函数）。step / stopStep 为 1-based */
export function renderBadgeText(s: OverlayState): string {
  switch (s.kind) {
    case "active":
      return `computer-use-quick 正在操作 · ${s.label} · 第 ${s.step}/${s.total} 步 ${s.description ?? s.action} · 请勿操作页面`;
    case "idle":
      return "agent 待命";
    case "interrupted":
      return `检测到你的操作，执行已停止（第 ${s.stopStep} 步未完成）`;
  }
}

const CSS = `
.wrap { position: fixed; inset: 0; pointer-events: none; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
.frame { position: absolute; inset: 0; border: 3px solid #7c3aed; box-shadow: inset 0 0 18px rgba(124, 58, 237, .45); }
.badge { position: absolute; top: 8px; left: 50%; transform: translateX(-50%); width: max-content; max-width: 80vw; padding: 4px 12px;
  border-radius: 999px; background: rgba(76, 29, 149, .92); color: #fff; white-space: nowrap; overflow: hidden;
  display: flex; align-items: center; gap: 6px; box-sizing: border-box; box-shadow: 0 2px 8px rgba(0, 0, 0, .25); }
.badge-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.fox { display: block; flex: 0 0 24px; width: 24px; height: 24px; overflow: visible; }
.fox-eyes-closed { opacity: 0; }
.fox-eyes-alert { display: none; }
.wrap[data-state="active"] .fox { animation: cuq-fox-working 1.6s steps(1, end) infinite; }
.wrap[data-state="idle"] .fox-eyes-open { animation: cuq-fox-open 5s steps(1, end) infinite; }
.wrap[data-state="idle"] .fox-eyes-closed { animation: cuq-fox-blink 5s steps(1, end) infinite; }
.wrap[data-state="interrupted"] .fox { animation: cuq-fox-notice .48s steps(1, end) 1; }
.wrap[data-state="interrupted"] .fox-eyes-open,
.wrap[data-state="interrupted"] .fox-eyes-closed { display: none; }
.wrap[data-state="interrupted"] .fox-eyes-alert { display: block; }
.wrap[data-capture-hidden] { visibility: hidden !important; }
.wrap[data-motion-paused="true"] *, .wrap[data-capture-hidden] * { animation-play-state: paused !important; }
.wrap[data-state="active"] .frame { animation: cuq-pulse 1.6s ease-in-out infinite; }
.wrap[data-state="idle"] .badge, .wrap[data-state="interrupted"] .badge {
  top: auto; left: auto; right: 8px; bottom: 8px; transform: none;
  max-width: calc(100vw - 32px); padding: 3px 10px; font-size: 12px;
}
.wrap[data-state="idle"] .frame { display: none; }
.wrap[data-state="idle"] .badge { background: rgba(55, 65, 81, .72); }
.wrap[data-state="interrupted"] .frame { border-color: #dc2626; box-shadow: inset 0 0 18px rgba(220, 38, 38, .45);
  animation: cuq-flash .6s ease-out 1; }
.wrap[data-state="interrupted"] .badge { background: rgba(185, 28, 28, .92); }
@keyframes cuq-pulse { 50% { box-shadow: inset 0 0 6px rgba(124, 58, 237, .25); } }
@keyframes cuq-flash { from { opacity: .2; } to { opacity: 1; } }
@keyframes cuq-fox-working { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-1px); } }
@keyframes cuq-fox-open { 0%, 94%, 98%, 100% { opacity: 1; } 95%, 97% { opacity: 0; } }
@keyframes cuq-fox-blink { 0%, 94%, 98%, 100% { opacity: 0; } 95%, 97% { opacity: 1; } }
@keyframes cuq-fox-notice { 0%, 100% { transform: translateY(0); } 33%, 66% { transform: translateY(-1px); } }
@media (prefers-reduced-motion: reduce) {
  .frame, .fox, .fox-eyes-open, .fox-eyes-closed { animation: none !important; }
}
`;

/**
 * 页面侧：幂等地挂上标注并应用状态。宿主挂在 <html> 下（body 之外，不影响 /html/body[1]/… 路径），
 * 内容放进封闭 shadow root——light DOM 上的 MutationObserver（隐式等待）看不到内部更新；
 * aria-hidden 让整棵子树不进无障碍快照；pointer-events:none 让 elementFromPoint 命中检测跳过它。
 * 样式走 adoptedStyleSheets + CSSOM，不插 <style>，避开页面 CSP 对内联样式的拦截。
 */
const APPLY_FN = `function (state, text, css, foxArt) {
  var o = window.__cuqOverlay;
  if (!o || !o.host.isConnected || !o.fox || !o.label) {
    if (o) {
      document.removeEventListener("visibilitychange", o.onVisibilityChange);
      o.host.remove();
    }
    var host = document.createElement("cuq-overlay");
    host.setAttribute("aria-hidden", "true");
    var hs = host.style;
    hs.setProperty("all", "initial", "important");
    hs.setProperty("position", "fixed", "important");
    hs.setProperty("inset", "0", "important");
    hs.setProperty("pointer-events", "none", "important");
    hs.setProperty("z-index", "2147483647", "important");
    var root = host.attachShadow({ mode: "closed" });
    var sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];
    var wrap = document.createElement("div");
    wrap.className = "wrap";
    var frame = document.createElement("div");
    frame.className = "frame";
    var badge = document.createElement("div");
    badge.className = "badge";
    var ns = "http://www.w3.org/2000/svg";
    var fox = document.createElementNS(ns, "svg");
    fox.setAttribute("class", "fox");
    fox.setAttribute("viewBox", "0 0 " + foxArt.size + " " + foxArt.size);
    fox.setAttribute("width", foxArt.size);
    fox.setAttribute("height", foxArt.size);
    fox.setAttribute("shape-rendering", "crispEdges");
    fox.setAttribute("aria-hidden", "true");
    fox.setAttribute("focusable", "false");
    function addPath(d, fill, className) {
      var path = document.createElementNS(ns, "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", fill);
      if (className) path.setAttribute("class", className);
      fox.appendChild(path);
    }
    foxArt.paths.forEach(function (path) { addPath(path.d, path.fill); });
    Object.keys(foxArt.eyes).forEach(function (kind) {
      addPath(foxArt.eyes[kind], foxArt.ink, "fox-eyes-" + kind);
    });
    var label = document.createElement("span");
    label.className = "badge-text";
    badge.append(fox, label);
    wrap.append(frame, badge);
    root.append(wrap);
    document.documentElement.appendChild(host);
    o = window.__cuqOverlay = { host: host, wrap: wrap, badge: badge, fox: fox, label: label };
    o.onVisibilityChange = function () {
      wrap.setAttribute("data-motion-paused", document.hidden ? "true" : "false");
    };
    document.addEventListener("visibilitychange", o.onVisibilityChange);
    o.onVisibilityChange();
  }
  o.wrap.style.display = "";
  o.wrap.removeAttribute("data-capture-hidden");
  if (o.wrap.getAttribute("data-state") !== state) o.wrap.setAttribute("data-state", state);
  o.label.textContent = text;
  return true;
}`;

const REMOVE_EXPR = `(function () {
  var o = window.__cuqOverlay;
  if (o) {
    document.removeEventListener("visibilitychange", o.onVisibilityChange);
    o.host.remove(); window.__cuqOverlay = undefined;
  }
  return true;
})()`;

/** 挂过标注的页面；截图路径据此跳过从未挂过标注的页面，headless 零额外往返 */
const overlaid = new WeakSet<PageHandle>();

async function evalOk(handle: PageHandle, expression: string): Promise<boolean> {
  try {
    const r = (await handle.cdp.send("Runtime.evaluate", { expression, returnByValue: true })) as {
      exceptionDetails?: unknown;
    };
    return !r.exceptionDetails;
  } catch {
    return false;
  }
}

interface OverlayEntry {
  state: OverlayState;
  hidden: number;
  pending: Promise<void>;
  dispose: () => void;
}
const overlayEntries = new WeakMap<PageHandle, OverlayEntry>();

function forgetOverlay(handle: PageHandle, entry: OverlayEntry): void {
  if (overlayEntries.get(handle) !== entry) return;
  overlayEntries.delete(handle);
  overlaid.delete(handle);
  entry.dispose();
}

function overlayEntry(handle: PageHandle, state: OverlayState): OverlayEntry {
  const existing = overlayEntries.get(handle);
  if (existing) {
    existing.state = state;
    return existing;
  }
  const entry: OverlayEntry = { state, hidden: 0, pending: Promise.resolve(), dispose: () => {} };
  overlayEntries.set(handle, entry);
  const restore = () => { void applyLatest(handle, entry); };
  const closed = () => { forgetOverlay(handle, entry); };
  entry.dispose = () => {
    try {
      handle.page.off("domcontentloaded", restore);
      handle.page.off("close", closed);
    } catch { /* 假句柄和已销毁页面也不影响执行。 */ }
  };
  try {
    handle.page.on("domcontentloaded", restore);
    handle.page.once("close", closed);
  } catch { entry.dispose(); }
  return entry;
}

/** 串行应用最新状态；截图隐藏和移除期间不会被晚到的导航恢复覆盖。 */
function applyLatest(handle: PageHandle, entry: OverlayEntry): Promise<void> {
  entry.pending = entry.pending.then(async () => {
    if (overlayEntries.get(handle) !== entry || entry.hidden > 0) return;
    const state = entry.state;
    const expression =
      `(${APPLY_FN})(${JSON.stringify(state.kind)}, ${JSON.stringify(renderBadgeText(state))}, ${JSON.stringify(CSS)}, ${JSON.stringify(PIXEL_FOX)})`;
    if (await evalOk(handle, expression) && overlayEntries.get(handle) === entry) overlaid.add(handle);
  }).catch(() => { /* 标注是尽力而为。 */ });
  return entry.pending;
}

/** 首次展示时订阅主文档加载；后续调用只更新同一页的最近状态。 */
export async function showOverlay(handle: PageHandle, state: OverlayState): Promise<void> {
  if (handle.page.isClosed?.()) return;
  await applyLatest(handle, overlayEntry(handle, state));
}

export class BackgroundScreenshotError extends Error {
  constructor() {
    super("后台标签暂无可用截图渲染帧，未切换用户标签；请手动选中该页，并核实已执行步骤后继续截图。");
    this.name = "BackgroundScreenshotError";
  }
}

/** 隐藏期间暂停导航恢复；嵌套隐藏全部结束后才恢复最新状态。 */
export async function withOverlayHidden<T>(handle: PageHandle, fn: () => Promise<T>): Promise<T> {
  // Headless 无人界面沿用可渲染页；有头后台截图不抢用户标签或等待缺失帧。
  if (handle.headless === true) await handle.cdp.send("Page.bringToFront");
  else if (await handle.page.evaluate(() => document.visibilityState) !== "visible") throw new BackgroundScreenshotError();
  const entry = overlayEntries.get(handle);
  if (!entry && !overlaid.has(handle)) return fn();
  if (entry) {
    entry.hidden += 1;
    await entry.pending;
  }
  try {
    const hidden =
      // visibility keeps CSS animation objects/timelines alive; display:none
      // would replay a settled interrupted alert after every inspection.
      await evalOk(handle, `window.__cuqOverlay ? (window.__cuqOverlay.wrap.setAttribute("data-capture-hidden", ""), true) : true`) ||
      await evalOk(handle, REMOVE_EXPR);
    if (!hidden) console.error("[computer-use-quick] 截图前隐藏标注失败，截图可能含标注");
    return await fn();
  } finally {
    if (entry) {
      entry.hidden -= 1;
      if (entry.hidden === 0) await applyLatest(handle, entry);
    } else {
      await evalOk(handle, `window.__cuqOverlay && window.__cuqOverlay.wrap.removeAttribute("data-capture-hidden")`);
    }
  }
}

/** 先取消恢复并等待已发送的应用，再移除宿主，避免异步重挂。 */
export async function removeOverlay(handle: PageHandle): Promise<void> {
  const entry = overlayEntries.get(handle);
  if (entry) {
    forgetOverlay(handle, entry);
    await entry.pending;
  }
  await evalOk(handle, REMOVE_EXPR);
  overlaid.delete(handle);
}

/** 服务端退出时清理：只处理挂过标注的页面，总时长封顶，不拖住退出 */
export async function removeAllOverlays(handles: PageHandle[], timeoutMs = 1000): Promise<void> {
  await Promise.race([
    Promise.all(handles.filter((h) => overlaid.has(h) || overlayEntries.has(h)).map(removeOverlay)),
    new Promise<void>((resolve) => { setTimeout(resolve, timeoutMs).unref(); })
  ]);
}
