import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
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
  it("被打断的用例不重试，标 interrupted，只发 done 事件", async () => {
    const path = await writeTrace("two-steps", [
      { action: "navigate", url: "/form.html" },
      { action: "fill", target: css("#user"), value: "admin" }
    ]);
    const events: string[] = [];
    const r = await runSuite({
      session, paths: [path], vars: {}, concurrency: 1,
      runsDir: join(dir, "runs"), baselineRoot: join(dir, "baselines"),
      observerFor: () => new FakeObserver({ interruptAt: 0 }),
      onTraceEvent: (e) => events.push(`${e.kind}:${e.result.name}`)
    });
    const t = r.results[0];
    expect(t.ok).toBe(false);
    expect(t.interrupted).toBe(true);
    expect(t.attempts).toBe(1);
    expect(t.record?.failure?.kind).toBe("user-interrupted");
    expect(events).toEqual(["done:two-steps"]);
  });

  it("普通失败照常重试一次：先发 retrying 再发 done", async () => {
    const path = await writeTrace("always-fails", [
      { action: "navigate", url: "/form.html" },
      { action: "click", target: css("#nope") }
    ]);
    const events: string[] = [];
    const r = await runSuite({
      session, paths: [path], vars: {}, concurrency: 1, resolveRetryMs: 0,
      runsDir: join(dir, "runs"), baselineRoot: join(dir, "baselines"),
      onTraceEvent: (e) => events.push(`${e.kind}:${e.result.name}`)
    });
    expect(r.results[0].attempts).toBe(2);
    expect(r.results[0].interrupted).toBeUndefined();
    expect(events).toEqual(["retrying:always-fails", "done:always-fails"]);
  });
});
