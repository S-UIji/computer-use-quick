import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { showOverlay, removeOverlay, withOverlayHidden, withOverlayDetailsSuspended } from "../../src/watch/overlay.js";
import { takeSnapshot } from "../../src/perception/snapshot.js";
import { runWithDeadline } from "../../src/executor/deadline.js";
import { NetworkTracker } from "../../src/waiter/stability.js";
import { runAction } from "../../src/executor/actions.js";
import { InterventionMonitor } from "../../src/watch/intervention.js";
let session: BrowserSession, handle: PageHandle;
beforeAll(async () => { session = await BrowserSession.connect(inject("browserURL")); handle = await session.newPage(); });
beforeEach(async () => {
  await handle.page.setViewport({ width: 320, height: 240 });
  await handle.page.setContent('<!doctype html><style>body{margin:0;height:1600px}h1{margin:0;font-size:24px}button{position:fixed;inset:0;opacity:0}</style><h1>业务页面标题</h1><button onclick="window.hit=(event.isTrusted?\'trusted\':\'synthetic\')">底层操作</button>');
  await handle.page.bringToFront();
});
afterEach(async () => { await removeOverlay(handle); });
afterAll(async () => { await session?.close(); });
const state = { kind: "active" as const, label: "长并发用例标签", step: 2, total: 5, action: "navigate", description: "导航到 " + "path/".repeat(120) + "末尾" };
async function show() { await showOverlay(handle, state); }
async function hover() {
  const point = await handle.page.evaluate(() => {
    const o = (window as any).__cuqOverlay, r = o.badge.getBoundingClientRect();
    return { x: r.right - 20, y: r.top + r.height / 2 };
  });
  await handle.page.mouse.move(point.x, point.y);
  return point;
}
describe("窄窗口执行角标和被动详情", () => {
  it.each([240, 320, 620, 1280])("%ipx视口内角标保留步数且不覆盖顶部标题", async width => {
    await handle.page.setViewport({ width, height: 240 }); await show();
    const layout = await handle.page.evaluate(() => {
      const badge = (window as any).__cuqOverlay.badge as HTMLElement;
      const r = badge.getBoundingClientRect(), title = document.querySelector("h1")!.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, titleBottom: title.bottom,
        width: innerWidth, height: innerHeight, overflow: badge.scrollWidth > badge.clientWidth, text: badge.textContent };
    });
    expect(layout.top).toBeGreaterThan(layout.titleBottom);
    expect(layout.left).toBeGreaterThanOrEqual(0); expect(layout.right).toBeLessThanOrEqual(width);
    expect(layout.bottom).toBeLessThanOrEqual(240); expect(layout.overflow).toBe(false);
    expect(layout.text).toContain("2/5");
    expect(layout.text).not.toContain("path/");
  });
  it("悬停显示完整内容、换行且点击仍trusted穿透，不打断执行", async () => {
    const before = (await takeSnapshot(handle)).text;
    await show();
    expect(await handle.page.evaluate(() => !!(window as any).__cuqOverlay.details)).toBe(true);
    const monitor = InterventionMonitor.for(handle); await monitor.arm();
    try {
      const point = await hover();
      const info = await handle.page.evaluate(() => {
        const d = (window as any).__cuqOverlay.details as HTMLElement;
        const r = d.getBoundingClientRect();
        return { hidden: d.hidden, text: d.textContent, whiteSpace: getComputedStyle(d).whiteSpace, left:r.left,right:r.right,top:r.top,bottom:r.bottom };
      });
      expect(info.hidden).toBe(false); expect(info.text).toContain(state.description); expect(info.text).toContain(state.label);
      expect(info.whiteSpace).not.toBe("nowrap"); expect(info.left).toBeGreaterThanOrEqual(0);
      expect(info.right).toBeLessThanOrEqual(320); expect(info.top).toBeGreaterThanOrEqual(0); expect(info.bottom).toBeLessThanOrEqual(240);
      expect(monitor.takeUserInput()).toBeUndefined();
      expect((await takeSnapshot(handle)).text).toBe(before);
      await handle.page.mouse.click(point.x, point.y);
      expect(await handle.page.evaluate(() => (window as any).hit)).toBe("trusted");
    } finally { await monitor.disarm(); }
  });
  it("超高详情滚轮仅滚动详情，移除后不再截获页面滚轮", async () => {
    await show();
    expect(await handle.page.evaluate(() => !!(window as any).__cuqOverlay.details)).toBe(true);
    await hover();
    const point = await handle.page.evaluate(() => {
      const d = (window as any).__cuqOverlay.details as HTMLElement, r = d.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, scrollable: d.scrollHeight > d.clientHeight };
    });
    expect(point.scrollable).toBe(true);
    await handle.page.mouse.move(point.x, point.y); await handle.page.mouse.wheel({ deltaY: 200 });
    await handle.page.waitForFunction(() => (window as any).__cuqOverlay.details.scrollTop > 0);
    expect(await handle.page.evaluate(() => scrollY)).toBe(0);
    await removeOverlay(handle);
    await handle.page.mouse.wheel({ deltaY: 200 });
    await handle.page.waitForFunction(() => scrollY > 0);
  });
  it("自动真实滚轮不被用户展开的详情截获", async () => {
    await show(); await hover(); await handle.page.mouse.move(10, 10);
    const tracker = await NetworkTracker.attach(handle);
    await runAction({ handle, tracker, refs:new Map(), vars:{}, stability:{timeoutMs:500} },
      { action:"scroll", direction:"down", amount:200 });
      await handle.page.waitForFunction(() => scrollY > 0, { timeout:2000 });
    expect(await handle.page.evaluate(() => (window as any).__cuqOverlay.details.scrollTop)).toBe(0);
  });
  it("同源iframe内悬停和滚轮可读取详情，不滚动业务frame", async () => {
    await handle.page.setContent('<iframe style="position:fixed;inset:0;width:100%;height:100%;border:0" srcdoc="<body style=height:1600px>frame</body>"></iframe>');
    await handle.page.waitForFunction(() => !!document.querySelector("iframe")?.contentDocument?.body);
    await show(); await hover();
    expect(await handle.page.evaluate(() => (window as any).__cuqOverlay.details.hidden)).toBe(false);
    const point = await handle.page.evaluate(() => {
      const r=(window as any).__cuqOverlay.details.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};
    });
    await handle.page.mouse.move(point.x,point.y);await handle.page.mouse.wheel({deltaY:200});
    await handle.page.waitForFunction(()=>(window as any).__cuqOverlay.details.scrollTop>0,{timeout:2000});
    expect(await handle.page.evaluate(() => document.querySelector("iframe")!.contentWindow!.scrollY)).toBe(0);
  });
  it("临时暂停详情的动作失败后仍能重新查看", async () => {
    await show(); await hover();
    await expect(withOverlayDetailsSuspended(handle, async () => { throw new Error("input failed"); })).rejects.toThrow("input failed");
    await handle.page.mouse.move(0,0);await hover();
    expect(await handle.page.evaluate(() => (window as any).__cuqOverlay.details.hidden)).toBe(false);
    expect(await handle.page.evaluate(() => (window as any).__cuqOverlay.wrap.hasAttribute("data-agent-input"))).toBe(false);
  });
  it("新建和导航的同源iframe可查看，移除标注后滚轮交还frame", async () => {
    await show();
    await handle.page.evaluate(() => {
      const frame=document.createElement("iframe"); frame.style.cssText="position:fixed;inset:0;width:100%;height:100%;border:0";
      frame.srcdoc="<body style=height:1600px>first</body>";document.body.append(frame);
    });
    await handle.page.waitForFunction(()=>document.querySelector("iframe")?.contentDocument?.body?.textContent==="first");
    await hover();expect(await handle.page.evaluate(()=>(window as any).__cuqOverlay.details.hidden)).toBe(false);
    await handle.page.evaluate(()=>{document.querySelector("iframe")!.srcdoc="<body style=height:1600px>second</body>";});
    await handle.page.waitForFunction(()=>document.querySelector("iframe")?.contentDocument?.body?.textContent==="second");
    await handle.page.mouse.move(0,0);await hover();
    expect(await handle.page.evaluate(()=>(window as any).__cuqOverlay.details.hidden)).toBe(false);
    const point=await handle.page.evaluate(()=>{const r=(window as any).__cuqOverlay.details.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};});
    await handle.page.mouse.move(point.x,point.y);await removeOverlay(handle);await handle.page.mouse.wheel({deltaY:200});
    await handle.page.waitForFunction(()=>document.querySelector("iframe")!.contentWindow!.scrollY>0,{timeout:2000});
  });
  it.each(["wheel", "pause"])("真实步骤截止后释放详情锁，包括%s迟到", async phase => {
    const raw = await handle.page.createCDPSession(), send = raw.send.bind(raw);
    const delayed = { ...handle, cdp: {
      send: async (method:string, params:any) => {
        if (phase==="pause" && method==="Runtime.evaluate" && params?.expression.includes('o.wrap.setAttribute("data-agent-input"')) {
          await new Promise(resolve=>setTimeout(resolve,250));
        }
        return (send as any)(method,params);
      },
      on:raw.on.bind(raw), off:raw.off.bind(raw)
    } } as unknown as PageHandle;
    try {
      await showOverlay(delayed,state);
      await expect(runWithDeadline(delayed,100,()=>withOverlayDetailsSuspended(delayed,async()=>{
        if(phase==="wheel") await new Promise(resolve=>setTimeout(resolve,250));
      }))).rejects.toThrow(/截止|timeout|超时/);
      await new Promise(resolve=>setTimeout(resolve,400));
      await handle.page.mouse.move(0,0); await hover();
      expect(await handle.page.evaluate(()=>(window as any).__cuqOverlay.wrap.hasAttribute("data-agent-input"))).toBe(false);
      expect(await handle.page.evaluate(()=>(window as any).__cuqOverlay.details.hidden)).toBe(false);
    } finally { await removeOverlay(delayed); await raw.detach(); }
  });
  it("移出和待命关闭详情，截图隐藏包括详情且恢复后不主动展开", async () => {
    await show();
    expect(await handle.page.evaluate(() => !!(window as any).__cuqOverlay.details)).toBe(true);
    await hover();
    await withOverlayHidden(handle, async () => {
      expect(await handle.page.evaluate(() => getComputedStyle((window as any).__cuqOverlay.details).visibility)).toBe("hidden");
    });
    await handle.page.mouse.move(0, 0);
    expect(await handle.page.evaluate(() => (window as any).__cuqOverlay.details.hidden)).toBe(true);
    await hover();
    await showOverlay(handle, { kind: "idle" });
    expect(await handle.page.evaluate(() => (window as any).__cuqOverlay.details.hidden)).toBe(true);
  });
  it("标签切到后台关闭详情并保持被操作页不抢焦点", async () => {
    await show();
    expect(await handle.page.evaluate(() => !!(window as any).__cuqOverlay.details)).toBe(true);
    await hover();
    const other = await session.newPage();
    try {
      await other.page.bringToFront(); await handle.page.waitForFunction(() => document.hidden);
      expect(await handle.page.evaluate(() => (window as any).__cuqOverlay.details.hidden)).toBe(true);
      await show();
      expect(await handle.page.evaluate(() => document.hidden)).toBe(true);
      expect(await other.page.evaluate(() => document.visibilityState)).toBe("visible");
    } finally { await other.page.close(); }
  });
});
