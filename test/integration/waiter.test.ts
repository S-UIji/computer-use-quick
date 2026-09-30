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

  it("信标/图片类请求不计入在途信号，不再拖住隐式等待", async () => {
    const h = await open("form.html");
    await h.cdp.send("Runtime.evaluate", {
      expression: `window.__beacon = setInterval(function () {
        (new Image()).src = "/beacon?" + Math.random();
      }, 50)`
    });
    const t0 = Date.now();
    const timedOut = await waitStable(h, tracker, { timeoutMs: 1500 });
    const elapsed = Date.now() - t0;
    expect(timedOut).toBe(false);
    expect(elapsed).toBeLessThan(1500);
    await h.cdp.send("Runtime.evaluate", { expression: `clearInterval(window.__beacon)` });
  });

  it("持续 XHR 轮询仍计入在途信号：打满超时并返回 timedOut=true", async () => {
    const h = await open("form.html");
    await h.cdp.send("Runtime.evaluate", {
      expression: `window.__poll = setInterval(function () {
        fetch("/api/orders").catch(function () {});
      }, 100)`
    });
    const t0 = Date.now();
    const timedOut = await waitStable(h, tracker, { timeoutMs: 1200 });
    const elapsed = Date.now() - t0;
    expect(timedOut).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(1100);
    expect(elapsed).toBeLessThan(2500);
    await h.cdp.send("Runtime.evaluate", { expression: `clearInterval(window.__poll)` });
  });

  it("主 frame 导航后，上一页面遗留的在途请求不再阻塞隐式等待", async () => {
    const h = await open("form.html");
    await h.cdp.send("Runtime.evaluate", {
      expression: `fetch("/api/hang").catch(function () {})`
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(tracker.inFlight()).toBe(1);

    await h.page.goto(`${fx.url}/async-list.html`, { waitUntil: "load" });
    const t0 = Date.now();
    const timedOut = await waitStable(h, tracker, { timeoutMs: 1500 });
    expect(timedOut).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1500);
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

  it("visible：歧义超时时报告匹配数量和 ambiguous", async () => {
    const h = await open("table-dup.html");
    await expect(
      waitFor(h, tracker, {
        type: "visible",
        target: {
          descriptor: {
            strategies: [{ kind: "role-name", role: "button", name: "删除" }],
            distinguishers: ["ORD20260911", "ORD20260912"],
            framePath: []
          }
        }
      }, new Map(), 500)
    ).rejects.toMatchObject({
      kind: "ambiguous",
      matchCount: 3,
      candidates: ["ORD20260911", "ORD20260912"],
      message: expect.stringMatching(/等待条件 visible 超时.*匹配到 3 个/)
    });
  });

  it("hidden：遇到多个匹配不会误判为已隐藏", async () => {
    const h = await open("hidden-dup.html");
    await expect(
      waitFor(h, tracker, {
        type: "hidden",
        target: {
          descriptor: {
            strategies: [{ kind: "css", value: "button" }],
            framePath: []
          }
        }
      }, new Map(), 500)
    ).rejects.toMatchObject({
      kind: "ambiguous",
      matchCount: 2,
      message: expect.stringMatching(/等待条件 hidden 超时.*匹配到 2 个/)
    });
  });

  it("visible：唯一目标不可见时超时说明最后状态", async () => {
    const h = await open("hidden-dup.html");
    await expect(
      waitFor(h, tracker, {
        type: "visible",
        target: {
          descriptor: {
            strategies: [{ kind: "css", value: "#ghost" }],
            framePath: []
          }
        }
      }, new Map(), 500)
    ).rejects.toThrow(/找到目标但不可见/);
  });
  it.each(["#ghost", "#missing"])("hidden：唯一隐藏或不存在的 %s 满足等待", async (selector) => {
    const h = await open("hidden-dup.html");
    await waitFor(h, tracker, {
      type: "hidden",
      target: { descriptor: { strategies: [{ kind: "css", value: selector }], framePath: [] } }
    }, new Map(), 500);
  });

  it("visible：未找到目标时超时保留原因", async () => {
    const h = await open("form.html");
    await expect(waitFor(h, tracker, {
      type: "visible",
      target: { descriptor: { strategies: [{ kind: "css", value: "#missing" }], framePath: [] } }
    }, new Map(), 200)).rejects.toThrow(/等待条件 visible 超时.*未找到目标/);
  });

  it("hidden：唯一可见目标超时说明仍可见", async () => {
    const h = await open("hidden-dup.html");
    await expect(waitFor(h, tracker, {
      type: "hidden",
      target: { descriptor: { strategies: [{ kind: "css", value: "#real" }], framePath: [] } }
    }, new Map(), 200)).rejects.toThrow(/等待条件 hidden 超时.*找到目标且可见/);
  });

  it("visible：暂时歧义后唯一可见时继续等待并成功", async () => {
    const h = await open("hidden-dup.html");
    const waiting = waitFor(h, tracker, {
      type: "visible",
      target: { descriptor: { strategies: [{ kind: "css", value: "button" }], framePath: [] } }
    }, new Map(), 2000);
    await h.cdp.send("Runtime.evaluate", {
      expression: 'setTimeout(() => document.getElementById("ghost").remove(), 250)'
    });
    await waiting;
  });

  it("visible：歧义消失后按最后不可见状态超时，不残留歧义类型", async () => {
    const h = await open("hidden-dup.html");
    const result = waitFor(h, tracker, {
      type: "visible",
      target: { descriptor: { strategies: [{ kind: "css", value: "button" }], framePath: [] } }
    }, new Map(), 800).then(() => undefined, (error: unknown) => error);
    await h.cdp.send("Runtime.evaluate", {
      expression: 'setTimeout(() => document.getElementById("real").remove(), 250)'
    });
    const error = await result;
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toHaveProperty("kind");
    expect((error as Error).message).toMatch(/找到目标但不可见/);
  });

  it("response：目标接口返回即通过（不等网络静默）", async () => {
    const h = await open("async-list.html");
    const p = waitFor(h, tracker, { type: "response", urlPattern: "api/orders" }, new Map(), 5000);
    await new Promise((r) => setTimeout(r, 100)); // 先挂上等待，再触发请求
    await h.cdp.send("Runtime.evaluate", { expression: `document.getElementById("load").click()` });
    const t0 = Date.now();
    await p;
    const elapsed = Date.now() - t0;
    // 接口 800ms 后返回：精确等待应在 ~800ms 处通过，而不是等额外的静默期
    expect(elapsed).toBeGreaterThanOrEqual(600);
    expect(elapsed).toBeLessThan(3000);
  });

  it("response：网络安静但目标接口从未调用 → 超时（不被静默近似误判）", async () => {
    const h = await open("form.html"); // 静止页面，无任何请求
    await expect(
      waitFor(h, tracker, { type: "response", urlPattern: "api/orders" }, new Map(), 800)
    ).rejects.toThrow(/超时/);
  });

  it("response：等待开始前已完成的历史响应不计入", async () => {
    const h = await open("async-list.html");
    await h.cdp.send("Runtime.evaluate", { expression: `document.getElementById("load").click()` });
    await new Promise((r) => setTimeout(r, 1500)); // 请求早已完成，页面已安静
    await expect(
      waitFor(h, tracker, { type: "response", urlPattern: "api/orders" }, new Map(), 600)
    ).rejects.toThrow(/超时/);
  });
});
