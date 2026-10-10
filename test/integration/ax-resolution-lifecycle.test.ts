import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { resolve } from "../../src/locator/resolve.js";
import { ExecutionDeadlineError, runWithDeadline } from "../../src/executor/deadline.js";

let session: BrowserSession, target: PageHandle, user: PageHandle;
const within = <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("AX query did not settle")), ms); })]).finally(() => clearTimeout(timer));
};
beforeEach(async () => {
  session = await BrowserSession.connect(inject("browserURL")); target = await session.newPage();
  await target.page.goto(inject("fixtureURL") + "/table-dup.html", { waitUntil: "load" });
  user = await session.newPage(); await user.page.setContent("<title>user surface</title><input value='private'>"); await user.page.bringToFront();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await target?.page.close().catch(() => {}); await user?.page.close().catch(() => {}); await session?.close();
});

describe("scoped AX lifecycle preparation", () => {
  it("resolves background role/name ambiguity without activating the page", async () => {
    expect(await target.page.evaluate(() => document.visibilityState)).toBe("hidden");
    const resolving = resolve(target, { strategies: [{ kind: "role-name", role: "button", name: "删除" }], framePath: [], distinguishers: ["ORD20260911", "ORD20260912"] });
    try {
      await expect(within(resolving, 1500)).rejects.toMatchObject({ kind: "ambiguous", matchCount: 3, candidates: ["ORD20260911", "ORD20260912"] });
      expect(await user.page.evaluate(() => document.visibilityState)).toBe("visible");
      expect(await target.page.evaluate(() => document.visibilityState)).toBe("hidden");
    } finally { await target.cdp.send("Accessibility.getFullAXTree").catch(() => {}); await resolving.catch(() => {}); }
  });

  it("an expired partial-tree response cannot dispatch another query or return late success", async () => {
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const original = target.cdp.send.bind(target.cdp); let primed = 0, queried = 0;
    vi.spyOn(target.cdp, "send").mockImplementation(((method: string, params?: any) => {
      const sent = original(method as any, params);
      if (method === "Accessibility.getPartialAXTree") { primed++; return held.then(() => sent); }
      if (method === "Accessibility.queryAXTree") queried++;
      return sent;
    }) as any);
    const resolving = runWithDeadline(target, 100, () => resolve(target, { strategies: [{ kind: "role-name", role: "button", name: "删除" }], framePath: [] }));
    try {
      await expect(resolving).rejects.toBeInstanceOf(ExecutionDeadlineError);
      expect(primed).toBe(1); expect(queried).toBe(1);
      release(); await new Promise(resolve => setTimeout(resolve, 30));
      expect(queried).toBe(1);
    } finally { release(); }
  });
  it("a rejected AX update fails the strategy without waiting indefinitely for its query", async () => {
    const original = target.cdp.send.bind(target.cdp);
    vi.spyOn(target.cdp, "send").mockImplementation(((method: string, params?: any) => {
      if (method === "Accessibility.getPartialAXTree") return Promise.reject(Object.assign(new Error("Method not found"), { code: -32601 }));
      return original(method as any, params);
    }) as any);
    try {
      await expect(within(resolve(target, { strategies: [{ kind: "role-name", role: "button", name: "删除" }], framePath: [] }), 1500))
        .rejects.toMatchObject({ kind: "target-not-found" });
    } finally { await original("Accessibility.getFullAXTree").catch(() => {}); }
  });

});
