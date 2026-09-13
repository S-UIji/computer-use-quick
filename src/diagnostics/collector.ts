import type { PageHandle } from "../session/browser.js";

const MAX = 20;

function push(buf: string[], item: string): void {
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

  private consoleBuf: string[] = [];
  private networkBuf: string[] = [];

  private constructor(private handle: PageHandle) {}

  static async attach(handle: PageHandle): Promise<DiagnosticsCollector> {
    const existing = DiagnosticsCollector.instances.get(handle);
    if (existing) return existing;

    const c = new DiagnosticsCollector(handle);
    DiagnosticsCollector.instances.set(handle, c);

    await handle.cdp.send("Network.enable");
    await handle.cdp.send("Log.enable");

    handle.cdp.on("Runtime.consoleAPICalled", (e: {
      type: string;
      args: Array<{ value?: unknown; description?: string }>;
    }) => {
      if (e.type !== "error" && e.type !== "assert") return;
      push(c.consoleBuf, e.args.map((a) => String(a.value ?? a.description ?? "")).join(" "));
    });

    handle.cdp.on("Log.entryAdded", (e: { entry: { level: string; text: string } }) => {
      if (e.entry.level === "error") push(c.consoleBuf, e.entry.text);
    });

    handle.cdp.on("Network.responseReceived", (e: {
      response: { status: number; url: string };
    }) => {
      if (e.response.status >= 400) push(c.networkBuf, `${e.response.status} ${e.response.url}`);
    });

    handle.cdp.on("Network.loadingFailed", (e: { errorText: string; requestId: string }) => {
      push(c.networkBuf, `FAILED ${e.errorText} (req ${e.requestId})`);
    });

    return c;
  }

  consoleErrors(): string[] { return [...this.consoleBuf]; }
  failedRequests(): string[] { return [...this.networkBuf]; }
  clear(): void { this.consoleBuf = []; this.networkBuf = []; }

  async screenshot(): Promise<string> {
    const { data } = (await this.handle.cdp.send("Page.captureScreenshot", {
      format: "png"
    })) as { data: string };
    return data;
  }
}
