import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { NetworkTracker } from "../../src/waiter/stability.js";
import { DiagnosticsCollector } from "../../src/diagnostics/collector.js";
import { runBatch } from "../../src/executor/batch.js";
import { baselineHash } from "../../src/perception/pngDiff.js";
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, mkdir: vi.fn(actual.mkdir), writeFile: vi.fn(actual.writeFile) };
});
let session: BrowserSession, handle: PageHandle, dir: string;
let release: (() => void) | undefined, pending: Promise<any> | undefined;
beforeEach(async () => {
  session = await BrowserSession.connect(inject("browserURL"), { watch: false });
  handle = await session.newPage();
  await handle.page.goto(inject("fixtureURL") + "/form.html");
  dir = await fs.mkdtemp(join(tmpdir(), "cuq-visual-deadline-"));
});
afterEach(async () => {
  release?.(); release = undefined;
  await pending?.catch(() => {}); pending = undefined;
  vi.restoreAllMocks();
  await handle?.page.close().catch(() => {});
  await session?.close();
  const path = resolve(dir), root = resolve(tmpdir());
  if (dirname(path).toLowerCase() !== root.toLowerCase() || !basename(path).startsWith("cuq-visual-deadline-")) throw Error("outside owned temporary root");
  await fs.rm(path, { recursive: true, force: true });
});
describe("视觉基线的截止边界", () => {
  it("mkdir跨过截止后不能迟到创建或覆盖基线", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const traceName = "held-baseline", baselineDir = join(dir, traceName);
    const baselinePath = join(baselineDir, baselineHash(undefined, true) + ".png");
    let enter!: () => void, finishDirectory!: () => void;
    const entered = new Promise<void>(r => { enter = r; });
    const held = new Promise<void>(r => { release = r; });
    const directoryDone = new Promise<void>(r => { finishDirectory = r; });
    vi.mocked(fs.mkdir).mockImplementation((async (...args: any[]) => {
      if (resolve(String(args[0])) === resolve(baselineDir)) {
        enter(); await held;
        const result = await (actual.mkdir as any)(...args);
        finishDirectory(); return result;
      }
      return (actual.mkdir as any)(...args);
    }) as any);
    const tracker = await NetworkTracker.attach(handle), collector = await DiagnosticsCollector.attach(handle);
    pending = runBatch({handle,tracker,collector,refs:new Map(),vars:{},
      steps:[{action:"assert",type:"screenshot-match",fullPage:true}],
      stepTimeoutMs:1000, stability:{timeoutMs:0},visual:{traceName,baselineRoot:dir,updateBaselines:true}});
    await entered;
    const result = await pending;
    expect(result.failure?.kind).toBe("timeout");
    expect(result.failure?.retryBlocked).toBe(true);
    release!(); await directoryDone;
    await handle.cdp.send("Target.getTargetInfo"); // real event boundary after the released continuation's microtasks
    expect(vi.mocked(fs.writeFile).mock.calls.filter(args=>resolve(String(args[0]))===resolve(baselinePath))).toHaveLength(0);
    expect(existsSync(baselinePath)).toBe(false);
  });
  it("截止内的视觉基线仍实际创建", async () => {
    const tracker = await NetworkTracker.attach(handle), collector = await DiagnosticsCollector.attach(handle);
    const result = await runBatch({handle,tracker,collector,refs:new Map(),vars:{},
      steps:[{action:"assert",type:"screenshot-match",fullPage:true}],
      stepTimeoutMs:3000,stability:{timeoutMs:0},visual:{traceName:"normal-baseline",baselineRoot:dir}});
    expect(result.ok).toBe(true);
    expect(existsSync(join(dir,"normal-baseline",baselineHash(undefined,true)+".png"))).toBe(true);
  });
});
