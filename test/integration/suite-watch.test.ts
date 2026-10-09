import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserSession } from "../../src/session/browser.js";
import { runSuite } from "../../src/trace/suite.js";
import { FakeObserver } from "../fixtures/fake-observer.js";

let session: BrowserSession;
let dir: string;
const fx = { url: "" };
const css = (value: string) => ({ descriptor: { strategies: [{ kind: "css", value }], framePath: [] } });

beforeAll(async () => {
  fx.url = inject("fixtureURL");
  session = await BrowserSession.connect(inject("browserURL"));
  dir = await mkdtemp(join(tmpdir(), "cuq-suite-watch-"));
});
afterAll(async () => {
  await session?.close();
  await rm(dir, { recursive: true, force: true });
});

async function writeTrace(name: string, steps: unknown[]): Promise<string> {
  const p = join(dir, `${name}.json`);
  await writeFile(p, JSON.stringify({ name, baseUrl: fx.url, createdAt: "", steps }), "utf8");
  return p;
}

describe("runSuite 与介入", () => {
  it("被打断的用例有开始和唯一终态，不重试", async () => {
    const path = await writeTrace("two-steps", [
      { action: "navigate", url: "/form.html" },
      { action: "fill", target: css("#user"), value: "admin" }
    ]);
    const events: string[] = [];
    const r = await runSuite({
      session, paths: [path], vars: {}, concurrency: 1,
      runsDir: join(dir, "runs"), baselineRoot: join(dir, "baselines"),
      observerFor: () => new FakeObserver({ interruptAt: 0 }),
      onTraceEvent: (e) => events.push(e.kind + ":" + (e.kind === "started" || e.kind === "step" ? e.name : e.result.name))
    });
    const t = r.results[0];
    expect(t.ok).toBe(false);
    expect(t.interrupted).toBe(true);
    expect(t.attempts).toBe(1);
    expect(t.record?.failure?.kind).toBe("user-interrupted");
    expect(events[0]).toBe("started:two-steps");
    expect(events.filter(event => event.startsWith("done:"))).toEqual(["done:two-steps"]);
    expect(events.some(event => event.startsWith("retrying:"))).toBe(false);
  });

  it("并发worker槽位固定，失败重试沿用，headless不调整窗口",async()=>{
    const paths=await Promise.all([writeTrace("slot-fail",[{action:"navigate",url:"/form.html"},{action:"wait",until:{type:"visible",target:css("#missing-r13")},timeout:30}]),writeTrace("slot-ok",[{action:"sleep",ms:100}]),writeTrace("slot-next",[{action:"sleep",ms:50}])]);
    const original=session.newIsolatedPage.bind(session);const slots:unknown[]=[];
    const spy=vi.spyOn(session,"newIsolatedPage").mockImplementation(async(slot)=>{slots.push(slot);return original(slot)});
    try{const result=await runSuite({session,paths,vars:{},concurrency:2,runsDir:join(dir,"slot-runs")});expect(result.results[0].attempts).toBe(2);expect(result.ok).toBe(2);expect(slots).toEqual([{index:0,of:2},{index:1,of:2},{index:1,of:2},{index:0,of:2}]);}finally{spy.mockRestore()}
  });

  it("暂态等待失败重试一次：有开始、步骤、retrying和唯一done", async () => {
    const path = await writeTrace("always-fails", [
      { action: "navigate", url: "/form.html" },
      { action: "wait", until: { type: "visible", target: css("#nope") }, timeout: 30 }
    ]);
    const events: string[] = [];
    const r = await runSuite({
      session, paths: [path], vars: {}, concurrency: 1, resolveRetryMs: 0,
      runsDir: join(dir, "runs"), baselineRoot: join(dir, "baselines"),
      onTraceEvent: (e) => events.push(e.kind + ":" + (e.kind === "started" || e.kind === "step" ? e.name : e.result.name))
    });
    expect(r.results[0].attempts).toBe(2);
    expect(r.results[0].interrupted).toBeUndefined();
    expect(events[0]).toBe("started:always-fails");
    expect(events.filter(event => event.startsWith("retrying:") || event.startsWith("done:")))
      .toEqual(["retrying:always-fails", "done:always-fails"]);
  });
});
