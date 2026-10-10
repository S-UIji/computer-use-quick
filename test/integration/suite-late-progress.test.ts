import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { BrowserSession } from "../../src/session/browser.js";
import { runSuite, type TraceEvent } from "../../src/trace/suite.js";
import type { StepObserver } from "../../src/executor/observer.js";

let session: BrowserSession, dir: string, release: (() => void) | undefined;
beforeEach(async () => {
  session = await BrowserSession.connect(inject("browserURL"), { watch: false });
  dir = await mkdtemp(join(tmpdir(), "cuq-late-step-"));
});
afterEach(async () => {
  release?.(); release = undefined;
  await session?.close();
  const path = resolve(dir), root = resolve(tmpdir());
  if (dirname(path).toLowerCase() !== root.toLowerCase() || !basename(path).startsWith("cuq-late-step-")) throw Error("outside owned temporary root");
  await rm(path, { recursive: true, force: true });
});
describe("suite已结束步骤通知", () => {
  it("超时observer迟到返回不能在done后再发送成功step", async () => {
    const path = join(dir, "timed.json"), other = join(dir, "other.json");
    await writeFile(path, JSON.stringify({name:"timed-observer",baseUrl:inject("fixtureURL"),createdAt:"2026-10-10",steps:[{action:"sleep",ms:1}]}));
    await writeFile(other, JSON.stringify({name:"other",baseUrl:inject("fixtureURL"),createdAt:"2026-10-10",steps:Array.from({length:6},()=>({action:"sleep",ms:100}))}));
    let finishFirst!: () => void;
    const firstDone = new Promise<void>(r => { finishFirst = r; });
    const held = new Promise<void>(r => { release = r; });
    const events: TraceEvent[] = [];
    const observer: StepObserver = {
      onRunStart: async () => {}, onStepStart: async () => {},
      onStepEnd: async () => { await held; },
      onRunEnd: async () => {}, takeInterruption: () => undefined, takeScrollCount: () => 0
    };
    const running = runSuite({session,paths:[path,other],vars:{},concurrency:2,stepTimeoutMs:250,runsDir:join(dir,"runs"),
      observerFor: (_handle,name) => name==="timed-observer" ? observer : undefined,
      onTraceEvent: event => { events.push(event); if(event.kind==="done"&&event.result.name==="timed-observer")finishFirst(); }
    });
    try {
      await firstDone;
      release!();
      const result = await running;
      expect(result.results[0].record?.failure?.retryBlocked).toBe(true);
      expect(result.results[1].ok).toBe(true);
      const done = events.findIndex(e=>e.kind==="done"&&e.result.name==="timed-observer");
      expect(done).toBeGreaterThanOrEqual(0);
      expect(events.slice(done+1).filter(e=>e.kind==="step"&&e.name==="timed-observer")).toHaveLength(0);
    } finally { release!(); await running; }
  });
});
