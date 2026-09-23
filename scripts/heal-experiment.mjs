// heal 成功率野外实验台：4 类漂移场景 + 对照组，真实 MCP 协议驱动完整 suite→heal→复跑闭环
// 度量边界：机制可靠性（记账/捕获/验证门/写回/护栏）。演示选题按 ground-truth 编码。
// 用法：node scripts/heal-experiment.mjs
import { spawn, execSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9226;
const profile = mkdtempSync(join(tmpdir(), "cuq-heal-exp-"));
const work = mkdtempSync(join(tmpdir(), "cuq-heal-exp-traces-"));

// ---------- 场景页 ----------
const PAGES = {};
PAGES["/e1v1.html"] = `<main><h1>列表</h1><button class="btn-detail">查看明细</button><div id="result">未点击</div>
<script>document.querySelector("button").onclick=()=>document.getElementById("result").textContent="已点击";</script></main>`;
PAGES["/e1v2.html"] = `<main><h1>列表</h1><button class="btn-action">查看详情</button><div id="result">未点击</div>
<script>document.querySelector("button").onclick=()=>document.getElementById("result").textContent="已点击";</script></main>`;

const cardWall = (titles) => `<main><h1>卡片墙</h1>${titles.map((t) =>
  `<div class="card"><div class="title">${t}</div><button type="button">查看明细</button></div>`).join("")}
<div id="clicked">未点击</div>
<script>document.querySelectorAll(".card button").forEach((b)=>b.onclick=(e)=>{
document.getElementById("clicked").textContent=e.target.closest(".card").querySelector(".title").textContent+" · 已点击";});</script></main>`;
PAGES["/e2v1.html"] = cardWall(["教育事业群", "技术平台中心"]);
PAGES["/e2v2.html"] = cardWall(["教育事业群（新）", "技术平台中心（新）"]);

PAGES["/e3v1.html"] = `<main><h1>操作区</h1><button id="target">目标按钮</button><div id="done">未完成</div>
<script>document.getElementById("target").onclick=()=>document.getElementById("done").textContent="已完成";</script></main>`;
PAGES["/e3v2.html"] = `<main><h1>操作区</h1><button id="open">打开弹窗</button>
<div id="dlg" hidden><button id="target">目标按钮</button></div><div id="done">未完成</div>
<script>document.getElementById("open").onclick=()=>document.getElementById("dlg").hidden=false;
document.getElementById("target").onclick=()=>document.getElementById("done").textContent="已完成";</script></main>`;

PAGES["/e4v1.html"] = `<main><h1>表单</h1><button class="submit">提交</button><div id="result">未提交</div>
<script>document.querySelector(".submit").onclick=()=>document.getElementById("result").textContent="已提交";</script></main>`;
PAGES["/e4v2.html"] = `<main><h1>表单</h1><p>该功能已下线</p><button class="back">返回</button><div id="result">未提交</div></main>`;

const fx = await new Promise((resolve) => {
  const srv = createServer((req, res) => {
    const body = PAGES[(req.url ?? "/").split("?")[0]];
    if (!body) { res.writeHead(404).end("nf"); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
  });
  srv.listen(0, "127.0.0.1", () => {
    const addr = srv.address();
    resolve({
      url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`,
      close: () => new Promise((r) => srv.close(() => r()))
    });
  });
});

// ---------- Chrome + MCP server ----------
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, "--no-first-run", "about:blank"
], { stdio: "ignore" });
async function waitDevtools(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return; } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Chrome 未就绪");
}
const srv = spawn("node", ["dist/index.js"], {
  env: { ...process.env, CUQ_BROWSER_URL: `http://127.0.0.1:${PORT}` },
  stdio: ["pipe", "pipe", "pipe"]
});
const replies = [];
let buf = "", stderr = "";
srv.stderr.on("data", (d) => { stderr += d.toString(); });
srv.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (line) { try { replies.push(JSON.parse(line)); } catch { /* 非 JSON 行忽略 */ } }
  }
});
const send = (o) => srv.stdin.write(JSON.stringify(o) + "\n");
const wait = (id, ms = 120000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    const r = replies.find((x) => x.id === id);
    if (r) { clearInterval(iv); res(r); }
    else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error(`id=${id} 超时。stderr: ${stderr.slice(0, 400)}`)); }
  }, 50);
});
let seq = 100; // 避开 initialize 的 id=1，防止按 id 匹配到陈旧响应
const call = async (name, args) => {
  const id = ++seq;
  send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const r = await wait(id);
  return { isError: r.result?.isError ?? false, text: r.result?.content?.[0]?.text ?? JSON.stringify(r.error ?? r) };
};

// ---------- 实验驱动 ----------
const D = (strategies) => ({ descriptor: { strategies, framePath: [] } });
const css = (value) => ({ kind: "css", value });
const roleName = (role, name) => ({ kind: "role-name", role, name });
const container = (containerText, role, name) =>
  ({ kind: "container-role-name", containerText, role, name });

const scenarios = [
  {
    name: "E0 对照组（无漂移）", pageV1: "/e1v1.html", pageV2: "/e1v1.html", traceName: "e0",
    steps: (p) => [
      { action: "navigate", url: `${fx.url}${p}` },
      { action: "click", target: D([roleName("button", "查看明细"), css(".btn-detail")]) },
      { action: "assert", type: "text-equals", target: D([css("#result")]), expected: "已点击" }
    ],
    demo: () => [], expect: "replay 全绿"
  },
  {
    name: "E1 文案改版（定位栈全死）", pageV1: "/e1v1.html", pageV2: "/e1v2.html", traceName: "e1",
    steps: (p) => [
      { action: "navigate", url: `${fx.url}${p}` },
      { action: "click", target: D([roleName("button", "查看明细"), css(".btn-detail")]) },
      { action: "assert", type: "text-equals", target: D([css("#result")]), expected: "已点击" }
    ],
    demo: (snap) => [{ action: "click", target: { ref: refOf(snap, "查看详情") } }],
    expect: "healed（演示 1 步替换）"
  },
  {
    name: "E2 结构改版（容器锚定死）", pageV1: "/e2v1.html", pageV2: "/e2v2.html", traceName: "e2",
    steps: (p) => [
      { action: "navigate", url: `${fx.url}${p}` },
      { action: "click", target: D([container("教育事业群", "button", "查看明细")]) },
      { action: "assert", type: "text-equals", target: D([css("#clicked")]), expected: "教育事业群（新） · 已点击" }
    ],
    demo: (snap) => [{ action: "click", target: { ref: refOf(snap, "查看明细") } }], // 第一张卡
    expect: "healed（重捕获新锚文本）"
  },
  {
    name: "E3 元素迁移（需先打开弹窗）", pageV1: "/e3v1.html", pageV2: "/e3v2.html", traceName: "e3",
    steps: (p) => [
      { action: "navigate", url: `${fx.url}${p}` },
      { action: "click", target: D([css("#target")]) },
      { action: "assert", type: "text-equals", target: D([css("#done")]), expected: "已完成" }
    ],
    demo: (snap) => [
      { action: "click", target: { ref: refOf(snap, "打开弹窗") } },
      // 弹窗内的按钮在演示前不可见、拿不到 ref——用手写 descriptor 逃生舱（真实 agent 也这么做）
      { action: "click", target: D([css("#target")]) }
    ],
    expect: "healed（演示 2 步替换 1 步）"
  },
  {
    name: "E4 目标删除（不可修）", pageV1: "/e4v1.html", pageV2: "/e4v2.html", traceName: "e4",
    steps: (p) => [
      { action: "navigate", url: `${fx.url}${p}` },
      { action: "click", target: D([roleName("button", "提交"), css(".submit")]) },
      { action: "assert", type: "text-equals", target: D([css("#result")]), expected: "已提交" }
    ],
    demo: (snap) => [{ action: "click", target: { ref: refOf(snap, "返回") } }],
    expect: "预算耗尽转人工（两次错误修复，第三次被拒）"
  }
];

function refOf(snapText, content) {
  const line = snapText.split("\n").find((l) => l.includes(content) && l.includes("[e"));
  const m = line?.match(/\[(e\d+)\]/);
  if (!m) throw new Error(`快照里找不到带 ref 的行：${content}`);
  return m[1];
}

const results = [];

try {
  await waitDevtools();
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "heal-exp", version: "0" } }});
  await wait(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  for (const sc of scenarios) {
    const tracePath = join(work, `${sc.traceName}.json`);
    writeFileSync(tracePath, JSON.stringify({
      name: sc.traceName, baseUrl: fx.url, createdAt: "", steps: sc.steps(sc.pageV2) // 一律对 v2 回放（E0 的 v2=v1）
    }, null, 2) + "\n", "utf8");

    // 第一轮 suite（对 v2）
    const s1 = await call("replay_suite", { tracePaths: [tracePath], concurrency: 1 });
    const machine1 = s1.text.trim().split("\n").pop() ?? "";
    const kindMatch = s1.text.match(/第 \d+ 步失败（(\S+?)）/) ?? s1.text.match(/失败：(\S+)/);
    const failureKind = machine1.includes("failed=0") ? "（无失败）" : (kindMatch?.[1] ?? "未知");

    if (machine1.includes("failed=0")) {
      results.push({ scenario: sc.name, failureKind, attempts: 0, verdict: "PASS（全绿）", healMs: 0, note: sc.expect });
      continue;
    }

    // heal 循环（演示选题 = ground-truth 编码的 agent 决策）
    let verdict = "FAIL"; let attempts = 0; let healMs = 0; let note = "";
    const t0 = Date.now();
    const maxAttempts = sc.traceName === "e4" ? 3 : 1;

    for (let a = 1; a <= maxAttempts; a++) {
      attempts = a;
      // suite 的失败发生在隔离 Context（已销毁）——演示前先把主页面导航到失败时的页面状态
      await call("batch", { steps: [{ action: "navigate", url: `${fx.url}${sc.pageV2}` }] });
      const snap = await call("snapshot", {});
      const demo = sc.demo(snap.text);
      const heal = await call("heal_step", { tracePath, actions: demo });
      healMs = Date.now() - t0;
      if (!heal.isError && heal.text.includes("自愈成功")) { verdict = "HEALED"; note = `第 ${a} 次演示通过`; break; }
      note = heal.text.split("\n")[0].slice(0, 60);
      if (heal.text.includes("转人工") || heal.text.includes("不可自动修复")) { verdict = "ESCALATED"; break; }
    }

    // 终判：healed 的场景复跑 suite 确认固化
    if (verdict === "HEALED") {
      const s2 = await call("replay_suite", { tracePaths: [tracePath], concurrency: 1 });
      const ok2 = (s2.text.trim().split("\n").pop() ?? "").includes("ok=1 failed=0");
      if (!ok2) { verdict = "HEALED-BUT-RERUN-FAIL"; note += "；复跑未全绿"; }
    }
    results.push({ scenario: sc.name, failureKind, attempts, verdict, healMs, note });
  }

  // ---------- 报告 ----------
  const healed = results.filter((r) => r.verdict === "HEALED").length;
  const escalated = results.filter((r) => r.verdict === "ESCALATED").length;
  const healable = results.filter((r) => !r.scenario.startsWith("E0") && !r.scenario.startsWith("E4")).length;
  const lines = [
    "# heal 成功率野外实验（2026-09-23）",
    "",
    "| 场景 | 失败类型 | 演示次数 | verdict | heal 耗时 | 备注 |",
    "|---|---|---|---|---|---|"
  ];
  for (const r of results) {
    lines.push(`| ${r.scenario} | ${r.failureKind} | ${r.attempts} | ${r.verdict} | ${r.healMs}ms | ${r.note} |`);
  }
  lines.push(
    "",
    `- 可修复场景自动修复率：${healed}/${healable}`,
    `- 不可修复场景护栏正确升级：${escalated}/1（预算耗尽转人工）`,
    `- 另注：真实 SUT 人工代理演示一次通过（2026-09-22 E2E 冒烟），模型侧选题可用性有实测数据点`
  );
  const report = lines.join("\n");
  console.log("\n" + report);
  mkdirSync("docs", { recursive: true });
  writeFileSync("docs/heal-experiment-2026-09-23.md", report + "\n", "utf8");
} finally {
  srv.kill();
  try { execSync(`taskkill /PID ${chrome.pid} /T /F`, { stdio: "ignore" }); } catch { /* 尽力 */ }
  for (let i = 0; i < 10; i++) {
    try { rmSync(profile, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); break; }
    catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  await fx.close();
}
