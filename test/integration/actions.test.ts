import { describe, it, expect, beforeAll, afterAll } from "vitest";
import puppeteer, { type Browser } from "puppeteer";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { startFixtureServer } from "../fixtures/server.js";
import { NetworkTracker } from "../../src/waiter/stability.js";
import { runAction, type ActionContext } from "../../src/executor/actions.js";
import type { Descriptor } from "../../src/types.js";

let chrome: Browser, session: BrowserSession, fx: Awaited<ReturnType<typeof startFixtureServer>>;
let tracker: NetworkTracker;

beforeAll(async () => {
  fx = await startFixtureServer();
  chrome = await puppeteer.launch({ headless: true, args: ["--remote-debugging-port=9341", "--no-sandbox"] });
  session = await BrowserSession.connect("http://127.0.0.1:9341");
  tracker = await NetworkTracker.attach(await session.getPage());
});
afterAll(async () => { await session?.close(); await chrome?.close(); await fx?.close(); });

const css = (value: string): { descriptor: Descriptor } => ({
  descriptor: { strategies: [{ kind: "css", value }], framePath: [] }
});

async function ctxFor(path: string): Promise<ActionContext> {
  const h: PageHandle = await session.getPage();
  await h.page.goto(`${fx.url}/${path}`, { waitUntil: "load" });
  return { handle: h, tracker, refs: new Map(), vars: {} };
}

async function textOf(ctx: ActionContext, selector: string): Promise<string> {
  const { result } = await ctx.handle.cdp.send("Runtime.evaluate", {
    expression: `document.querySelector(${JSON.stringify(selector)}).textContent`,
    returnByValue: true
  });
  return (result as { value: string }).value;
}

async function valueOf(ctx: ActionContext, selector: string): Promise<string> {
  const { result } = await ctx.handle.cdp.send("Runtime.evaluate", {
    expression: `document.querySelector(${JSON.stringify(selector)}).value`,
    returnByValue: true
  });
  return (result as { value: string }).value;
}

describe("runAction", () => {
  it("fill 写入真实值并触发 input 事件", async () => {
    const ctx = await ctxFor("form.html");
    await runAction(ctx, { action: "fill", target: css("#user"), value: "admin" });
    expect(await valueOf(ctx, "#user")).toBe("admin");
  });

  it("click 触发页面的 click 监听器", async () => {
    const ctx = await ctxFor("form.html");
    await runAction(ctx, { action: "fill", target: css("#user"), value: "admin" });
    await runAction(ctx, { action: "click", target: css("#submit") });
    expect(await textOf(ctx, "#result")).toBe("欢迎 admin");
  });

  it("click 后自动隐式等待，异步内容已就绪", async () => {
    const ctx = await ctxFor("async-list.html");
    await runAction(ctx, { action: "click", target: css("#load") });
    expect(await textOf(ctx, "#list")).toContain("ORD20260911");
  });

  it("select 选中选项并触发 change", async () => {
    const ctx = await ctxFor("form.html");
    await runAction(ctx, { action: "select", target: css("#region"), value: "hf" });
    expect(await valueOf(ctx, "#region")).toBe("hf");
  });

  it("navigate 跳转到新页面", async () => {
    const ctx = await ctxFor("form.html");
    await runAction(ctx, { action: "navigate", url: `${fx.url}/table-dup.html` });
    const { result } = await ctx.handle.cdp.send("Runtime.evaluate", {
      expression: "location.pathname", returnByValue: true
    });
    expect((result as { value: string }).value).toBe("/table-dup.html");
  });

  it("extract 把页面文本存进变量表", async () => {
    const ctx = await ctxFor("form.html");
    await runAction(ctx, { action: "fill", target: css("#user"), value: "admin" });
    await runAction(ctx, { action: "click", target: css("#submit") });
    await runAction(ctx, { action: "extract", target: css("#result"), as: "GREETING" });
    expect(ctx.vars.GREETING).toBe("欢迎 admin");
  });

  it("extract from=value 取输入框的值", async () => {
    const ctx = await ctxFor("form.html");
    await runAction(ctx, { action: "fill", target: css("#user"), value: "zhangsan" });
    await runAction(ctx, { action: "extract", target: css("#user"), as: "U", from: "value" });
    expect(ctx.vars.U).toBe("zhangsan");
  });

  it("fill 会先清空原有内容", async () => {
    const ctx = await ctxFor("form.html");
    await runAction(ctx, { action: "fill", target: css("#user"), value: "first" });
    await runAction(ctx, { action: "fill", target: css("#user"), value: "second" });
    expect(await valueOf(ctx, "#user")).toBe("second");
  });

  it("checkbox 可以被真实点击勾上", async () => {
    const ctx = await ctxFor("form.html");
    await runAction(ctx, { action: "click", target: css("#remember") });
    const { result } = await ctx.handle.cdp.send("Runtime.evaluate", {
      expression: `document.getElementById("remember").checked`, returnByValue: true
    });
    expect((result as { value: boolean }).value).toBe(true);
  });
});
