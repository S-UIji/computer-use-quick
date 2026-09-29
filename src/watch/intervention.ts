import type { PageHandle } from "../session/browser.js";
import type { UserInterruption } from "../executor/observer.js";

export type ReportedType = "pointerdown" | "keydown" | "wheel";
export type AgentInputKind = "mouse" | "key" | "wheel";

/** 页面侧上报的一次可信输入；at 为服务端收到上报的时刻 */
export interface ReportedInput {
  type: ReportedType;
  x: number;
  y: number;
  top: boolean;
  at: number;
}

/** agent 的一次派发时间窗；end 未定表示仍在派发中 */
export interface AgentWindow {
  kind: AgentInputKind;
  x?: number;
  y?: number;
  start: number;
  end?: number;
}

export const AGENT_GRACE_MS = 150;
export const COORD_TOLERANCE_PX = 2;
export const LATE_MATCH_MS = 1000;

export type Attribution = "agent" | "user" | "user-scroll";

const KIND_OF: Record<ReportedType, AgentInputKind> = { pointerdown: "mouse", keydown: "key", wheel: "wheel" };

/** 判定一次上报输入来自 agent 还是用户（纯函数，规则见设计文档 §4.3） */
export function attribute(ev: ReportedInput, windows: readonly AgentWindow[]): Attribution {
  const kind = KIND_OF[ev.type];
  const within = (w: AgentWindow, slack: number): boolean =>
    w.kind === kind && ev.at >= w.start && (w.end === undefined || ev.at <= w.end + slack);
  const coordsMatch = (w: AgentWindow): boolean =>
    w.x !== undefined && w.y !== undefined &&
    Math.abs(ev.x - w.x) <= COORD_TOLERANCE_PX && Math.abs(ev.y - w.y) <= COORD_TOLERANCE_PX;

  const agent = ev.type === "pointerdown" && ev.top
    // 顶层 frame 的坐标与派发坐标同系：必须坐标吻合；吻合时放宽到 1s，兜底上报晚到
    ? windows.some((w) => within(w, LATE_MATCH_MS) && coordsMatch(w))
    // iframe 内坐标系不同，只看时间窗；按键与滚轮同理
    : windows.some((w) => within(w, AGENT_GRACE_MS));
  if (agent) return "agent";
  return ev.type === "wheel" ? "user-scroll" : "user";
}

const BINDING = "__cuqUserInput";

/**
 * 页面侧监听脚本（幂等）：捕获阶段监听可信的 pointerdown/keydown/wheel，经 binding 上报，并递归覆盖同源 iframe。
 * 只报类型、坐标与是否顶层——不报按键值，用户可能正在输密码。
 */
const LISTENER_SCRIPT = `(function () {
  function install(win, top) {
    try {
      if (win.__cuqInputListener) return;
      win.__cuqInputListener = true;
      var report = function (e) {
        if (!e.isTrusted || typeof win.${BINDING} !== "function") return;
        win.${BINDING}(JSON.stringify({ type: e.type, x: e.clientX || 0, y: e.clientY || 0, top: top }));
      };
      win.addEventListener("pointerdown", report, true);
      win.addEventListener("keydown", report, true);
      win.addEventListener("wheel", report, { capture: true, passive: true });
      for (var i = 0; i < win.frames.length; i++) install(win.frames[i], false);
    } catch (e) { /* 跨源 frame 访问被拒，跳过 */ }
  }
  install(window, window === window.top);
})()`;

/**
 * 每个页面一个介入监视器。只在执行期（armed）记账：待命时用户可以随便操作（例如手动登录）。
 * binding 与事件监听只装一次；新文档脚本随每次执行注册、结束注销。
 */
export class InterventionMonitor {
  private static instances = new WeakMap<PageHandle, InterventionMonitor>();

  /** 安装失败原因；有值时本次执行不做介入检测 */
  installError?: string;
  private armed = false;
  private installed = false;
  private scriptId?: string;
  private windows: AgentWindow[] = [];
  private pending?: UserInterruption;
  private scrolls = 0;

  private constructor(private readonly handle: PageHandle) {}

  static for(handle: PageHandle): InterventionMonitor {
    let m = InterventionMonitor.instances.get(handle);
    if (!m) {
      m = new InterventionMonitor(handle);
      InterventionMonitor.instances.set(handle, m);
    }
    return m;
  }

  /** 进入执行期：安装（幂等）、注册新文档脚本、清空上一轮状态。失败只记原因，不抛错 */
  async arm(): Promise<void> {
    await this.removeScript();
    this.windows = [];
    this.pending = undefined;
    this.scrolls = 0;
    this.installError = undefined;
    try {
      const cdp = this.handle.cdp;
      if (!this.installed) {
        await cdp.send("Page.enable");
        await cdp.send("Runtime.addBinding", { name: BINDING });
        cdp.on("Runtime.bindingCalled", (e: { name: string; payload: string }) => {
          if (e.name === BINDING) this.onReport(e.payload);
        });
        this.installed = true;
      }
      const { identifier } = (await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: LISTENER_SCRIPT
      })) as { identifier: string };
      this.scriptId = identifier;
      await cdp.send("Runtime.evaluate", { expression: LISTENER_SCRIPT });
      this.armed = true;
    } catch (err) {
      this.installError = err instanceof Error ? err.message : String(err);
      this.armed = false;
    }
  }

  /** 退出执行期：之后的上报一律忽略 */
  async disarm(): Promise<void> {
    this.armed = false;
    await this.removeScript();
  }

  beginAgentInput(kind: AgentInputKind, point?: { x: number; y: number }): AgentWindow {
    const w: AgentWindow = { kind, x: point?.x, y: point?.y, start: Date.now() };
    // 判定最多回看 1s（LATE_MATCH_MS），留 2s 内的窗口足够
    const cutoff = Date.now() - 2000;
    this.windows = this.windows.filter((x) => x.end === undefined || x.end >= cutoff);
    this.windows.push(w);
    return w;
  }

  endAgentInput(w: AgentWindow): void {
    w.end = Date.now();
  }

  takeUserInput(): UserInterruption | undefined {
    const p = this.pending;
    this.pending = undefined;
    return p;
  }

  takeScrollCount(): number {
    const n = this.scrolls;
    this.scrolls = 0;
    return n;
  }

  private async removeScript(): Promise<void> {
    const id = this.scriptId;
    this.scriptId = undefined;
    if (id) {
      await this.handle.cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: id }).catch(() => {});
    }
  }

  private onReport(payload: string): void {
    if (!this.armed) return;
    let p: { type: ReportedType; x: number; y: number; top: boolean };
    try {
      p = JSON.parse(payload);
    } catch {
      return;
    }
    const verdict = attribute({ ...p, at: Date.now() }, this.windows);
    if (verdict === "user" && !this.pending && p.type !== "wheel") {
      this.pending = { type: p.type, x: p.x, y: p.y };
    } else if (verdict === "user-scroll") {
      this.scrolls++;
    }
  }
}
