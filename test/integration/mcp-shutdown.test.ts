import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { BrowserSession } from "../../src/session/browser.js";

/**
 * 退出路径：MCP 客户端结束会话时通常只是关掉 stdin（Windows 上收不到信号），
 * 服务端必须在这条路径上撤掉页面标注再退出，否则「待命」「已被打断」会一直残留。
 * 前置：先跑过 npm run build。
 */
let viewer: BrowserSession;

beforeAll(async () => {
  viewer = await BrowserSession.connect(inject("browserURL"));
});
afterAll(async () => { await viewer?.close(); });

async function overlayCount(): Promise<number> {
  let n = 0;
  for (const p of await viewer.listPages()) {
    const h = await viewer.getPage(p.pageId);
    const { result } = await h.cdp.send("Runtime.evaluate", {
      expression: `document.querySelectorAll("cuq-overlay").length`,
      returnByValue: true
    });
    n += result.value as number;
  }
  return n;
}

describe("MCP server 退出清理", () => {
  it("客户端关闭 stdin：撤掉页面标注后退出", async () => {
    const srv = spawn("node", ["dist/index.js"], {
      env: { ...process.env, CUQ_BROWSER_URL: inject("browserURL"), CUQ_WATCH: "on" },
      stdio: ["pipe", "pipe", "pipe"]
    }) as ChildProcessWithoutNullStreams;
    const replies: Array<{ id?: number }> = [];
    let buf = "";
    srv.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) { try { replies.push(JSON.parse(line)); } catch { /* 忽略非 JSON 行 */ } }
      }
    });
    const send = (o: unknown) => srv.stdin.write(JSON.stringify(o) + "\n");
    const wait = async (id: number) => {
      for (let t = 0; t < 300 && !replies.some((r) => r.id === id); t++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(replies.some((r) => r.id === id)).toBe(true);
    };
    const exited = new Promise<number | null>((res) => srv.on("exit", (code) => res(code)));

    try {
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" }
      }});
      await wait(1);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
        name: "batch",
        arguments: { steps: [{ action: "navigate", url: `${inject("fixtureURL")}/watch.html` }] }
      }});
      await wait(2);
      expect(await overlayCount()).toBe(1); // 执行结束后是「待命」标注

      srv.stdin.end();
      const code = await Promise.race([exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 8000))]);
      expect(code).toBe(0);
      expect(await overlayCount()).toBe(0);
    } finally {
      if (srv.exitCode === null) srv.kill();
    }
  });
});
