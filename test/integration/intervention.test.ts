import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { InterventionMonitor } from "../../src/watch/intervention.js";

let session: BrowserSession;
let handle: PageHandle;
let monitor: InterventionMonitor;
const fx = { url: "" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  fx.url = inject("fixtureURL");
  session = await BrowserSession.connect(inject("browserURL"));
  handle = await session.getPage();
  monitor = InterventionMonitor.for(handle);
});
afterAll(async () => {
  await monitor.disarm();
  await session?.close();
});

async function open(path: string): Promise<void> {
  await handle.page.goto(`${fx.url}${path}`, { waitUntil: "load" });
}

/** 模拟用户点击：直接走 CDP，不经 sendInput，不登记 agent 时间窗 */
async function rawClick(x: number, y: number): Promise<void> {
  for (const type of ["mousePressed", "mouseReleased"] as const) {
    await handle.cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  }
}

describe("InterventionMonitor", () => {
  it("armed 时未登记的点击被识别为用户介入，取出即清空", async () => {
    await open("/watch.html");
    await monitor.arm();
    expect(monitor.installError).toBeUndefined();
    await rawClick(200, 300);
    await sleep(150);
    expect(monitor.takeUserInput()).toEqual({ type: "pointerdown", x: 200, y: 300 });
    expect(monitor.takeUserInput()).toBeUndefined();
  });

  it("登记过时间窗的 agent 点击不误报", async () => {
    await monitor.arm();
    for (const type of ["mousePressed", "mouseReleased"] as const) {
      const w = monitor.beginAgentInput("mouse", { x: 200, y: 300 });
      await handle.cdp.send("Input.dispatchMouseEvent", { type, x: 200, y: 300, button: "left", clickCount: 1 });
      monitor.endAgentInput(w);
    }
    await sleep(150);
    expect(monitor.takeUserInput()).toBeUndefined();
  });

  it("用户按键被识别，且上报载荷不含按键值", async () => {
    await monitor.arm();
    const payloads: string[] = [];
    const spy = (e: { name: string; payload: string }) => {
      if (e.name === "__cuqUserInput") payloads.push(e.payload);
    };
    handle.cdp.on("Runtime.bindingCalled", spy);
    try {
      await handle.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", text: "a" });
      await handle.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA" });
      await sleep(150);
    } finally {
      handle.cdp.off("Runtime.bindingCalled", spy);
    }
    expect(monitor.takeUserInput()?.type).toBe("keydown");
    expect(payloads.length).toBeGreaterThan(0);
    for (const p of payloads) expect(Object.keys(JSON.parse(p)).sort()).toEqual(["top", "type", "x", "y"]);
  });

  it("用户滚轮只计数、不算介入", async () => {
    await monitor.arm();
    await handle.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 50, y: 50, deltaX: 0, deltaY: 100 });
    await sleep(150);
    expect(monitor.takeScrollCount()).toBe(1);
    expect(monitor.takeUserInput()).toBeUndefined();
  });

  it("disarm 后的操作一律忽略", async () => {
    await monitor.arm();
    await monitor.disarm();
    await rawClick(200, 300);
    await sleep(150);
    expect(monitor.takeUserInput()).toBeUndefined();
  });

  it("执行期间跳转到新文档后仍能检测（新文档脚本）", async () => {
    await monitor.arm();
    await open("/watch.html");
    await rawClick(200, 300);
    await sleep(150);
    expect(monitor.takeUserInput()?.type).toBe("pointerdown");
    await monitor.disarm();
  });

  it("同源 iframe 内的用户点击也能检测", async () => {
    await open("/iframe-wall.html");
    await sleep(300); // 等 iframe 内文档就绪
    await monitor.arm();
    const { root } = (await handle.cdp.send("DOM.getDocument", { depth: 0 })) as { root: { nodeId: number } };
    const { nodeId } = (await handle.cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#wall" })) as {
      nodeId: number;
    };
    const { model } = (await handle.cdp.send("DOM.getBoxModel", { nodeId })) as { model: { content: number[] } };
    const [x1, y1, , , x3, y3] = model.content;
    await rawClick((x1 + x3) / 2, (y1 + y3) / 2);
    await sleep(150);
    expect(monitor.takeUserInput()?.type).toBe("pointerdown");
    await monitor.disarm();
  });
});
