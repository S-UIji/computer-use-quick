import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { freePort, startChrome } from "../fixtures/own-chrome.js";

/**
 * 启动顺序与断线恢复（真实 stdio）：Chrome 没开也要能握手；
 * 之后开、关、再开浏览器，都不需要重启 MCP 服务端。前置：先跑过 npm run build。
 */
let srv: ChildProcessWithoutNullStreams;
let port: number;
const replies: Array<{ id?: number; result?: any; error?: any }> = [];
let seq = 100;

async function call(method: string, params: unknown, ms = 20_000): Promise<any> {
  const id = ++seq;
  srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const r = replies.find((x) => x.id === id);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error(`等待 ${method} 超时`);
}
const snapshot = async () => (await call("tools/call", { name: "snapshot", arguments: {} })).result;

beforeAll(async () => {
  port = await freePort();
  srv = spawn("node", ["dist/index.js"], {
    env: { ...process.env, CUQ_BROWSER_URL: `http://127.0.0.1:${port}`, CUQ_LAUNCH: "" },
    stdio: ["pipe", "pipe", "pipe"]
  }) as ChildProcessWithoutNullStreams;
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
});
afterAll(() => { srv?.kill(); });

describe("MCP server：浏览器未开 / 断开", () => {
  it("Chrome 没开也能握手、列出工具；调用返回带启动命令的指引", async () => {
    const init = await call("initialize", {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" }
    });
    expect(init.result.serverInfo.name).toBe("computer-use-quick");
    srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    expect((await call("tools/list", {})).result.tools).toHaveLength(10);

    const r = await snapshot();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain(`--remote-debugging-port=${port}`);
    expect(r.content[0].text).toContain("无需重启 MCP 服务端");
  });

  it("随后打开 Chrome：同一服务端直接可用；关掉再开，自动重连并告知", async () => {
    const first = await startChrome(port);
    try {
      const ok = await snapshot();
      expect(ok.isError).toBeFalsy();
      expect(ok.content[0].text).toContain("页面快照");
    } finally {
      await first.stop();
    }

    // 断开事件异步到达：第一次可能还是原始协议错误，之后应当是指引
    let guidance = "";
    for (let i = 0; i < 20 && !guidance.includes("无需重启"); i++) {
      guidance = (await snapshot()).content[0].text;
      if (!guidance.includes("无需重启")) await new Promise((res) => setTimeout(res, 300));
    }
    expect(guidance).toContain("无需重启 MCP 服务端");

    const second = await startChrome(port);
    try {
      const again = await snapshot();
      expect(again.isError).toBeFalsy();
      expect(again.content[0].text).toContain("已重新连接");
      expect(again.content[0].text).toContain("页面快照");
    } finally {
      await second.stop();
    }
  });
});
