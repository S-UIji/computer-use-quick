import type { PageHandle } from "../session/browser.js";
import { PIXEL_FOX } from "./fox.js";
import { registerExecutionCleanup, restoreOverlayInput, executionCheckpoint } from "../executor/deadline.js";

const inputOwner = Math.random().toString(36).slice(2);
let inputSerial = 0;

export type OverlayState =
  | { kind: "active"; label: string; step: number; total: number; action: string; description?: string; details?: string }
  | { kind: "idle" }
  | { kind: "interrupted"; stopStep: number };

/** 角标文案（纯函数）。step / stopStep 为 1-based */
export function renderBadgeText(s: OverlayState): string {
  switch (s.kind) {
    case "active":
      return `正在操作 · ${s.step}/${s.total} · 悬停详情`;
    case "idle":
      return "agent 待命";
    case "interrupted":
      return `检测到你的操作，执行已停止（第 ${s.stopStep} 步未完成）`;
  }
}

export function renderBadgeDetails(s: OverlayState): string {
  return s.kind === "active"
    ? `computer-use-quick 正在操作 · ${s.label} · 第 ${s.step}/${s.total} 步\n${s.details ?? s.description ?? s.action}\n请勿操作页面 · 移入查看，滚轮阅读；点击仍作用于页面`
    : "";
}

const CSS = `
.wrap { position: fixed; inset: 0; pointer-events: none; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
.frame { position: absolute; inset: 0; border: 3px solid #7c3aed; box-shadow: inset 0 0 18px rgba(124, 58, 237, .45); }
.badge { position: absolute; right: 8px; bottom: 8px; width: max-content; max-width: calc(100% - 16px); padding: 4px 10px;
  border-radius: 999px; background: rgba(76, 29, 149, .92); color: #fff; white-space: nowrap; overflow: hidden;
  display: flex; align-items: center; gap: 6px; box-sizing: border-box; box-shadow: 0 2px 8px rgba(0, 0, 0, .25); }
.badge-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.details { position: absolute; right: 8px; bottom: 44px; width: max-content; max-width: min(420px, calc(100% - 16px));
  max-height: calc(100% - 52px); overflow: auto; overscroll-behavior: contain; box-sizing: border-box;
  white-space: pre-wrap; overflow-wrap: anywhere; padding: 10px 12px; border-radius: 10px;
  background: rgba(46, 16, 101, .96); color: #fff; box-shadow: 0 2px 8px rgba(0, 0, 0, .25); }
.details[hidden] { display: none; }
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
  max-width: calc(100% - 32px); padding: 3px 10px; font-size: 12px;
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
const APPLY_FN = `function (state, text, css, foxArt, detailText, owner, issuedInput) {
  var o = window.__cuqOverlay;
  if (!o || !o.host.isConnected || !o.fox || !o.label || !o.details || o.inputOwner !== owner) {
    if (o) {
      if (o.dispose) o.dispose();
      else document.removeEventListener("visibilitychange", o.onVisibilityChange);
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
    var details = document.createElement("div");
    details.className = "details";
    details.hidden = true;
    wrap.append(frame, badge, details);
    root.append(wrap);
    document.documentElement.appendChild(host);
    o = window.__cuqOverlay = { host: host, wrap: wrap, badge: badge, fox: fox, label: label, details: details, inputOwner: owner, inputLocks: new Set(), cancelledInputThrough: issuedInput };
    function inside(rect, x, y) { return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom; }
    o.hideDetails = function () { details.hidden = true; };
    o.onPointerMove = function (event, point) {
      point = point || event;
      if (wrap.getAttribute("data-state") !== "active" || document.hidden || wrap.hasAttribute("data-capture-hidden") || wrap.hasAttribute("data-agent-input")) {
        o.hideDetails(); return;
      }
      var b = badge.getBoundingClientRect();
      var over = inside(b, point.clientX, point.clientY);
      if (!details.hidden) {
        var d = details.getBoundingClientRect();
        over = over || inside(d, point.clientX, point.clientY) ||
          (point.clientX >= b.left && point.clientX <= b.right && point.clientY >= d.bottom && point.clientY <= b.top);
      }
      details.hidden = !over;
    };
    o.onWheel = function (event, point) {
      point = point || event;
      if (details.hidden || document.hidden || wrap.hasAttribute("data-capture-hidden") || wrap.hasAttribute("data-agent-input") ||
          !inside(details.getBoundingClientRect(), point.clientX, point.clientY)) return;
      if (!event.cancelable) return;
      event.preventDefault();
      var scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? details.clientHeight : 1;
      details.scrollTop += event.deltaY * scale;
    };
    var inputs = [];
    function pointInTop(win, event) {
      var x = event.clientX, y = event.clientY;
      while (win !== window) {
        var frame = win.frameElement, rect = frame.getBoundingClientRect();
        var sx = rect.width / (frame.offsetWidth || rect.width), sy = rect.height / (frame.offsetHeight || rect.height);
        x = rect.left + (x + frame.clientLeft) * sx;
        y = rect.top + (y + frame.clientTop) * sy;
        win = win.parent;
      }
      return { clientX: x, clientY: y };
    }
    function installInputs(win) {
      try {
        var doc = win.document;
        inputs.filter(function (entry) { return entry.win === win && entry.doc !== doc; }).forEach(function (entry) {
          entry.remove(); inputs.splice(inputs.indexOf(entry), 1);
        });
        if (!inputs.some(function (entry) { return entry.doc === doc; })) {
          var move = function (event) { o.onPointerMove(event, pointInTop(win, event)); };
          var wheel = function (event) { o.onWheel(event, pointInTop(win, event)); };
          var leave = function (event) { if (!event.relatedTarget) o.hideDetails(); };
          var scan = function () {
            inputs.slice().forEach(function (entry) {
              var current = false;
              try { current = entry.win.document === entry.doc && (entry.win === window || !!entry.win.frameElement?.isConnected); } catch (error) {}
              if (!current) { entry.remove(); inputs.splice(inputs.indexOf(entry), 1); }
            });
            installInputs(window);
          };
          doc.addEventListener("pointermove", move, { passive: true });
          doc.addEventListener("wheel", wheel, { passive: false });
          doc.addEventListener("pointerout", leave, { passive: true });
          doc.addEventListener("load", scan, true);
          var observer = new MutationObserver(scan);
          observer.observe(doc, { childList: true, subtree: true });
          inputs.push({ win: win, doc: doc, remove: function () {
            doc.removeEventListener("pointermove", move);
            doc.removeEventListener("wheel", wheel);
            doc.removeEventListener("pointerout", leave);
            doc.removeEventListener("load", scan, true);
            observer.disconnect();
          } });
        }
        for (var i = 0; i < win.frames.length; i++) installInputs(win.frames[i]);
      } catch (error) { /* Cross-origin frames are outside the supported frame input surface. */ }
    }
    installInputs(window);
    window.addEventListener("blur", o.hideDetails);
    o.dispose = function () {
      document.removeEventListener("visibilitychange", o.onVisibilityChange);
      inputs.splice(0).forEach(function (entry) { entry.remove(); });
      window.removeEventListener("blur", o.hideDetails);
    };
    o.onVisibilityChange = function () {
      wrap.setAttribute("data-motion-paused", document.hidden ? "true" : "false");
      if (document.hidden) o.hideDetails();
    };
    document.addEventListener("visibilitychange", o.onVisibilityChange);
    o.onVisibilityChange();
  }
  o.wrap.style.display = "";
  o.wrap.removeAttribute("data-capture-hidden");
  if (o.wrap.getAttribute("data-state") !== state) o.wrap.setAttribute("data-state", state);
  o.label.textContent = text;
  if (o.details.textContent !== detailText) { o.details.textContent = detailText; o.details.scrollTop = 0; }
  if (state !== "active" || document.hidden) o.hideDetails();
  return true;
}`;

const REMOVE_EXPR = `(function () {
  var o = window.__cuqOverlay;
  if (o) {
    if (o.dispose) o.dispose();
    else document.removeEventListener("visibilitychange", o.onVisibilityChange);
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
      `(${APPLY_FN})(${JSON.stringify(state.kind)}, ${JSON.stringify(renderBadgeText(state))}, ${JSON.stringify(CSS)}, ${JSON.stringify(PIXEL_FOX)}, ${JSON.stringify(renderBadgeDetails(state))}, ${JSON.stringify(inputOwner)}, ${inputSerial})`;
    if (await evalOk(handle, expression) && overlayEntries.get(handle) === entry) overlaid.add(handle);
  }).catch(() => { /* 标注是尽力而为。 */ });
  return entry.pending;
}

/** Automated wheel input must reach the page, even while the user is reading details. */
export async function withOverlayDetailsSuspended<T>(handle: PageHandle, fn: () => Promise<T>): Promise<T> {
  if (!overlaid.has(handle)) return fn();
  const serial = ++inputSerial;
  let restoration: Promise<unknown> | undefined;
  const restore = (): Promise<unknown> => restoration ??= restoreOverlayInput(handle, inputOwner, serial);
  const unregister = registerExecutionCleanup(async () => { await restore(); });
  try {
    await evalOk(handle, `(function () {
      var o = window.__cuqOverlay;
      if (o && o.inputOwner === ${JSON.stringify(inputOwner)} && ${serial} > o.cancelledInputThrough) {
        o.inputLocks.add(${serial});
        o.wrap.setAttribute("data-agent-input", "");
        o.hideDetails();
      }
      return true;
    })()`);
    executionCheckpoint();
    return await fn();
  } finally {
    try { await restore(); } finally { unregister(); }
  }
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
