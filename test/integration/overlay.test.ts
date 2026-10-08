import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { showOverlay, removeOverlay, renderBadgeText, type OverlayState } from "../../src/watch/overlay.js";

let session: BrowserSession;
let handle: PageHandle;
const fx = { url: "" };

beforeAll(async () => {
  fx.url = inject("fixtureURL");
  session = await BrowserSession.connect(inject("browserURL"));
  handle = await session.getPage();
});
afterAll(async () => { await session?.close(); });

async function goto(path: string): Promise<void> {
  await handle.page.goto(`${fx.url}${path}`, { waitUntil: "load" });
}

async function evalValue<T>(expression: string): Promise<T> {
  const { result } = (await handle.cdp.send("Runtime.evaluate", { expression, returnByValue: true })) as {
    result: { value: T };
  };
  return result.value;
}

const active: OverlayState = { kind: "active", label: "探索", step: 2, total: 5, action: "click" };
const hostCount = () => evalValue<number>(`document.querySelectorAll("cuq-overlay").length`);

describe("页面标注", () => {
  it("挂在 <html> 下、aria-hidden、封闭 shadow root，角标文案与状态正确", async () => {
    await goto("/watch.html");
    await showOverlay(handle, active);
    const info = await evalValue<{ parent: string; aria: string | null; open: boolean; state: string; text: string }>(`(() => {
      const h = document.querySelector("cuq-overlay");
      return {
        parent: h.parentElement.tagName,
        aria: h.getAttribute("aria-hidden"),
        open: h.shadowRoot !== null,
        state: window.__cuqOverlay.wrap.getAttribute("data-state"),
        text: window.__cuqOverlay.badge.textContent
      };
    })()`);
    expect(info).toEqual({ parent: "HTML", aria: "true", open: false, state: "active", text: renderBadgeText(active) });
  });

  it("重复调用幂等：只有一个宿主，状态随最后一次调用", async () => {
    await showOverlay(handle, active);
    await showOverlay(handle, { kind: "idle" });
    expect(await hostCount()).toBe(1);
    expect(await evalValue<string>(`window.__cuqOverlay.wrap.getAttribute("data-state")`)).toBe("idle");
    await showOverlay(handle, { kind: "interrupted", stopStep: 3 });
    expect(await evalValue<string>(`window.__cuqOverlay.badge.textContent`))
      .toBe(renderBadgeText({ kind: "interrupted", stopStep: 3 }));
  });

  it("跳转后自动恢复最近状态，无需再次调用补挂", async () => {
    await showOverlay(handle, active);
    await goto("/watch.html");
    await handle.page.waitForFunction(() => (window as any).__cuqOverlay?.wrap.dataset.state === "active");
    expect(await hostCount()).toBe(1);
    expect(await evalValue<string>(`window.__cuqOverlay.badge.textContent`)).toBe(renderBadgeText(active));
  });

  it("removeOverlay 移除宿主", async () => {
    await showOverlay(handle, active);
    await removeOverlay(handle);
    expect(await hostCount()).toBe(0);
  });

  it("严格 CSP 页面上样式照常生效", async () => {
    await goto("/csp.html");
    // 前提：页面自己的内联 <style> 确实被 CSP 拦了
    expect(await evalValue<string>(`getComputedStyle(document.querySelector("h1")).color`)).not.toBe("rgb(255, 0, 0)");
    await showOverlay(handle, active);
    expect(await evalValue<string>(`getComputedStyle(window.__cuqOverlay.badge).position`)).toBe("absolute");
  });

  it("页面已关闭时不抛错（尽力而为）", async () => {
    const h = await session.newPage();
    await h.page.close();
    await expect(showOverlay(h, active)).resolves.toBeUndefined();
  });
});
