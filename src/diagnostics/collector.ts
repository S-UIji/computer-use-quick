import type { PageHandle } from "../session/browser.js";
import { withOverlayHidden } from "../watch/overlay.js";
import { executionCheckpoint } from "../executor/deadline.js";
import {
  Favicon404Filter, type Favicon404Evidence, type NetworkLogEntry,
  type DiagnosticRequest, type DiagnosticResponse
} from "./favicon.js";

const MAX = 20;

function push<T>(buf: T[], item: T): void {
  buf.push(item);
  if (buf.length > MAX) buf.shift();
}

/**
 * console 报错与失败请求的环形缓冲。batch 的失败上下文与 inspect 工具共用同一份数据——
 * 目的是让模型一次拿全排查所需信息，不用再多花几个 turn 追问现场。
 */
export class DiagnosticsCollector {
  /** 每个页面只挂一次监听，重复 attach 复用实例（重复挂会导致同一条报错被记多份） */
  private static instances = new WeakMap<PageHandle, DiagnosticsCollector>();
  private static initializing = new WeakMap<PageHandle, Promise<DiagnosticsCollector>>();

  private consoleBuf: Array<{ text: string; favicon?: Favicon404Evidence }> = [];
  private networkBuf: string[] = [];
  private favicon = new Favicon404Filter();

  private constructor(private handle: PageHandle) {}

  static async attach(handle: PageHandle): Promise<DiagnosticsCollector> {
    const existing = DiagnosticsCollector.instances.get(handle);
    if (existing) return existing;

    const pending = DiagnosticsCollector.initializing.get(handle);
    if (pending) return pending;
    const work = DiagnosticsCollector.initialize(handle);
    DiagnosticsCollector.initializing.set(handle, work);
    try { return await work; }
    finally {
      if (DiagnosticsCollector.initializing.get(handle) === work) DiagnosticsCollector.initializing.delete(handle);
    }
  }

  private static async initialize(handle: PageHandle): Promise<DiagnosticsCollector> {
    const c = new DiagnosticsCollector(handle);
    executionCheckpoint();
    await handle.cdp.send("Network.enable");
    executionCheckpoint();
    await handle.cdp.send("Log.enable");
    executionCheckpoint();

    handle.cdp.on("Runtime.consoleAPICalled", (e: {
      type: string;
      args: Array<{ value?: unknown; description?: string }>;
    }) => {
      if (e.type !== "error" && e.type !== "assert") return;
      push(c.consoleBuf, { text: e.args.map((a) => String(a.value ?? a.description ?? "")).join(" ") });
    });

    handle.cdp.on("Log.entryAdded", (e: { entry: NetworkLogEntry }) => {
      if (e.entry.level !== "error") return;
      const favicon = c.favicon.logEvidence(e.entry);
      if (!favicon?.confirmed) push(c.consoleBuf, { text: e.entry.text, favicon });
    });

    handle.cdp.on("Network.requestWillBeSent", (e: DiagnosticRequest) => c.favicon.requestStarted(e));

    handle.cdp.on("Network.responseReceived", (e: DiagnosticResponse) => {
      const favicon = c.favicon.responseReceived(e);
      if (favicon) {
        // Log can precede the response. Remove only entries tied to this generation,
        // keeping identical messages emitted by application console.error/assert.
        c.consoleBuf = c.consoleBuf.filter(item => item.favicon !== favicon);
      } else if (e.response.status >= 400) push(c.networkBuf, `${e.response.status} ${e.response.url}`);
    });

    handle.cdp.on("Network.loadingFailed", (e: { errorText: string; requestId: string }) => {
      c.favicon.requestFailed(e.requestId);
      push(c.networkBuf, `FAILED ${e.errorText} (req ${e.requestId})`);
    });

    DiagnosticsCollector.instances.set(handle, c);
    return c;
  }

  consoleErrors(): string[] { return this.consoleBuf.map(item => item.text); }
  failedRequests(): string[] { return [...this.networkBuf]; }
  clear(): void { this.consoleBuf = []; this.networkBuf = []; this.favicon.clear(); }

  async screenshot(): Promise<string> {
    // 失败现场截图、inspect 截图都不该拍进观察模式标注
    return withOverlayHidden(this.handle, async () => {
      const { data } = (await this.handle.cdp.send("Page.captureScreenshot", {
        format: "png"
      })) as { data: string };
      return data;
    });
  }
}
