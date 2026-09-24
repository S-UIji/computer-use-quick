import { describe, it, expect, beforeAll, afterAll, afterEach, inject } from "vitest";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserSession } from "../../src/session/browser.js";
import { runSuite } from "../../src/trace/suite.js";
import { renderSuiteResult } from "../../src/report/suiteReport.js";
import { loadTrace, saveTrace } from "../../src/trace/store.js";
import { captureAuth, applyAuth } from "../../src/session/auth.js";
import type { Trace } from "../../src/types.js";

let session: BrowserSession;
const fx = { url: "" };

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "cuq-suite-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

beforeAll(async () => {
  fx.url = inject("fixtureURL");
  session = await BrowserSession.connect(inject("browserURL"));
});
afterAll(async () => { await session?.close(); });

const clickTestId = (value: string) => ({
  action: "click",
  target: { descriptor: { strategies: [{ kind: "test-id" as const, value }], framePath: [] } }
});

/** 全绿用例：cards-v1 点第一张卡的按钮并断言回显 */
function goodTrace(name: string): Trace {
  return {
    name, baseUrl: fx.url, createdAt: "2026-09-21T00:00:00.000Z",
    steps: [
      { action: "navigate", url: "/cards-v1.html" },
      clickTestId("detail-edu"),
      { action: "assert", type: "text-equals" as const,
        target: { descriptor: { strategies: [{ kind: "css" as const, value: "#clicked" }], framePath: [] } },
        expected: "教育事业群 · 查看在岗干部明细" }
    ]
  };
}

/** 必挂用例：点不到的按钮 */
function brokenTrace(name: string): Trace {
  return {
    name, baseUrl: fx.url, createdAt: "2026-09-21T00:00:00.000Z",
    steps: [
      { action: "navigate", url: "/cards-v1.html" },
      { action: "click", target: { descriptor: {
        strategies: [{ kind: "role-name" as const, role: "button", name: "不存在的按钮" }],
        framePath: []
      } } }
    ]
  };
}

async function writeTraces(dir: string, traces: Trace[]): Promise<string[]> {
  const paths: string[] = [];
  for (const t of traces) paths.push(await saveTrace(dir, t));
  return paths;
}

describe("并行回放（replay_suite 编排）", () => {
  it("3 条并行全绿，墙钟显著小于各条耗时之和", async () => {
    const d = await tmp();
    const paths = await writeTraces(d, [
      goodTrace("p1"), goodTrace("p2"), goodTrace("p3")
    ]);
    const pagesBefore = (await session.listPages()).length;

    const t0 = Date.now();
    const r = await runSuite({ session, paths, vars: {}, concurrency: 3 });
    const wallMs = Date.now() - t0;

    expect(r.ok).toBe(3);
    expect(r.failed).toBe(0);
    const sum = r.results.reduce((a, x) => a + x.durationMs, 0);
    // 三条几乎同时跑：墙钟 ≈ max(各条)，必然远小于逐条相加（≈3 倍墙钟）
    expect(wallMs).toBeLessThan(sum * 0.8);
    // 跑完不留尾巴：标签页数量复原
    expect((await session.listPages()).length).toBe(pagesBefore);
  }, 30_000);

  it("一条失败其余照常跑完，失败带完整上下文", async () => {
    const d = await tmp();
    const paths = await writeTraces(d, [
      goodTrace("m-ok-1"), brokenTrace("m-broken"), goodTrace("m-ok-2")
    ]);
    const r = await runSuite({ session, paths, vars: {}, concurrency: 3 });

    expect(r.total).toBe(3);
    expect(r.ok).toBe(2);
    expect(r.failed).toBe(1);
    const broken = r.results.find((x) => x.name === "m-broken")!;
    expect(broken.ok).toBe(false);
    expect(broken.record?.failure?.kind).toBe("target-not-found");
    expect(broken.record?.healRequired).toBe(true);
    expect(r.results.filter((x) => x.ok).map((x) => x.name).sort())
      .toEqual(["m-ok-1", "m-ok-2"]);
  }, 30_000);

  it("concurrency=1 退化为串行，结果不变", async () => {
    const d = await tmp();
    const paths = await writeTraces(d, [goodTrace("s1"), goodTrace("s2")]);
    const r = await runSuite({ session, paths, vars: {}, concurrency: 1 });
    expect(r.ok).toBe(2);
    expect(r.failed).toBe(0);
  }, 30_000);

  it("隔离性：日常页的 cookie 在独立 Context 里不可见（heal 验证门的底座）", async () => {
    const daily = await session.getPage();
    await daily.page.goto(`${fx.url}/form.html`, { waitUntil: "load" });
    await daily.page.evaluate(() => { document.cookie = "explore-trace=dirty; path=/"; });

    const { handle, release } = await session.newIsolatedPage();
    try {
      await handle.page.goto(`${fx.url}/form.html`, { waitUntil: "load" });
      const cookie = await handle.page.evaluate(() => document.cookie);
      expect(cookie).not.toContain("explore-trace");
    } finally {
      await release();
    }
    // 日常页的 cookie 还在，互不影响
    expect(await daily.page.evaluate(() => document.cookie)).toContain("explore-trace");
  }, 30_000);
});

describe("并行压测基线（任务 4.3）", () => {
  // 说明：任务原文「复制 smoke-login」依赖真实靶场，测试套件不能依赖 SUT；
  // 改用 async-list（/api/orders 固定 800ms 服务端延迟）复制 3 份做等价压测。
  it("3 条慢用例并行 vs 串行：记录加速比", async () => {
    const slow = (name: string): Trace => ({
      name, baseUrl: fx.url, createdAt: "2026-09-21T00:00:00.000Z",
      steps: [
        { action: "navigate", url: "/async-list.html" },
        { action: "click", target: { descriptor: {
          strategies: [{ kind: "css" as const, value: "#load" }], framePath: []
        } } },
        { action: "assert", type: "text-contains" as const,
          target: { descriptor: { strategies: [{ kind: "css" as const, value: "#list" }], framePath: [] } },
          expected: "ORD20260911" }
      ]
    });
    const d = await tmp();
    const paths = await writeTraces(d, [slow("slow-1"), slow("slow-2"), slow("slow-3")]);

    const tSerial = Date.now();
    const serial = await runSuite({ session, paths, vars: {}, concurrency: 1 });
    const serialMs = Date.now() - tSerial;
    expect(serial.ok).toBe(3);

    const tPar = Date.now();
    const par = await runSuite({ session, paths, vars: {}, concurrency: 3 });
    const parMs = Date.now() - tPar;
    expect(par.ok).toBe(3);

    // 实测基线（2026-09-21，3 并发）：串行 6516ms / 并行 2426ms ≈ 2.69x。
    // 未达 3x 的原因：每条含 Context 创建与页面加载的固定开销，并发省的是 800ms
    // 服务端等待的重叠部分。用例越重（步骤多、接口慢），加速比越接近并发数。
    console.log(`[suite-bench] serial=${serialMs}ms parallel=${parMs}ms speedup=${(serialMs / parMs).toFixed(2)}x`);
    expect(parMs).toBeLessThan(serialMs * 0.7);
  }, 60_000);
});

describe("运行归档（任务 1.3）", () => {
  it("成功与失败运行都落 run-record；失败附现场包三件套", async () => {
    const d = await tmp();
    const runs = join(d, "runs");
    const paths = await writeTraces(d, [goodTrace("arch-ok"), brokenTrace("arch-bad")]);
    const r = await runSuite({ session, paths, vars: {}, concurrency: 2, runsDir: runs });
    expect(r.ok).toBe(1);

    // 失败条会自动重试：arch-bad 有首败与 -retry 两份归档
    const dirs = await readdir(runs);
    expect(dirs).toHaveLength(3);
    const okDir = dirs.find((x) => x.includes("arch-ok"))!;
    const badDir = dirs.find((x) => x.includes("arch-bad") && !x.endsWith("-retry"))!;
    // 成功运行：仅 run-record
    expect(await readdir(join(runs, okDir))).toEqual(["run-record.json"]);
    // 失败运行：run-record + 截图 + 快照 + trace 副本
    expect((await readdir(join(runs, badDir))).sort())
      .toEqual(["run-record.json", "screenshot.png", "snapshot.txt", "trace.json"]);
  }, 30_000);

  it("归档失败不影响运行结果（旁路语义）", async () => {
    const d = await tmp();
    const fileAsDir = join(d, "blocker");
    await writeFile(fileAsDir, "不是目录", "utf8"); // 在其下建目录必失败
    const paths = await writeTraces(d, [goodTrace("arch-fail")]);
    const r = await runSuite({ session, paths, vars: {}, concurrency: 1, runsDir: fileAsDir });
    expect(r.ok).toBe(1); // 归档失败，运行结果照常
  }, 30_000);
});

describe("单条重试（任务 2.3）", () => {
  it("首败重试通过 → flaky 标记 + 聚合报告体现 + 两次尝试各归档", async () => {
    const d = await tmp();
    const runs = join(d, "runs");
    // /api/flaky-once 进程内首调 500：首 attempt 的 assert 挂，重试（200）通过
    const trace: Trace = {
      name: "flaky-trace", baseUrl: fx.url, createdAt: "2026-09-24T00:00:00.000Z",
      steps: [
        { action: "navigate", url: "/flaky.html" },
        { action: "click", target: { descriptor: {
          strategies: [{ kind: "css" as const, value: "#load" }], framePath: []
        } } },
        { action: "assert", type: "text-contains" as const,
          target: { descriptor: { strategies: [{ kind: "css" as const, value: "#out" }], framePath: [] } },
          expected: "加载成功" }
      ]
    };
    const tracePath = await saveTrace(d, trace);
    const r = await runSuite({ session, paths: [tracePath], vars: {}, concurrency: 1, runsDir: runs });

    expect(r.ok).toBe(1);
    expect(r.flaky).toBe(1);
    expect(r.results[0].attempts).toBe(2);
    expect(r.results[0].flaky).toBe(true);

    const text = renderSuiteResult(r);
    expect(text).toContain("flaky");
    // 两次尝试各归档一份，第二份带 -retry 后缀
    const dirs = await readdir(runs);
    expect(dirs).toHaveLength(2);
    expect(dirs.some((x) => x.endsWith("-retry"))).toBe(true);
  }, 30_000);

  it("重试仍失败 → attempts=2 按失败处理", async () => {
    const d = await tmp();
    const runs = join(d, "runs");
    const paths = await writeTraces(d, [brokenTrace("retry-broken")]);
    const r = await runSuite({ session, paths, vars: {}, concurrency: 1, runsDir: runs });

    expect(r.failed).toBe(1);
    expect(r.results[0].attempts).toBe(2);
    expect(r.results[0].flaky).toBeUndefined();
    expect(r.results[0].record?.failure?.kind).toBe("target-not-found");
    // 两次失败尝试都归档（现场包各一份）
    expect(await readdir(runs)).toHaveLength(2);
    // 重试不消耗自愈预算（suite 层不触碰 healBudgets，结构性保证）
  }, 30_000);
});

describe("认证态（任务 3.4）", () => {
  const loginDemo = async () => {
    const h = await session.getPage();
    await h.page.goto(`${fx.url}/auth-demo.html`, { waitUntil: "load" });
    await h.cdp.send("Runtime.evaluate", {
      expression: `document.getElementById("login").click()`, returnByValue: true
    });
    return h;
  };

  it("捕获→注入：新 Context 恢复登录态（cookie + localStorage）", async () => {
    const h = await loginDemo();
    const auth = await captureAuth(h);
    expect(auth.cookies.some((c) => c.name === "cuq_auth")).toBe(true);
    expect(auth.origins[0]?.localStorage.cuq_token).toBe("abc123");

    const { handle, release } = await session.newIsolatedPage();
    try {
      await applyAuth(handle, auth);
      await handle.page.goto(`${fx.url}/auth-demo.html`, { waitUntil: "load" });
      const { result } = await handle.cdp.send("Runtime.evaluate", {
        expression: `JSON.stringify({ cookie: document.cookie, token: localStorage.getItem("cuq_token") })`,
        returnByValue: true
      });
      const v = JSON.parse((result as { value: string }).value);
      expect(v.cookie).toContain("cuq_auth=1");
      expect(v.token).toBe("abc123");
    } finally {
      await release();
    }
  }, 30_000);

  it("套件注入：无 auth 失败、有 auth 通过", async () => {
    const d = await tmp();
    const trace: Trace = {
      name: "auth-trace", baseUrl: fx.url, createdAt: "2026-09-24T00:00:00.000Z",
      steps: [
        { action: "navigate", url: "/auth-demo.html" },
        { action: "assert", type: "visible" as const,
          target: { descriptor: { strategies: [{ kind: "css" as const, value: "#protected" }], framePath: [] } } }
      ]
    };
    const tracePath = await saveTrace(d, trace);

    // 无 auth：#protected 不渲染 → 失败
    const r1 = await runSuite({ session, paths: [tracePath], vars: {}, concurrency: 1, runsDir: join(d, "runs1") });
    expect(r1.failed).toBe(1);

    // 捕获登录态后注入：通过
    const h = await loginDemo();
    const auth = await captureAuth(h);
    const r2 = await runSuite({
      session, paths: [tracePath], vars: {}, concurrency: 1,
      runsDir: join(d, "runs2"), auth
    });
    expect(r2.ok).toBe(1);
  }, 30_000);
});
