import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { BrowserSession } from "../../src/session/browser.js";
import { NetworkTracker } from "../../src/waiter/stability.js";
import { runAction, type ActionContext } from "../../src/executor/actions.js";
import { runAssert, AssertionFailure } from "../../src/assertion/assert.js";
import type { Descriptor } from "../../src/types.js";

let session: BrowserSession;
const fx = { url: "" };
let tracker: NetworkTracker;

beforeAll(async () => {
  fx.url = inject("fixtureURL");
  session = await BrowserSession.connect(inject("browserURL"));
  tracker = await NetworkTracker.attach(await session.getPage());
});
afterAll(async () => { await session?.close(); });

const css = (value: string): { descriptor: Descriptor } => ({
  descriptor: { strategies: [{ kind: "css", value }], framePath: [] }
});

async function ctxFor(path: string): Promise<ActionContext> {
  const h = await session.getPage();
  await h.page.goto(`${fx.url}/${path}`, { waitUntil: "load" });
  return { handle: h, tracker, refs: new Map(), vars: {} };
}

describe("runAssert", () => {
  it("visible 对存在的元素通过", async () => {
    const ctx = await ctxFor("form.html");
    await runAssert(ctx, { action: "assert", type: "visible", target: css("#submit") });
  });

  it("visible 对隐藏元素抛 AssertionFailure", async () => {
    const ctx = await ctxFor("modal-iframe.html");
    await expect(
      runAssert(ctx, { action: "assert", type: "visible", target: css("#cust") })
    ).rejects.toBeInstanceOf(AssertionFailure);
  });

  it("hidden 对隐藏元素通过", async () => {
    const ctx = await ctxFor("modal-iframe.html");
    await runAssert(ctx, { action: "assert", type: "hidden", target: css("#cust") });
  });

  it("text-equals 严格匹配", async () => {
    const ctx = await ctxFor("form.html");
    await runAction(ctx, { action: "fill", target: css("#user"), value: "admin" });
    await runAction(ctx, { action: "click", target: css("#submit") });
    await runAssert(ctx, {
      action: "assert", type: "text-equals", target: css("#result"), expected: "欢迎 admin"
    });
  });

  it("text-contains 部分匹配", async () => {
    const ctx = await ctxFor("form.html");
    await runAction(ctx, { action: "fill", target: css("#user"), value: "admin" });
    await runAction(ctx, { action: "click", target: css("#submit") });
    await runAssert(ctx, {
      action: "assert", type: "text-contains", target: css("#result"), expected: "admin"
    });
  });

  it("text-equals 不匹配时错误信息含实际值与期望值", async () => {
    const ctx = await ctxFor("form.html");
    try {
      await runAssert(ctx, {
        action: "assert", type: "text-equals", target: css("#result"), expected: "不可能的值"
      });
      expect.unreachable("应该抛错");
    } catch (e) {
      expect(e).toBeInstanceOf(AssertionFailure);
      expect((e as AssertionFailure).expected).toBe("不可能的值");
      expect((e as Error).message).toContain("不可能的值");
    }
  });

  it("url-contains 命中当前地址", async () => {
    const ctx = await ctxFor("form.html");
    await runAssert(ctx, { action: "assert", type: "url-contains", expected: "form.html" });
  });

  it("断言目标不存在时报告为断言失败而非崩溃", async () => {
    const ctx = await ctxFor("form.html");
    await expect(
      runAssert(ctx, {
        action: "assert", type: "text-equals", target: css("#nope"), expected: "x"
      })
    ).rejects.toBeInstanceOf(AssertionFailure);
  });
});
