// 一次性端到端验证：独立 Chrome（临时 profile + 9223）+ 真实 MCP stdio 协议 + 靶场 replay
// 用法：node .scratch/e2e-replay.mjs
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9223;
const profile = mkdtempSync(join(tmpdir(), "cuq-e2e-"));

const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check",
  "about:blank"
], { stdio: "ignore" });

async function waitDevtools(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Chrome DevTools 端点未就绪");
}

const srv = spawn("node", ["dist/index.js"], {
  env: { ...process.env, CUQ_BROWSER_URL: `http://127.0.0.1:${PORT}` },
  stdio: ["pipe", "pipe", "pipe"]
});
let stderr = "";
srv.stderr.on("data", (d) => { stderr += d.toString(); });

const replies = [];
let buf = "";
srv.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) { try { replies.push(JSON.parse(line)); } catch { /* 忽略 */ } }
  }
});
function send(o) { srv.stdin.write(JSON.stringify(o) + "\n"); }
function wait(id, ms = 120000) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const r = replies.find((x) => x.id === id);
      if (r) { clearInterval(iv); res(r); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error(`等待 id=${id} 超时。stderr: ${stderr.slice(0, 800)}`)); }
    }, 50);
  });
}

try {
  const ver = await waitDevtools();
  console.log(`Chrome 就绪: ${ver.Browser}`);

  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0" }
  }});
  await wait(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const tools = (await wait(2)).result.tools.map((t) => t.name);
  console.log(`工具面: ${tools.join(", ")}`);

  const t0 = Date.now();
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
    name: "replay",
    arguments: { tracePath: resolve("traces/smoke-login.json") }
  }});
  const r = await wait(3);
  console.log(`\n===== replay 结果（${Date.now() - t0}ms 往返）=====\n`);
  console.log(r.result.content[0].text);
  if (r.result.isError) process.exitCode = 2;
} finally {
  srv.kill();
  try { execSync(`taskkill /PID ${chrome.pid} /T /F`, { stdio: "ignore" }); } catch { /* 尽力 */ }
  chrome.kill();
  // Windows 下进程退出到句柄释放有竞态，rm 带重试
  for (let i = 0; i < 10; i++) {
    try { rmSync(profile, { recursive: true, force: true }); break; }
    catch { await new Promise((r) => setTimeout(r, 500)); }
  }
}
