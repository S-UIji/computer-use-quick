import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { NetworkTracker, waitStable } from "../../src/waiter/stability.js";
import { waitFor } from "../../src/waiter/explicit.js";

let session: BrowserSession;
const fx = { url: "" };
let tracker: NetworkTracker;

beforeAll(async () => {
  fx.url = inject("fixtureURL");
  session = await BrowserSession.connect(inject("browserURL"));
  tracker = await NetworkTracker.attach(await session.getPage());
});
afterAll(async () => { await session?.close(); });

async function open(path: string): Promise<PageHandle> {
  const h = await session.getPage();
  await h.page.goto(`${fx.url}/${path}`, { waitUntil: "load" });
  return h;
}

describe("waitStable", () => {
  it("静止页面上快速返回（< 1s）", async () => {
    const h = await open("form.html");
    const t0 = Date.now();
    await waitStable(h, tracker);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("等到 800ms 的网络请求回来、DOM 更新完成才返回", async () => {
    const h = await open("async-list.html");
    await h.cdp.send("Runtime.evaluate", { expression: `document.getElementById("load").click()` });
    await waitStable(h, tracker);
    const { result } = await h.cdp.send("Runtime.evaluate", {
      expression: `document.getElementById("list").textContent`,
      returnByValue: true
    });
    expect((result as { value: string }).value).toContain("ORD20260911");
  });

  it("已知边界：纯 setTimeout 更新无在途信号，隐式等待检测不到，需显式 wait", async () => {
    const h = await open("async-list.html");
    await h.cdp.send("Runtime.evaluate", { expression: `document.getElementById("timer").click()` });

    // 隐式等待会在 DOM 静默后就返回，此时定时器还没触发
    await waitStable(h, tracker);
    const mid = await h.cdp.send("Runtime.evaluate", {
      expression: `document.getElementById("list").textContent`, returnByValue: true
    });
    expect((mid.result as { value: string }).value).toBe("加载中…");

    // 显式 wait 才等得到
    await waitFor(h, tracker, {
      type: "visible",
      target: { descriptor: { strategies: [{ kind: "css", value: "#late" }], framePath: [] } }
    }, new Map());
    const done = await h.cdp.send("Runtime.evaluate", {
      expression: `document.getElementById("list").textContent`, returnByValue: true
    });
    expect((done.result as { value: string }).value).toBe("定时器结果");
  });

  it("超时上限生效：页面持续变更时不会永远挂着", async () => {
    const h = await open("form.html");
    await h.cdp.send("Runtime.evaluate", {
      expression: `window.__spin = setInterval(function () {
        document.body.appendChild(document.createElement("span"));
      }, 30)`
    });
    const t0 = Date.now();
    await waitStable(h, tracker, { timeoutMs: 1200 });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(1100);
    expect(elapsed).toBeLessThan(2500);
    await h.cdp.send("Runtime.evaluate", { expression: `clearInterval(window.__spin)` });
  });
});

describe("waitFor", () => {
  it("visible：等到弹窗出现", async () => {
    const h = await open("modal-iframe.html");
    await h.cdp.send("Runtime.evaluate", {
      expression: `setTimeout(function () { document.getElementById("open").click(); }, 400)`
    });
    await waitFor(h, tracker, {
      type: "visible",
      target: { descriptor: { strategies: [{ kind: "css", value: "#cust" }], framePath: [] } }
    }, new Map());
    const { result } = await h.cdp.send("Runtime.evaluate", {
      expression: `!document.getElementById("modal").hidden`,
      returnByValue: true
    });
    expect((result as { value: boolean }).value).toBe(true);
  });

  it("url-contains：命中当前 url 时立即返回", async () => {
    const h = await open("form.html");
    await waitFor(h, tracker, { type: "url-contains", value: "form.html" }, new Map());
  });

  it("条件永不满足时抛超时错误", async () => {
    const h = await open("form.html");
    await expect(
      waitFor(h, tracker, { type: "url-contains", value: "永不出现" }, new Map(), 800)
    ).rejects.toThrow(/超时/);
  });
});
