// Isolated UX smoke: real MCP stdio, owned Chrome and in-memory loopback SUT.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createUxRun, mcpEnvironment, scenario, bounded, waitProcessExit, finishRun } from "./lib/ux-run.mjs";
import { createUxSut } from "./lib/ux-sut.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = process.argv.slice(2);
if (cli.includes("--help")) {
  console.log("Usage: npm run test:ux -- [--headless] [--output-root DIR]\nOwns an ephemeral SUT and fresh Chrome profile; never connects to an existing browser.");
  process.exit(0);
}
let headless = false, outputRoot = join(ROOT, ".scratch", "e2e-ux");
for (let i = 0; i < cli.length; i++) {
  if (cli[i] === "--headless") headless = true;
  else if (cli[i] === "--output-root" && cli[i + 1]) outputRoot = resolve(cli[++i]);
  else throw new Error("Unsupported argument: " + cli[i]);
}
const CHROME = process.env.CUQ_UX_CHROME_PATH ?? (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : "/usr/bin/google-chrome");
const sut = createUxSut();
const run = await createUxRun({ outputRoot, handler: sut.handler });
const OUT = run.out, WORK = run.work, SUT = run.baseUrl;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = [], log = [];
let browser, client, mainPage, mainId, tracePath, cleanupOk = false, signal;
const PASS = { CUQ_UX_PASS: "s3cret" };
const d = (role, name) => ({ descriptor: { strategies: [{ kind: "role-name", role, name }], framePath: [] } });
const css = selector => ({ descriptor: { strategies: [{ kind: "css", value: selector }], framePath: [] } });
function note(s) { console.log(s); log.push(s); }
function flush() { writeFileSync(join(OUT, "log.md"), log.join("\n\n")); }
async function section(name, fn) {
  if (signal) throw new Error("Interrupted by " + signal);
  note("\n## " + name);
  const result = await scenario(report, name, fn);
  note(result.ok ? "PASS (" + result.ms + "ms)" : "FAIL: " + result.error);
  flush();
}
async function startServer(browserURL = run.browserURL) {
  if (signal) throw new Error("Interrupted by " + signal);
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(ROOT, "dist/index.js")], cwd: WORK, stderr: "pipe",
    env: mcpEnvironment(process.env, browserURL)
  });
  const c = new Client({ name: "e2e-ux-isolated", version: "1" });
  const index = servers.length;
  let stderr = "", ownedPID;
  transport.stderr?.on("data", data => { stderr += data; });
  run.addCleanup(async () => {
    try {
      await c.close();
      await waitProcessExit(ownedPID ?? transport.pid);
    } finally { writeFileSync(join(OUT, "server-" + index + ".stderr.log"), stderr); }
  });
  servers.push({ transport, c });
  const connecting = c.connect(transport);
  try { await bounded(connecting, 15_000, "MCP initialize"); }
  finally { ownedPID = transport.pid; }
  client = c;
  return c;
}
const servers = [];
async function call(name, args = {}, { timeout = 45_000, c = client } = {}) {
  const progress = [], t0 = Date.now();
  const r = await c.callTool({ name, arguments: args }, undefined,
    { timeout, onprogress: p => progress.push({ t: Date.now() - t0, ...p }) });
  const text = r.content.filter(x => x.type === "text").map(x => x.text).join("\n");
  const result = { isError: !!r.isError, text, ms: Date.now() - t0, progress, images: r.content.filter(x => x.type === "image").length };
  note("### " + name + " (" + result.ms + "ms, isError=" + result.isError + ")\n" + text.slice(0, 5000));
  return result;
}
function ok(result) { assert.equal(result.isError, false, result.text); return result; }
function replayOk(result) { ok(result); assert.match(result.text, /回放成功|全部通过|全部成功/); assert.doesNotMatch(result.text, /回放失败/); return result; }
function failed(result, pattern) { assert.equal(result.isError, true, result.text); assert.match(result.text, pattern); }
async function shot(page, name) {
  // Screenshot only an owned target; do not activate it to overcome background restrictions.
  if (await page.evaluate(() => document.visibilityState) !== "visible") {
    note("Screenshot skipped for hidden owned target: " + name); return;
  }
  await bounded(page.screenshot({ path: join(OUT, name) }), 8000, "Screenshot");
}
async function overlay(page) {
  return page.evaluate(() => ({ host: !!document.querySelector("cuq-overlay"), visibility: document.visibilityState }));
}
async function selectMain() {
  const r = ok(await call("list_pages"));
  mainId = r.text.match(/\* (\S+)/)?.[1];
  assert.ok(mainId, "No selected owned page: " + r.text);
  mainPage = (await browser.pages()).find(p => p.target()._targetId === mainId);
  assert.ok(mainPage, "MCP selected a page outside our browser");
}
async function login({ secret = true } = {}) {
  ok(await call("batch", { pageId: mainId, vars: PASS, steps: [
    { action: "navigate", url: SUT + "/" },
    { action: "fill", target: d("textbox", "账号"), value: "admin" },
    ...(secret ? [{ action: "fill", target: css("#p"), value: "${CUQ_UX_PASS}" }] : []),
    { action: "click", target: d("button", "登录") },
    { action: "wait", until: { type: "visible", target: d("heading", "订单列表") }, timeout: 8000 }
  ] }));
}
function summary() {
  const data = { headless, out: OUT, work: WORK, baseUrl: SUT, browserURL: run.browserURL,
    profile: run.profile, cleanupOk, signal, orders: sut.orders, requests: sut.requests, scenarios: report,
    ok: report.filter(r => r.ok).length, failed: report.filter(r => !r.ok).length };
  writeFileSync(join(OUT, "summary.json"), JSON.stringify(data, null, 2));
  flush(); return data;
}
// Settle the current bounded operation, then enter the single finally cleanup.
const onSignal = name => { signal = name; };
const onSigint = () => onSignal("SIGINT"), onSigterm = () => onSignal("SIGTERM");
process.once("SIGINT", onSigint); process.once("SIGTERM", onSigterm);
note("Isolated run: " + OUT + "\nSUT: " + SUT);
try {
  await section("S0 lazy startup without a browser", async () => {
    const offline = http.createServer((_req, res) => { res.statusCode = 503; res.end("test browser not started"); });
    await new Promise(resolve => offline.listen(0, "127.0.0.1", resolve));
    run.addCleanup(() => { offline.closeAllConnections(); return new Promise(resolve => offline.close(resolve)); });
    const probe = await startServer("http://127.0.0.1:" + offline.address().port);
    failed(await call("list_pages", {}, { c: probe }), /Chrome|浏览器/);
    await probe.close();
  });
  browser = await run.launchBrowser({ executablePath: CHROME, headless });
  note("Owned Chrome PID=" + browser.process().pid + " endpoint=" + run.browserURL);
  await startServer();
  await selectMain();

  await section("S1 login, snapshot and observer overlay", async () => {
    ok(await call("batch", { steps: [{ action: "navigate", url: SUT + "/" }] }));
    const snapshot = ok(await call("snapshot"));
    assert.match(snapshot.text, /textbox "账号"/);
    const task = login(); task.catch(() => {});
    await sleep(300); await shot(mainPage, "s1-active.png");
    await task;
    const after = ok(await call("snapshot"));
    assert.match(after.text, /订单列表/);
    assert.doesNotMatch(after.text, /agent 待命|computer-use-quick 正在操作/);
    assert.equal((await overlay(mainPage)).host, !headless);
    await shot(mainPage, "s1-idle.png");
  });
  await section("S2a user interruption and explicit continuation", async () => {
    const task = call("batch", { steps: [
      { action: "click", target: d("button", "刷新") },
      { action: "click", target: d("button", "新建订单") }
    ] });
    task.catch(() => {});
    await sleep(900);
    const cdp = await mainPage.createCDPSession();
    try {
      for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", {
        type, x: 640, y: 600, button: "left", clickCount: 1
      });
    } finally { await cdp.detach(); }
    const interrupted = await task;
    if (headless) ok(interrupted); else failed(interrupted, /user-interrupted|用户介入|用户.*打断/);
    await shot(mainPage, "s2a-interrupted.png");
    ok(await call("snapshot"));
    ok(await call("batch", { steps: [
      { action: "click", target: d("button", "新建订单") },
      { action: "press", key: "Escape" }
    ] }));
    assert.equal(await mainPage.$eval("#modal", el => getComputedStyle(el).display), "none");
  });
  await section("S2b user navigation invalidates old page context", async () => {
    await mainPage.click("#logout"); await mainPage.waitForSelector("#u");
    failed(await call("batch", { steps: [{ action: "click", target: d("button", "新建订单") }] }), /target-not-found|未找到|找不到/);
    ok(await call("snapshot")); await login();
  });
  await section("S2c background action preserves the user's selected tab", async () => {
    const other = await browser.newPage();
    try {
      await other.goto(SUT + "/help"); await other.bringToFront();
      if (!headless) {
        await mainPage.waitForFunction(() => document.visibilityState === "hidden", { timeout: 5000 });
      }
      ok(await call("batch", { pageId: mainId, steps: [{ action: "click", target: d("button", "刷新") }] }));
      const inspected = await call("inspect", { pageId: mainId });
      if (!headless && inspected.isError) failed(inspected, /后台标签暂无可用截图渲染帧.*未切换用户标签/);
      else { ok(inspected); assert.ok(inspected.images > 0); }
      if (!headless) {
        assert.equal(await other.evaluate(() => document.visibilityState), "visible");
        assert.equal(await mainPage.evaluate(() => document.visibilityState), "hidden");
      }
      await shot(other, "s2c-user-view.png");
    } finally { await other.close(); await mainPage.bringToFront(); }
  });
  await section("S2d closing selected page does not navigate another user page", async () => {
    const keep = await browser.newPage(); await keep.goto(SUT + "/help");
    await mainPage.bringToFront();
    const task = call("batch", { steps: [
      { action: "click", target: d("button", "刷新") },
      { action: "click", target: d("button", "新建订单") }
    ] });
    task.catch(() => {});
    await sleep(900); await mainPage.close();
    failed(await task, /page-closed|页面.*关闭|标签.*关闭/);
    ok(await call("batch", { steps: [{ action: "navigate", url: SUT + "/" }] }));
    assert.equal(keep.url(), SUT + "/help");
    await selectMain();
  });
  await section("S3 secret guard and save a complete order trace", async () => {
    await call("discard_steps");
    ok(await call("batch", { steps: [
      { action: "navigate", url: SUT + "/" },
      { action: "fill", target: css("#p"), value: "s3cret" }
    ] }));
    failed(await call("save_trace", { name: "ux-plain", baseUrl: SUT, dir: WORK }), /明文|敏感|secret|密码/);
    assert.equal(existsSync(join(WORK, "ux-plain.json")), false);
    ok(await call("discard_steps"));
    await login();
    ok(await call("batch", { steps: [
      { action: "click", target: d("button", "新建订单") },
      { action: "fill", target: d("textbox", "客户名"), value: "隔离测试客户" },
      { action: "fill", target: d("textbox", "金额"), value: "520" },
      { action: "click", target: d("button", "保存") },
      { action: "assert", type: "text-contains", target: css("#rows"), expected: "隔离测试客户" }
    ] }));
    ok(await call("save_trace", { name: "ux-order", baseUrl: SUT, dir: WORK }));
    tracePath = join(WORK, "ux-order.json");
    assert.ok(existsSync(tracePath));
    const trace = readFileSync(tracePath, "utf8");
    assert.doesNotMatch(trace, /s3cret/);
    assert.match(trace, /CUQ_UX_PASS/);
    assert.equal(sut.orders.length, 3);
  });
  await section("S4 replay progress and variable preflight", async () => {
    const r = replayOk(await call("replay", { tracePath, vars: PASS }));
    assert.ok(r.progress.length > 0, "MCP SDK should receive progress notifications");
    const before = sut.requests.length;
    failed(await call("replay", { tracePath }), /CUQ_UX_PASS/);
    assert.equal(sut.requests.length, before, "Missing variables must not navigate or write");
    assert.equal(sut.orders.length, 4);
    await shot(mainPage, "s4-replay.png");
  });
  await section("S5 injected locator drift and independently verified heal", async () => {
    assert.ok(tracePath, "S3 did not save a trace");
    const trace = JSON.parse(readFileSync(tracePath, "utf8"));
    const step = trace.steps.find(s => s.action === "click" &&
      s.target?.descriptor?.strategies?.some(s => s.kind === "role-name" && s.name === "新建订单"));
    assert.ok(step, "No new-order locator to inject drift");
    step.target.descriptor.strategies = [{ kind: "role-name", role: "button", name: "新建订单" }];
    writeFileSync(tracePath, JSON.stringify(trace, null, 2));
    sut.setVersion(true);
    const drift = await call("replay", { tracePath, vars: PASS });
    assert.match(drift.text, /回放失败/); assert.match(drift.text, /heal_required=true/);
    ok(await call("snapshot"));
    ok(await call("heal_step", { actions: [{ action: "click", target: d("button", "创建订单") }], tracePath, vars: PASS }));
    assert.ok(existsSync(tracePath.replace(/\.json$/, ".heal.jsonl")));
    replayOk(await call("replay", { tracePath, vars: PASS }));
  });
  await section("S6 three concurrent isolated replay contexts", async () => {
    const paths = ["ux-a", "ux-b", "ux-c"].map(name => {
      const trace = JSON.parse(readFileSync(tracePath, "utf8")); trace.name = name;
      const path = join(WORK, name + ".json"); writeFileSync(path, JSON.stringify(trace, null, 2)); return path;
    });
    const before = sut.orders.length;
    const result = ok(await call("replay_suite", { tracePaths: paths, concurrency: 3, vars: PASS }));
    assert.match(result.text, /SUITE_RESULT ok=3 failed=0 total=3/);
    assert.equal(sut.orders.length, before + 3);
    await shot(mainPage, "s6-after-suite.png");
  });
  await section("S7 dismiss and accept owned test-data confirm dialog", async () => {
    const before = sut.orders.length;
    ok(await call("batch", { steps: [{ action: "click", target: d("button", "删除全部"), dialog: "dismiss" }] }));
    assert.equal(sut.orders.length, before);
    ok(await call("batch", { steps: [{ action: "click", target: d("button", "删除全部") }] }));
    assert.equal(sut.orders.length, 0);
    assert.equal(sut.requests.filter(r => r.method === "DELETE").length, 1);
  });
  await section("S8 normal client close removes observer overlay", async () => {
    const before = await overlay(mainPage); assert.equal(before.host, !headless);
    await bounded(client.close(), 5000, "Client close");
    await mainPage.waitForFunction(() => !document.querySelector("cuq-overlay"), { timeout: 5000 });
    assert.equal((await overlay(mainPage)).host, false);
  });
  await section("S9 owned browser close and explicit endpoint-verified restart", async () => {
    await startServer(); ok(await call("list_pages"));
    const oldURL = run.browserURL, oldPID = browser.process().pid;
    await run.stopBrowser();
    // Do not reconnect while the old port is released; verify the new owner first.
    browser = await run.launchBrowser({ executablePath: CHROME, headless, reconnect: true });
    assert.equal(run.browserURL, oldURL);
    assert.notEqual(browser.process().pid, oldPID);
    ok(await call("list_pages"));
    ok(await call("batch", { steps: [{ action: "navigate", url: SUT + "/" }] }));
  });
} catch (error) {
  report.push({ name: "setup/run", ok: false, error: String(error.stack ?? error) });
  note("Fatal: " + error.stack);
} finally {
  try { await run.close(); cleanupOk = true; }
  catch (error) { report.push({ name: "cleanup", ok: false, error: String(error.stack ?? error) }); note("Cleanup failed: " + error); }
  process.removeListener("SIGINT", onSigint); process.removeListener("SIGTERM", onSigterm);
  const final = summary();
  note("UX_RESULT ok=" + final.ok + " failed=" + final.failed + " cleanup=" + cleanupOk + " out=" + OUT);
  flush(); finishRun(final.failed || !cleanupOk || signal ? 1 : 0);
}
