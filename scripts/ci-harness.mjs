// CI 无人值守挂接点：基础设施 + 终判门。自愈循环由 CI agent 经 MCP 驱动，本脚本不自愈。
//
//   node scripts/ci-harness.mjs up                    起 headless Chrome，环境写入 .scratch/ci-env.json
//   node scripts/ci-harness.mjs gate [--traces dir]   对 traces 目录跑 replay_suite 终判，退出码 0/1，随后清理
//   node scripts/ci-harness.mjs down                  手动清理（一般 gate 已代劳）
//
// pipeline 典型接法：
//   1. ci-harness up
//   2. CI agent 用 .scratch/ci-env.json 里的 browserURL 配置 MCP，跑自愈循环（见 docs/ci-unattended-loop.md）
//   3. ci-harness gate   ← 退出码即流水线退出码
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9333;
const ENV_FILE = resolve(".scratch/ci-env.json");
const cmd = process.argv[2];

function fail(msg) { console.error(`✗ ${msg}`); process.exit(2); }

async function waitDevtools(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  fail("Chrome DevTools 端点未就绪");
}

function readEnv() {
  if (!existsSync(ENV_FILE)) fail("未找到 .scratch/ci-env.json，先跑 up");
  return JSON.parse(readFileSync(ENV_FILE, "utf8"));
}

function cleanup(env) {
  try { execSync(`taskkill /PID ${env.chromePid} /T /F`, { stdio: "ignore" }); } catch { /* 尽力 */ }
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(env.profile, { recursive: true, force: true });
      rmSync(ENV_FILE, { force: true });
      return;
    } catch { /* Windows 句柄释放竞态 */ }
  }
}

if (cmd === "up") {
  if (existsSync(ENV_FILE)) fail("已有环境文件，先 gate（自动清理）或 down");
  const profile = mkdtempSync(join(tmpdir(), "cuq-ci-"));
  // detached + unref：Chrome 必须活过本进程——up 先退出、gate 后启动，
  // 不脱离进程组的话，node 退出时 Chrome 会跟着被回收
  const chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check",
    "about:blank"
  ], { stdio: "ignore", detached: true });
  chrome.unref();
  await waitDevtools();
  writeFileSync(ENV_FILE, JSON.stringify({
    browserURL: `http://127.0.0.1:${PORT}`,
    chromePid: chrome.pid,
    profile
  }, null, 2), "utf8");
  console.log(`✓ Chrome 就绪：CUQ_BROWSER_URL=http://127.0.0.1:${PORT}（环境已写入 ${ENV_FILE}）`);
  process.exit(0);
}

if (cmd === "down") {
  cleanup(readEnv());
  console.log("✓ 已清理");
  process.exit(0);
}

if (cmd === "gate") {
  const tracesIdx = process.argv.indexOf("--traces");
  const dir = tracesIdx >= 0 ? process.argv[tracesIdx + 1] : "traces";
  const env = readEnv();
  const paths = readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
    .map((f) => resolve(join(dir, f)));
  if (paths.length === 0) fail(`${dir} 下没有 .json trace`);

  // 短命 server：终判只信磁盘上的 trace 文件，与任何进程内存无关
  const srv = spawn("node", ["dist/index.js"], {
    env: { ...process.env, CUQ_BROWSER_URL: env.browserURL },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const replies = [];
  let buf = "", stderr = "";
  srv.stderr.on("data", (d) => { stderr += d.toString(); });
  srv.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) { try { replies.push(JSON.parse(line)); } catch { /* 忽略 */ } }
    }
  });
  const send = (o) => srv.stdin.write(JSON.stringify(o) + "\n");
  const wait = (id, ms = 300000) => new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const r = replies.find((x) => x.id === id);
      if (r) { clearInterval(iv); res(r); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error(`等待超时。stderr: ${stderr.slice(0, 500)}`)); }
    }, 50);
  });

  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ci-gate", version: "0" }
    }});
    await wait(1);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
      name: "replay_suite",
      arguments: { tracePaths: paths, concurrency: Math.min(3, paths.length) }
    }});
    const r = await wait(2);
    const text = r.result?.content?.[0]?.text ?? JSON.stringify(r.error);
    console.log(text);
    const m = text.trim().split("\n").pop()?.match(/^SUITE_RESULT ok=\d+ failed=(\d+) /);
    if (!m) fail("报告缺少机读收尾行");
    srv.kill();
    cleanup(env);
    process.exit(Number(m[1]) === 0 ? 0 : 1);
  } catch (err) {
    srv.kill();
    cleanup(env);
    fail(err instanceof Error ? err.message : String(err));
  }
}

fail(`未知命令 ${JSON.stringify(cmd)}，可用：up / gate / down`);
