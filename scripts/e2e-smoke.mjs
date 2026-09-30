// 可重复的真实 MCP 二期闭环冒烟：临时 SUT → replay_suite → heal_step → replay_suite。
// 前置：node scripts/ci-harness.mjs up（可用 --headed 观察）。
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const envPath = resolve(".scratch/ci-env.json");
if (!existsSync(envPath)) throw new Error("缺少 .scratch/ci-env.json，请先运行 node scripts/ci-harness.mjs up");
const ciEnv = JSON.parse(readFileSync(envPath, "utf8"));
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let orders = [];

function page(title, body, script = "") {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title>
    <style>body{font:16px system-ui,sans-serif;margin:40px}label{display:block;margin:12px 0}input{padding:6px}button{padding:6px 12px;margin-right:8px}</style>
    </head><body>${body}<script>${script}</script></body></html>`;
}
function loginPage() {
  return page("登录", `<main><h1>登录</h1>
    <label>账号 <input aria-label="账号" id="user"></label>
    <label>密码 <input aria-label="密码" id="password" type="password"></label>
    <button id="login">登录</button><p id="login-result" role="status"></p></main>`,
    `document.getElementById("login").onclick=()=>{if(!document.getElementById("user").value){document.getElementById("login-result").textContent="请输入账号";return;}localStorage.setItem("smoke-token","ok");location.href="/app";};`);
}
function appPage() {
  return page("订单列表", `<main><h1>订单列表</h1><button id="new">新建订单</button><div id="form" hidden>
    <label>客户名 <input aria-label="客户名" id="customer"></label><label>金额 <input aria-label="金额" id="amount"></label>
    <button id="save">保存</button></div><p id="result" role="status"></p><ul id="orders"></ul></main>`,
    `if(!localStorage.getItem("smoke-token"))location.replace("/");const render=()=>document.getElementById("orders").innerHTML=${JSON.stringify(orders)}.map(o=>"<li>"+o.customer+" · "+o.amount+"</li>").join("");render();document.getElementById("new").onclick=()=>document.getElementById("form").hidden=false;document.getElementById("save").onclick=async()=>{const customer=document.getElementById("customer").value;const amount=document.getElementById("amount").value;await fetch("/api/orders",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({customer,amount})});document.getElementById("result").textContent="已保存 "+customer;render();};`);
}
const sut = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const html = (body) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(body); };
  const json = (body) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (url.pathname === "/") return html(loginPage());
  if (url.pathname === "/app") return html(appPage());
  if (url.pathname === "/api/orders" && req.method === "POST") { let raw = ""; for await (const chunk of req) raw += chunk; orders.push({ id: orders.length + 1, ...JSON.parse(raw) }); return json({ ok: true }); }
  if (url.pathname === "/api/orders" && req.method === "GET") return json(orders);
  if (url.pathname === "/health") return json({ ok: true });
  res.writeHead(404).end("not found");
});
await new Promise((resolveListen) => sut.listen(0, "127.0.0.1", resolveListen));
const address = sut.address();
const baseUrl = `http://127.0.0.1:${address.port}`;

const work = mkdtempSync(join(tmpdir(), "cuq-e2e-smoke-"));
let server;
let stderr = "";
let sequence = 0;
const replies = [];
let buffer = "";
function send(message) { server.stdin.write(JSON.stringify(message) + "\n"); }
function waitFor(id, timeoutMs = 180_000) {
  return new Promise((resolveWait, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const reply = replies.find((item) => item.id === id);
      if (reply) { clearInterval(timer); resolveWait(reply); }
      else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error(`MCP 请求 id=${id} 超时；stderr=${stderr.slice(0, 800)}`)); }
    }, 50);
  });
}
async function call(name, args = {}) {
  const id = ++sequence;
  send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const reply = await waitFor(id);
  return { isError: reply.result?.isError ?? false, text: reply.result?.content?.[0]?.text ?? JSON.stringify(reply.error ?? reply) };
}
function descriptor(value) { return { descriptor: { strategies: [{ kind: "css", value }], framePath: [] } }; }
function role(roleName, name) { return { descriptor: { strategies: [{ kind: "role-name", role: roleName, name }], framePath: [] } }; }
function makeTrace(name, customer, broken = false) {
  const trace = { name, baseUrl, createdAt: new Date().toISOString(), steps: [
    { action: "navigate", url: `${baseUrl}/` },
    { action: "fill", target: broken ? role("textbox", "不存在的账号") : role("textbox", "账号"), value: "admin" },
    { action: "fill", target: role("textbox", "密码"), value: "${SMOKE_PASS}", sensitive: true },
    { action: "click", target: role("button", "登录") },
    { action: "wait", until: { type: "visible", target: role("heading", "订单列表") }, timeout: 8_000 },
    { action: "click", target: role("button", "新建订单") },
    { action: "fill", target: role("textbox", "客户名"), value: customer },
    { action: "fill", target: role("textbox", "金额"), value: "100" },
    { action: "click", target: role("button", "保存") },
    { action: "wait", until: { type: "visible", target: descriptor("#result") }, timeout: 8_000 },
    { action: "assert", type: "text-contains", target: descriptor("#result"), expected: customer }
  ] };
  const path = join(work, `${name}.json`);
  writeFileSync(path, JSON.stringify(trace, null, 2) + "\n", "utf8");
  return path;
}
function lastMachineLine(text) { return text.trim().split("\n").at(-1) ?? ""; }
function check(condition, message) { console.log(`${condition ? "✓" : "✗"} ${message}`); if (!condition) throw new Error(message); }

async function runRound(round) {
  orders = [];
  const goodName = `smoke-${runId}-r${round}-good`;
  const brokenName = `smoke-${runId}-r${round}-broken`;
  const good = makeTrace(`smoke-good-r${round}`, goodName);
  const broken = makeTrace(`smoke-broken-r${round}`, brokenName, true);
  const vars = { SMOKE_PASS: "s3cret" };
  console.log(`\n== round ${round}: replay_suite（1 好 1 坏）==`);
  const first = await call("replay_suite", { tracePaths: [good, broken], concurrency: 2, vars });
  console.log(first.text.split("\n").slice(0, 5).join("\n"));
  check(!first.isError, "首次 suite 调用成功");
  check(/^SUITE_RESULT ok=1 failed=1 total=2 wall_ms=\d+$/.test(lastMachineLine(first.text)), "首次 suite 为 1 成功 / 1 失败");
  console.log(`== round ${round}: heal_step ==`);
  const nav = await call("batch", { steps: [{ action: "navigate", url: `${baseUrl}/` }] });
  check(!nav.isError, "导航到隔离 SUT 登录页");
  const snap = await call("snapshot");
  const line = snap.text.split("\n").find((item) => item.includes('textbox "账号"'));
  const ref = line?.match(/\[(e\d+)\]/)?.[1];
  check(!!ref, "拿到登录账号 ref");
  const heal = await call("heal_step", { tracePath: broken, vars, actions: [{ action: "fill", target: { ref }, value: "admin" }] });
  console.log(heal.text.split("\n").slice(0, 3).join("\n"));
  check(!heal.isError && heal.text.includes("自愈成功"), "heal_step 验证门通过并写回");
  console.log(`== round ${round}: replay_suite（复跑）==`);
  const second = await call("replay_suite", { tracePaths: [good, broken], concurrency: 2, vars });
  console.log(second.text.split("\n").slice(0, 5).join("\n"));
  check(!second.isError, "复跑 suite 调用成功");
  check(/^SUITE_RESULT ok=2 failed=0 total=2 wall_ms=\d+$/.test(lastMachineLine(second.text)), "复跑 suite 为 2 成功 / 0 失败");
  console.log(`SMOKE_RESULT round=${round} ok=1 failed=0`);
}

try {
  server = spawn("node", ["dist/index.js"], { env: { ...process.env, CUQ_BROWSER_URL: ciEnv.browserURL }, stdio: ["pipe", "pipe", "pipe"] });
  server.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  server.stdout.on("data", (chunk) => { buffer += chunk.toString(); let index; while ((index = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1); if (line) { try { replies.push(JSON.parse(line)); } catch { /* 忽略非 JSON 日志 */ } } } });
  send({ jsonrpc: "2.0", id: ++sequence, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-smoke", version: "1" } } });
  await waitFor(sequence);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await runRound(1);
  await runRound(2);
  console.log("\nE2E_SMOKE_RESULT ok=2 failed=0 rounds=2");
} finally {
  server?.kill();
  await new Promise((resolveClose) => sut.close(resolveClose));
  rmSync(work, { recursive: true, force: true });
}
