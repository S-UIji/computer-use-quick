import { afterEach, describe, expect, it, vi } from "vitest";
import puppeteer from "puppeteer-core";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createUxRun, mcpEnvironment, verifyEndpoint, scenario, waitProcessExit } from "../../scripts/lib/ux-run.mjs";

const roots: string[] = [];
const runs: any[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const run of runs.splice(0)) await run.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() { const p = mkdtempSync(join(tmpdir(), "cuq-isolation-test-")); roots.push(p); return p; }

describe("UX smoke ownership", () => {
  it("preserves old output and gives two live SUTs separate origins and state", async () => {
    const outputRoot = root();
    mkdirSync(join(outputRoot, "old")); writeFileSync(join(outputRoot, "old/evidence.txt"), "keep");
    let a = 0, b = 0;
    const first = await createUxRun({ outputRoot, handler: (_req: any, res: any) => res.end(String(++a)) });
    const second = await createUxRun({ outputRoot, handler: (_req: any, res: any) => res.end(String(++b)) });
    runs.push(first, second);
    expect(first.baseUrl).not.toBe(second.baseUrl);
    expect(first.out).not.toBe(second.out);
    expect(await (await fetch(first.baseUrl)).text()).toBe("1");
    expect(await (await fetch(first.baseUrl)).text()).toBe("2");
    expect(await (await fetch(second.baseUrl)).text()).toBe("1");
    expect(readFileSync(join(outputRoot, "old/evidence.txt"), "utf8")).toBe("keep");
    await first.close();
    expect(await (await fetch(second.baseUrl)).text()).toBe("2");
  });
  it("does not reuse environment browser/launch configuration", () => {
    const env = mcpEnvironment({ CUQ_BROWSER_URL: "http://localhost:3040", CUQ_LAUNCH: "auto",
      CUQ_CHROME_PATH: "user-chrome", CUQ_PROFILE_DIR: "user-profile", PATH: "preserve" }, "http://127.0.0.1:49152");
    expect(env.CUQ_BROWSER_URL).toBe("http://127.0.0.1:49152");
    expect(env.CUQ_LAUNCH).toBe("off");
    expect(env.CUQ_CHROME_PATH).toBeUndefined();
    expect(env.CUQ_PROFILE_DIR).toBeUndefined();
    expect(env.PATH).toBe("preserve");
  });
  it("rejects an endpoint that advertises another browser identity", async () => {
    const run = await createUxRun({ outputRoot: root(), handler: (_req: any, res: any) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:12345/devtools/browser/foreign" }));
    } });
    runs.push(run);
    await expect(verifyEndpoint(run.baseUrl, "ws://127.0.0.1:12345/devtools/browser/owned")).rejects.toThrow(/identity|身份/i);
  });
  it("reports launch failure without touching a running local server", async () => {
    const run = await createUxRun({ outputRoot: root(), handler: (_req: any, res: any) => res.end("untouched") });
    runs.push(run);
    await expect(run.launchBrowser({ executablePath: join(run.out, "no-such-chrome.exe"), headless: true })).rejects.toThrow();
    expect(await (await fetch(run.baseUrl)).text()).toBe("untouched");
    await run.close();
    expect(existsSync(run.profile ?? "")).toBe(false);
  });
  it("attempts all registered cleanup and reports failure", async () => {
    const run = await createUxRun({ outputRoot: root(), handler: (_req: any, res: any) => res.end("ok") });
    const calls: string[] = [];
    run.addCleanup(async () => { calls.push("first"); throw new Error("client close failed"); });
    run.addCleanup(async () => { calls.push("second"); });
    await expect(run.close()).rejects.toThrow(/client close failed/);
    expect(calls.sort()).toEqual(["first", "second"]);
    await expect(run.close()).rejects.toThrow(/client close failed/);
    await expect(fetch(run.baseUrl)).rejects.toThrow();
  });
  it("concurrent close callers wait for the same cleanup outcome", async () => {
    const run = await createUxRun({ outputRoot: root(), handler: (_req: any, res: any) => res.end("ok") });
    let completed = false;
    run.addCleanup(async () => { await new Promise(resolve => setTimeout(resolve, 80)); completed = true; });
    const first = run.close();
    await run.close();
    expect(completed).toBe(true);
    await first;
  });
  it("a real runner startup failure writes a failed summary and cleans up", async () => {
    const outputRoot = root();
    const result = await promisify(execFile)(process.execPath, [
      resolve("scripts/e2e-ux.mjs"), "--headless", "--output-root", outputRoot
    ], { env: { ...process.env, CUQ_UX_CHROME_PATH: join(outputRoot, "missing.exe"), CUQ_LAUNCH: "auto" },
      timeout: 20_000 }).then(() => ({ code: 0, stdout: "" }), (error: any) => error);
    expect(result.code).toBe(1);
    const out = result.stdout.match(/Isolated run: (.+)/)?.[1].trim();
    expect(out).toBeTruthy();
    const report = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
    expect(report.failed).toBe(1);
    expect(report.cleanupOk).toBe(true);
    expect(report.scenarios.find((s: any) => s.name === "setup/run").ok).toBe(false);
    expect(existsSync(report.profile)).toBe(false);
    await expect(fetch(report.baseUrl)).rejects.toThrow();
  });
  it("waits for a pending owned launch before removing its profile", async () => {
    const endpoint = await createUxRun({ outputRoot: root(), handler: (_req: any, res: any) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ webSocketDebuggerUrl: "ws://" + _req.headers.host + "/devtools/browser/owned" }));
    } });
    runs.push(endpoint);
    const run = await createUxRun({ outputRoot: root(), handler: (_req: any, res: any) => res.end("ok") });
    let release: (value: any) => void = () => {};
    let closes = 0;
    const ws = new URL(endpoint.baseUrl); ws.protocol = "ws:"; ws.pathname = "/devtools/browser/owned";
    vi.spyOn(puppeteer, "launch").mockImplementation(() => new Promise<any>(resolve => { release = resolve; }));
    const launching = run.launchBrowser({ executablePath: "controlled-launch" });
    launching.catch(() => {});
    const profile = run.profile;
    const closing = run.close();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(existsSync(profile)).toBe(true);
    release({ wsEndpoint: () => ws.toString(), process: () => null, close: async () => { closes++; } });
    await Promise.allSettled([launching, closing]);
    expect(closes).toBe(1);
    expect(existsSync(profile)).toBe(false);
    expect(run.browser).toBeUndefined();
  });
  it("refuses to report a live MCP child as cleaned up", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    try {
      await expect(waitProcessExit(child.pid, 100)).rejects.toThrow(/still alive|退出/);
      const exited = new Promise(resolve => child.once("exit", resolve));
      child.kill(); await exited;
      await expect(waitProcessExit(child.pid, 100)).resolves.toBeUndefined();
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
  });
  it("failure exit ends even when a resource keeps the event loop alive", async () => {
    const helper = new URL("../../scripts/lib/ux-run.mjs", import.meta.url).href;
    const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e",
      'import { finishRun } from ' + JSON.stringify(helper) + '; setInterval(()=>{},1000); finishRun(1);'
    ], { timeout: 3000 }).then(() => ({ code: 0 }), (error: any) => error);
    expect(result.code).toBe(1);
    expect(result.killed).not.toBe(true);
  });
  it("records a scenario failure without pretending it passed", async () => {
    const report: any[] = [];
    await scenario(report, "unexpected", async () => { throw new Error("assertion failed"); });
    await scenario(report, "expected", async () => { expect(2 + 2).toBe(4); });
    expect(report.map(r => r.ok)).toEqual([false, true]);
    expect(report[0].error).toContain("assertion failed");
  });
});
