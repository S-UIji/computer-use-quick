import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  it("tools/list 恰好暴露十个工具", async () => {
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const names = (await wait(2)).result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(
      ["batch", "discard_steps", "heal_step", "inspect", "list_pages", "replay", "replay_suite", "save_auth", "save_trace", "snapshot"]
    );
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

  it("tools/call list_pages 能列出标签页", async () => {
    send({ jsonrpc: "2.0", id: 8, method: "tools/call", params: {
      name: "list_pages", arguments: {}
    }});
    const text = (await wait(8)).result.content[0].text;
    expect(text).toContain("标签页");
    expect(text).toContain("*");
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
    const res = await wait(7);
    // 失败要在协议层可辨，而不是只体现在文案里
    expect(res.result.isError).toBe(true);
    const text = res.result.content[0].text;
    expect(text).toContain("❌");
    expect(text).toContain("target-not-found");
    expect(text).toContain("## 当前快照");
    expect(text).toContain("## console 报错");
  });

  it("heal_step：assert-failed 被服务端拒修（全自动写回的安全门）", async () => {
    const d = await mkdtemp(join(tmpdir(), "cuq-mcp-heal-"));
    try {
      const tracePath = join(d, "assert-fail.json");
      await writeFile(tracePath, JSON.stringify({
        name: "assert-fail", baseUrl: inject("fixtureURL"), createdAt: "",
        steps: [
          { action: "navigate", url: "/form.html" },
          { action: "assert", type: "text-equals",
            target: { descriptor: { strategies: [{ kind: "css", value: "#result" }], framePath: [] } },
            expected: "绝对不匹配的文本XYZ" }
        ]
      }), "utf8");

      send({ jsonrpc: "2.0", id: 9, method: "tools/call", params: {
        name: "replay", arguments: { tracePath }
      }});
      const replayRes = await wait(9);
      expect(replayRes.result.content[0].text).toContain("assert-failed");

      send({ jsonrpc: "2.0", id: 10, method: "tools/call", params: {
        name: "heal_step",
        arguments: { tracePath, actions: [
          { action: "click",
            target: { descriptor: { strategies: [{ kind: "css", value: "#submit" }], framePath: [] } } }
        ]}
      }});
      const res = await wait(10);
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toContain("不可自动修复");
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("heal_step：无失败记录时拒绝猜测目标步", async () => {
    const d = await mkdtemp(join(tmpdir(), "cuq-mcp-heal2-"));
    try {
      const tracePath = join(d, "never-run.json");
      await writeFile(tracePath, JSON.stringify({
        name: "never-run", baseUrl: inject("fixtureURL"), createdAt: "",
        steps: [{ action: "navigate", url: "/form.html" }]
      }), "utf8");

      send({ jsonrpc: "2.0", id: 11, method: "tools/call", params: {
        name: "heal_step",
        arguments: { tracePath, actions: [{ action: "sleep", ms: 1 }] }
      }});
      const res = await wait(11);
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toContain("没有待修复的失败记录");
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("snapshot diff：增量模式只回变化行，无变化时明说", async () => {
    // 基线：导航到 form 页并取一次全量快照
    send({ jsonrpc: "2.0", id: 15, method: "tools/call", params: {
      name: "batch",
      arguments: { steps: [{ action: "navigate", url: `${inject("fixtureURL")}/form.html` }] }
    }});
    await wait(15);
    send({ jsonrpc: "2.0", id: 16, method: "tools/call", params: {
      name: "snapshot", arguments: {}
    }});
    await wait(16);

    // 改动：填用户名（textbox 的 value 行变化）
    send({ jsonrpc: "2.0", id: 17, method: "tools/call", params: {
      name: "batch",
      arguments: { steps: [{ action: "fill", target: { descriptor: {
        strategies: [{ kind: "css", value: "#user" }], framePath: []
      }}, value: "admin" }] }
    }});
    await wait(17);

    // diff：只含变化行，不含全量快照头
    send({ jsonrpc: "2.0", id: 18, method: "tools/call", params: {
      name: "snapshot", arguments: { diff: true }
    }});
    const diffRes = await wait(18);
    const diffText = diffRes.result.content[0].text;
    expect(diffText).toContain("快照 diff");
    expect(diffText).toContain("+ ");
    expect(diffText).toContain("- ");
    expect(diffText).not.toContain("# 页面快照");

    // 再无变化时增量为空
    send({ jsonrpc: "2.0", id: 19, method: "tools/call", params: {
      name: "snapshot", arguments: { diff: true }
    }});
    const again = await wait(19);
    expect(again.result.content[0].text).toContain("无差异");
  });

  it("suite→heal 闭环：replay_suite 失败后 heal_step 直接消费（不带 stepIndex）", async () => {    const d = await mkdtemp(join(tmpdir(), "cuq-mcp-loop-"));
    try {
      const tracePath = join(d, "suite-broken.json");
      await writeFile(tracePath, JSON.stringify({
        name: "suite-broken", baseUrl: inject("fixtureURL"), createdAt: "",
        steps: [
          { action: "navigate", url: "/form.html" },
          { action: "click", target: { descriptor: {
            strategies: [{ kind: "role-name", role: "button", name: "不存在的按钮" }],
            framePath: []
          } } }
        ]
      }), "utf8");

      // 1. suite 批量跑：该 trace 失败，机读行 failed=1
      send({ jsonrpc: "2.0", id: 12, method: "tools/call", params: {
        name: "replay_suite", arguments: { tracePaths: [tracePath] }
      }});
      const suiteRes = await wait(12);
      const suiteText = suiteRes.result.content[0].text;
      expect(suiteText).toContain("target-not-found");
      const lastLine = suiteText.trim().split("\n").pop()!;
      expect(lastLine).toMatch(/^SUITE_RESULT ok=0 failed=1 total=1 wall_ms=\d+$/);

      // 2. 紧接着 heal_step 不带 stepIndex：必须直接消费 suite 的失败记录
      send({ jsonrpc: "2.0", id: 13, method: "tools/call", params: {
        name: "heal_step",
        arguments: { tracePath, actions: [{ action: "sleep", ms: 1 }] }
      }});
      const healRes = await wait(13);
      expect(healRes.result.isError ?? false).toBe(false);
      expect(healRes.result.content[0].text).toContain("自愈成功");

      // 3. 写回已固化到磁盘
      const healed = JSON.parse(await readFile(tracePath, "utf8"));
      expect(healed.steps[1].action).toBe("sleep");

      // 4.  healed 后 lastRun 是绿色记录：再 heal 应报「没有待修复的失败记录」
      send({ jsonrpc: "2.0", id: 14, method: "tools/call", params: {
        name: "heal_step",
        arguments: { tracePath, actions: [{ action: "sleep", ms: 1 }] }
      }});
      const again = await wait(14);
      expect(again.result.isError).toBe(true);
      expect(again.result.content[0].text).toContain("没有待修复的失败记录");
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});
