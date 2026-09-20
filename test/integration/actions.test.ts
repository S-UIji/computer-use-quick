import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { NetworkTracker } from "../../src/waiter/stability.js";
import { runAction, type ActionContext } from "../../src/executor/actions.js";
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

  it("被覆盖的 submit 按钮能通过 click 触发表单提交", async () => {
    // 复刻百度搜索表单：原生 submit 被 CSS 隐藏（opacity:0），
    // 视觉位置由覆盖 div 替代。CDP 鼠标事件打在覆盖 div 上无法触发提交，
    // hit-test 检测到遮挡后补一个 JS dispatchEvent('click') 直达按钮。
    const ctx = await ctxFor("hidden-submit.html");
    await runAction(ctx, { action: "click", target: css("#su") });
    expect(await textOf(ctx, "#submit-count")).toBe("1");
  });

  it("被覆盖的 submit 按钮连点两次，submit 事件触发两次", async () => {
    const ctx = await ctxFor("hidden-submit.html");
    await runAction(ctx, { action: "click", target: css("#su") });
    await runAction(ctx, { action: "click", target: css("#su") });
    expect(await textOf(ctx, "#submit-count")).toBe("2");
  });

  it("被覆盖的 submit 按钮点击后 checkbox 不会被双击", async () => {
    // 同一页面上有一个可见 checkbox，点击隐藏 submit 后检查 checkbox 的
    // change 计数是否仍为 0（未被误触发），验证 JS dispatchEvent('click')
    // 不会产生双击副作用。
    const ctx = await ctxFor("hidden-submit.html");
    await runAction(ctx, { action: "click", target: css("#su") });
    expect(await textOf(ctx, "#change-count")).toBe("0");
  });

  it("hidden-submit 页面上的可见 checkbox 点击只 toggle 一次", async () => {
    const ctx = await ctxFor("hidden-submit.html");
    await runAction(ctx, { action: "click", target: css("#agree") });
    expect(await textOf(ctx, "#change-count")).toBe("1");
  });
});
