import type { CDPSession } from "puppeteer-core";
import type { PageHandle } from "./browser.js";
import type { StepDialogOptions } from "../types.js";

export type DialogType = "alert" | "confirm" | "prompt" | "beforeunload";
export type DialogPolicy = NonNullable<StepDialogOptions["dialog"]>;

/** 一次被处理掉的弹窗，供步骤结果与工具返回报告 */
export interface HandledDialog {
  /** unknown：接管页面前就已开着的弹窗，只能盲关，类型与文字拿不到 */
  type: DialogType | "unknown";
  message: string;
  accepted: boolean;
  /** 处理依据：step=步骤写了 dialog；default=默认策略（确定）；fixed=alert/beforeunload 固定放行 */
  source: "step" | "default" | "fixed";
  /** true：弹窗在两次调用之间打开，到下一次调用开始时才处理 */
  pending?: boolean;
}

/**
 * 处理策略。alert 只能关、beforeunload 是 navigate 自己要离开，二者固定放行；
 * confirm/prompt 按步骤指定，未指定默认确定——agent 点「删除」通常就是要删，结果里会写明。
 */
export function decideDialog(
  type: DialogType,
  policy?: DialogPolicy
): { accept: boolean; source: HandledDialog["source"] } {
  if (type === "alert" || type === "beforeunload") return { accept: true, source: "fixed" };
  if (policy) return { accept: policy === "accept", source: "step" };
  return { accept: true, source: "default" };
}

const MAX_MESSAGE = 60;

export function describeDialog(d: HandledDialog): string {
  if (d.type === "unknown") return "页面上有接管前就已打开的弹窗（内容未知），本次调用开始前已按默认策略确定";
  const msg = d.message.length > MAX_MESSAGE ? d.message.slice(0, MAX_MESSAGE) + "…" : d.message;
  const what = d.type === "beforeunload" ? "离开页面确认" : `${d.type}「${msg}」`;
  let how: string;
  if (d.type === "beforeunload") how = "已放行";
  else if (d.type === "alert") how = "已关闭";
  else if (d.source === "step") how = `已按步骤要求${d.accepted ? "确定" : "取消"}`;
  else how = d.pending ? "已按默认策略确定" : '已按默认策略确定（要取消请给该步加 dialog: "dismiss"）';
  return d.pending
    ? `页面上有两次调用之间弹出的 ${what}，本次调用开始前${how}`
    : `触发${d.type === "beforeunload" ? "" : " "}${what}，${how}`;
}

interface OpenDialog {
  type: DialogType;
  message: string;
  defaultPrompt: string;
}

/**
 * 页面级弹窗守卫。弹窗开着时页面上的一切 CDP 调用（输入、求值、快照）都会挂住，必须有人关掉它。
 * agent 执行期间（armed）弹出的窗立即按策略处理；两次调用之间弹出的先不动——有头模式下
 * 可能是用户自己点出来的——等下一次取页时由 settlePending() 处理。处理记录攒着，供调用方报告。
 */
export class DialogGuard {
  private static readonly instances = new WeakMap<PageHandle, DialogGuard>();
  private armed = false;
  private step: StepDialogOptions = {};
  private open?: OpenDialog;
  private handled: HandledDialog[] = [];

  private constructor(private readonly handle: PageHandle) {}

  /** 建页时安装（幂等）。Page.enable 失败不抛错：弹窗处理是兜底能力，不能因此拿不到页面 */
  static async install(handle: PageHandle): Promise<DialogGuard> {
    const existing = DialogGuard.instances.get(handle);
    if (existing) return existing;
    const g = new DialogGuard(handle);
    DialogGuard.instances.set(handle, g);
    // 接管的页面上可能已开着弹窗（如用户自己的标签页）：此时 Page.enable 会挂住且不补发弹窗事件，
    // 新建的会话也看不到它（弹窗状态按会话记）。只有 puppeteer 建页时就开了 Page 域的主会话关得掉，先盲关一次
    const primary = (handle.page as unknown as { _client?: () => CDPSession })._client?.();
    if (primary) {
      const closed = await primary.send("Page.handleJavaScriptDialog", { accept: true }).then(() => true, () => false);
      if (closed) g.handled.push({ type: "unknown", message: "", accepted: true, source: "default", pending: true });
    }
    // 监听先于 enable 注册，enable 一生效就弹出的窗也不会漏
    handle.cdp.on("Page.javascriptDialogOpening", (e: { type: DialogType; message: string; defaultPrompt?: string }) => {
      void g.onOpening(e);
    });
    handle.cdp.on("Page.javascriptDialogClosed", () => { g.open = undefined; });
    await handle.cdp.send("Page.enable").catch(() => {});
    return g;
  }

  static for(handle: PageHandle): DialogGuard | undefined {
    return DialogGuard.instances.get(handle);
  }

  /** 进入执行期：之后弹出的窗立即处理。残留的处理记录属于上一次调用，丢弃 */
  arm(): void {
    this.armed = true;
    this.step = {};
    this.handled = [];
  }

  /** 当前步骤对弹窗的要求，每步开始时设置 */
  setStep(opts: StepDialogOptions): void {
    this.step = { dialog: opts.dialog, promptText: opts.promptText };
  }

  disarm(): void {
    this.armed = false;
    this.step = {};
  }

  /** 处理两次调用之间弹出、至今仍开着的窗，按默认策略 */
  async settlePending(): Promise<void> {
    if (this.open) await this.resolve(this.open, {}, true);
  }

  /** 取出自上次调用以来处理过的弹窗 */
  takeHandled(): HandledDialog[] {
    const h = this.handled;
    this.handled = [];
    return h;
  }

  private async onOpening(e: { type: DialogType; message: string; defaultPrompt?: string }): Promise<void> {
    const d: OpenDialog = { type: e.type, message: e.message, defaultPrompt: e.defaultPrompt ?? "" };
    this.open = d;
    if (this.armed) await this.resolve(d, this.step, false);
  }

  private async resolve(d: OpenDialog, step: StepDialogOptions, pending: boolean): Promise<void> {
    const { accept, source } = decideDialog(d.type, step.dialog);
    // prompt 确定时显式给文本：不给的话页面拿到空串，而不是弹窗自带的默认值
    const promptText = d.type === "prompt" && accept ? (step.promptText ?? d.defaultPrompt) : undefined;
    try {
      await this.handle.cdp.send("Page.handleJavaScriptDialog",
        promptText === undefined ? { accept } : { accept, promptText });
    } catch {
      return; // 已被关掉（用户手动点了，或页面没了），不记
    }
    if (this.open === d) this.open = undefined;
    this.handled.push({ type: d.type, message: d.message, accepted: accept, source, ...(pending ? { pending: true } : {}) });
  }
}
