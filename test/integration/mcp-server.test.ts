import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * 真正把 dist/index.js 作为 MCP server 拉起来，走 stdio 协议对话。
 * 其余测试都直接调内部函数，只有这个覆盖工具注册、zod schema 和返回格式——
 * 也就是模型实际看到的那层。前置：先跑过 npm run build。
 */
let srv: ChildProcessWithoutNullStreams;
const replies: Array<{ id?: number; result?: any; error?: any }> = [];
let stderr = "";

function send(o: unknown): void {
  srv.stdin.write(JSON.stringify(o) + "\n");
}

function wait(id: number, ms = 15_000): Promise<{ result?: any; error?: any }> {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const r = replies.find((x) => x.id === id);
      if (r) { clearInterval(iv); res(r); }
      else if (Date.now() - t0 > ms) {
        clearInterval(iv);
        rej(new Error(`等待 id=${id} 超时。stderr: ${stderr.slice(0, 500)}`));
      }
    }, 50);
  });
}

beforeAll(async () => {
  srv = spawn("node", ["dist/index.js"], {
    env: { ...process.env, CUQ_BROWSER_URL: inject("browserURL") },
    stdio: ["pipe", "pipe", "pipe"]
  }) as ChildProcessWithoutNullStreams;

  srv.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

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

  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" }
  }});
  await wait(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
});

afterAll(() => { srv?.kill(); });

describe("MCP server（真实 stdio 协议）", () => {
  it("initialize 返回正确的服务名与版本", async () => {
    const r = await wait(1);
    expect(r.result.serverInfo).toMatchObject({ name: "computer-use-quick", version: "0.1.0" });
  });

  it("tools/list 恰好暴露五个工具", async () => {
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const names = (await wait(2)).result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["batch", "inspect", "replay", "save_trace", "snapshot"]);
  });

  it("刻意不提供单步 click/fill 工具（防止退回一次一步）", async () => {
    send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    const names = (await wait(3)).result.tools.map((t: { name: string }) => t.name);
    expect(names).not.toContain("click");
    expect(names).not.toContain("fill");
  });

  it("batch 的说明里写明了折叠组免 expand 的用法", async () => {
    send({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} });
    const batch = (await wait(4)).result.tools
      .find((t: { name: string }) => t.name === "batch");
    expect(batch.description).toContain("container-role-name");
    expect(batch.description).toContain("不需要先 expand");
  });

  it("tools/call snapshot 返回真实快照文本", async () => {
    send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "snapshot", arguments: {} } });
    const r = await wait(5);
    expect(r.result.content[0].type).toBe("text");
    expect(r.result.content[0].text).toContain("页面快照");
  });

  it("tools/call batch 能真的驱动页面", async () => {
    send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: {
      name: "batch",
      arguments: { steps: [
        { action: "navigate", url: `${inject("fixtureURL")}/form.html` },
        { action: "fill",
          target: { descriptor: { strategies: [{ kind: "css", value: "#user" }], framePath: [] } },
          value: "admin" },
        { action: "click",
          target: { descriptor: { strategies: [{ kind: "css", value: "#submit" }], framePath: [] } } },
        { action: "assert", type: "text-equals",
          target: { descriptor: { strategies: [{ kind: "css", value: "#result" }], framePath: [] } },
          expected: "欢迎 admin" }
      ]}
    }});
    const text = (await wait(6)).result.content[0].text;
    expect(text).toContain("✅");
    expect(text).toContain("4 步全部成功");
  });

  it("batch 失败时把失败上下文一次性返回给模型", async () => {
    send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: {
      name: "batch",
      arguments: { steps: [
        { action: "click",
          target: { descriptor: { strategies: [{ kind: "css", value: "#does-not-exist" }], framePath: [] } } }
      ]}
    }});
    const text = (await wait(7)).result.content[0].text;
    expect(text).toContain("❌");
    expect(text).toContain("target-not-found");
    expect(text).toContain("## 当前快照");
    expect(text).toContain("## console 报错");
  });
});
