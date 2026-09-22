// 真实靶场压测：3 份 smoke-login 复制，replay_suite 串行 vs 3 并发对照
// 用法：node scripts/e2e-suite.mjs
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9223;
const profile = mkdtempSync(join(tmpdir(), "cuq-suite-"));
const work = mkdtempSync(join(tmpdir(), "cuq-suite-traces-"));

// 3 份 smoke-login 复制（名字不同，步骤相同）
const base = JSON.parse(readFileSync("traces/smoke-login.json", "utf8"));
const paths = [];
for (let i = 1; i <= 3; i++) {
  const p = join(work, `suite-${i}.json`);
  writeFileSync(p, JSON.stringify({ ...base, name: `suite-${i}` }, null, 2) + "\n", "utf8");
  paths.push(p);
}

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
      if (r.ok) return;
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

async function runSuiteOnce(id, concurrency) {
  const t0 = Date.now();
  send({ jsonrpc: "2.0", id, method: "tools/call", params: {
    name: "replay_suite",
    arguments: { tracePaths: paths, concurrency }
  }});
  const r = await wait(id);
  return { wallMs: Date.now() - t0, text: r.result?.content?.[0]?.text ?? JSON.stringify(r.error) };
}

try {
  await waitDevtools();
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-suite", version: "0" }
  }});
  await wait(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  console.log(`\n########## 串行基线（concurrency=1，3 份 smoke-login）##########`);
  const serial = await runSuiteOnce(2, 1);
  console.log(`墙钟 ${(serial.wallMs / 1000).toFixed(1)}s\n${serial.text}`);

  console.log(`\n########## 并行（concurrency=3，3 份 smoke-login）##########`);
  const par = await runSuiteOnce(3, 3);
  console.log(`墙钟 ${(par.wallMs / 1000).toFixed(1)}s\n${par.text}`);

  console.log(`\n########## 对照 ##########`);
  console.log(`串行 ${(serial.wallMs / 1000).toFixed(1)}s → 并行 ${(par.wallMs / 1000).toFixed(1)}s，` +
    `加速比 ${(serial.wallMs / par.wallMs).toFixed(2)}x`);
} finally {
  srv.kill();
  try { execSync(`taskkill /PID ${chrome.pid} /T /F`, { stdio: "ignore" }); } catch { /* 尽力 */ }
  chrome.kill();
  for (let i = 0; i < 10; i++) {
    try { rmSync(profile, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); break; }
    catch { await new Promise((r) => setTimeout(r, 500)); }
  }
}
