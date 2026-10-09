import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { removeOverlay, showOverlay, withOverlayHidden, type OverlayState } from "../../src/watch/overlay.js";

let session: BrowserSession;
let handle: PageHandle;
let fixtureURL: string;

const active = (step = 1): OverlayState => ({ kind: "active", label: "探索", step, total: 3, action: "click" });

beforeAll(async () => {
  fixtureURL = inject("fixtureURL");
  session = await BrowserSession.connect(inject("browserURL"));
  handle = await session.getPage();
});

beforeEach(async () => {
  await removeOverlay(handle);
  await handle.page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
  await handle.page.goto(`${fixtureURL}/watch.html`, { waitUntil: "load" });
  await handle.page.bringToFront();
});

afterEach(async () => {
  await removeOverlay(handle);
  await handle.page.emulateMediaFeatures([]);
});

afterAll(async () => { await session?.close(); });

describe("观察模式的小狐狸", () => {
  it("严格 CSP 下显示固定尺寸的内嵌狐狸，更新状态不请求图片", async () => {
    await handle.page.goto(`${fixtureURL}/csp.html`, { waitUntil: "load" });
    const requests: string[] = [];
    const onRequest = (request: { url(): string }) => { requests.push(request.url()); };
    handle.page.on("request", onRequest);
    try {
      await showOverlay(handle, active());
      const view = await handle.page.evaluate(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const badge = (window as any).__cuqOverlay.badge as HTMLElement;
        const fox = badge.querySelector<SVGSVGElement>("svg.fox");
        return {
          fox: !!fox,
          width: fox ? getComputedStyle(fox).width : null,
          height: fox ? getComputedStyle(fox).height : null,
          drawn: fox ? fox.getBBox().width > 0 && fox.getBBox().height > 0 : false,
          label: badge.querySelector(".badge-text")?.textContent ?? "",
          externalImages: badge.querySelectorAll("img, image, use[href]:not([href^='#'])").length
        };
      });
      expect(view.fox).toBe(true);
      expect(view.width).toBe("24px");
      expect(view.height).toBe("24px");
      expect(view.drawn).toBe(true);
      expect(view.label).toContain("正在操作 · 探索 · 第 1/3 步");
      expect(view.label).not.toContain("🤖");
      expect(view.externalImages).toBe(0);
      expect(requests).toEqual([]);
    } finally {
      handle.page.off("request", onRequest);
    }
  });

  it("只更新步骤文案时保留狐狸和正在播放的动画，不从头开始", async () => {
    await showOverlay(handle, active());
    const hasAnimation = await handle.page.evaluate(async () => {
      const fox = (window as any).__cuqOverlay.badge.querySelector(".fox") as SVGSVGElement | null;
      const animation = fox?.getAnimations({ subtree: true })[0];
      if (!animation) return false;
      await animation.ready;
      (window as any).__foxBeforeUpdate = { fox, animation, startTime: animation.startTime, currentTime: animation.currentTime };
      return true;
    });
    expect(hasAnimation).toBe(true);

    await showOverlay(handle, active(2));
    const continuity = await handle.page.evaluate(() => {
      const before = (window as any).__foxBeforeUpdate;
      const badge = (window as any).__cuqOverlay.badge as HTMLElement;
      const fox = badge.querySelector(".fox");
      const animations = fox?.getAnimations({ subtree: true }) ?? [];
      return {
        sameFox: fox === before.fox,
        sameAnimation: animations.includes(before.animation),
        sameStart: before.animation.startTime === before.startTime,
        progressed: Number(before.animation.currentTime) >= Number(before.currentTime),
        label: badge.querySelector(".badge-text")?.textContent ?? ""
      };
    });
    expect(continuity).toMatchObject({ sameFox: true, sameAnimation: true, sameStart: true, progressed: true });
    expect(continuity.label).toContain("第 2/3 步");
  });

  it.each<OverlayState>([active(), { kind: "idle" }])("截图临时隐藏 $kind 标注时保留狐狸和动画进度", async (state) => {
    await showOverlay(handle, state);
    const animationCount = await handle.page.evaluate(async () => {
      const fox = (window as any).__cuqOverlay.badge.querySelector(".fox") as SVGSVGElement;
      const animations = fox.getAnimations({ subtree: true });
      await Promise.all(animations.map((animation) => animation.ready));
      for (const animation of animations) animation.currentTime = 500;
      (window as any).__foxBeforeCapture = { fox, animations };
      return animations.length;
    });
    expect(animationCount).toBeGreaterThan(0);

    await withOverlayHidden(handle, async () => {
      const hidden = await handle.page.evaluate(() => {
        const wrap = (window as any).__cuqOverlay.wrap as HTMLElement;
        // Flush style/layout while hidden, as screenshot capture does. Without
        // this, display:none can be restored before CSS animations are canceled.
        const style = getComputedStyle(wrap);
        wrap.getBoundingClientRect();
        wrap.getAnimations({ subtree: true });
        return style.display === "none" || style.visibility === "hidden";
      });
      expect(hidden).toBe(true);
    });

    const restored = await handle.page.evaluate(async () => {
      const before = (window as any).__foxBeforeCapture as { fox: SVGSVGElement; animations: Animation[] };
      const wrap = (window as any).__cuqOverlay.wrap as HTMLElement;
      const fox = wrap.querySelector(".fox") as SVGSVGElement;
      const animations = fox.getAnimations({ subtree: true });
      await Promise.all(animations.map((animation) => animation.ready));
      const style = getComputedStyle(wrap);
      return {
        visible: style.display !== "none" && style.visibility !== "hidden",
        sameFox: fox === before.fox,
        sameAnimations: animations.length === before.animations.length && before.animations.every((animation) => animations.includes(animation)),
        progressPreserved: animations.every((animation) => Number(animation.currentTime) >= 500),
        resumed: animations.every((animation) => animation.playState === "running")
      };
    });
    expect(restored).toEqual({ visible: true, sameFox: true, sameAnimations: true, progressPreserved: true, resumed: true });
  });

  it("截图恢复已停止的狐狸时不重新播放介入警觉动画", async () => {
    await showOverlay(handle, { kind: "interrupted", stopStep: 2 });
    const settled = await handle.page.evaluate(async () => {
      const fox = (window as any).__cuqOverlay.badge.querySelector(".fox") as SVGSVGElement;
      const animations = fox.getAnimations({ subtree: true });
      for (const animation of animations) animation.finish();
      await Promise.all(animations.map((animation) => animation.finished));
      (window as any).__settledFox = fox;
      return { count: animations.length, moving: fox.getAnimations({ subtree: true }).some((animation) => animation.playState === "running" || animation.pending) };
    });
    expect(settled.count).toBeGreaterThan(0);
    expect(settled.moving).toBe(false);

    await withOverlayHidden(handle, async () => {
      const hidden = await handle.page.evaluate(() => {
        const wrap = (window as any).__cuqOverlay.wrap as HTMLElement;
        const style = getComputedStyle(wrap);
        wrap.getBoundingClientRect();
        wrap.getAnimations({ subtree: true });
        return style.display === "none" || style.visibility === "hidden";
      });
      expect(hidden).toBe(true);
    });

    const restored = await handle.page.evaluate(() => {
      const wrap = (window as any).__cuqOverlay.wrap as HTMLElement;
      const fox = wrap.querySelector(".fox") as SVGSVGElement;
      return {
        sameFox: fox === (window as any).__settledFox,
        moving: fox.getAnimations({ subtree: true }).some((animation) => animation.playState === "running" || animation.pending)
      };
    });
    expect(restored).toEqual({ sameFox: true, moving: false });
  });

  it("待命只保留间歇眨眼，介入提醒只播放一次后静止", async () => {
    await showOverlay(handle, { kind: "idle" });
    const idle = await handle.page.evaluate(() => {
      const fox = (window as any).__cuqOverlay.badge.querySelector(".fox") as SVGSVGElement | null;
      const blink = fox?.querySelector(".fox-eyes-open")?.getAnimations() ?? [];
      return {
        bodyAnimationCount: fox?.getAnimations().length ?? -1,
        blink: blink.map((animation) => ({
          repeating: animation.effect?.getTiming().iterations === Infinity,
          duration: Number(animation.effect?.getTiming().duration)
        }))
      };
    });
    expect(idle.bodyAnimationCount).toBe(0);
    expect(idle.blink.length).toBeGreaterThan(0);
    expect(idle.blink.every((animation) => animation.repeating && animation.duration >= 3000)).toBe(true);

    await showOverlay(handle, { kind: "interrupted", stopStep: 2 });
    const interrupted = await handle.page.evaluate(async () => {
      const badge = (window as any).__cuqOverlay.badge as HTMLElement;
      const fox = badge.querySelector(".fox") as SVGSVGElement;
      const animations = fox.getAnimations({ subtree: true });
      const iterations = animations.map((animation) => animation.effect?.getTiming().iterations);
      for (const animation of animations) animation.finish();
      await Promise.all(animations.map((animation) => animation.finished));
      const alert = fox.querySelector(".fox-eyes-alert") as SVGElement;
      return {
        iterations,
        stillPlaying: fox.getAnimations({ subtree: true }).some((animation) => animation.playState === "running" || animation.pending),
        alertVisible: !!alert && getComputedStyle(alert).display !== "none" && Number(getComputedStyle(alert).opacity) > 0,
        label: badge.querySelector(".badge-text")?.textContent ?? ""
      };
    });
    expect(interrupted.iterations.length).toBeGreaterThan(0);
    expect(interrupted.iterations.every((iterations) => iterations === 1)).toBe(true);
    expect(interrupted.stillPlaying).toBe(false);
    expect(interrupted.alertVisible).toBe(true);
    expect(interrupted.label).toContain("执行已停止");
  });

  it("系统减少动态效果时狐狸和整页边框均保持静止", async () => {
    await handle.page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    for (const state of [active(), { kind: "idle" }, { kind: "interrupted", stopStep: 2 }] as OverlayState[]) {
      await showOverlay(handle, state);
      const motion = await handle.page.evaluate(() => {
        const wrap = (window as any).__cuqOverlay.wrap as HTMLElement;
        return {
          fox: !!wrap.querySelector("svg.fox"),
          playing: wrap.getAnimations({ subtree: true }).some((animation) => animation.playState === "running" || animation.pending)
        };
      });
      expect(motion).toEqual({ fox: true, playing: false });
    }
  });

  it("切换到其他标签页后暂停动画，回到页面后恢复", async () => {
    await showOverlay(handle, active());
    const other = await session.newPage();
    try {
      await other.page.bringToFront();
      await handle.page.waitForFunction(() => document.hidden);
      const hidden = await handle.page.evaluate(() => {
        const wrap = (window as any).__cuqOverlay.wrap as HTMLElement;
        const animations = wrap.getAnimations({ subtree: true });
        return { count: animations.length, paused: animations.every((animation) => animation.playState === "paused") };
      });
      expect(hidden.count).toBeGreaterThan(0);
      expect(hidden.paused).toBe(true);

      // A progress update while hidden must not wake the animation.
      await showOverlay(handle, active(2));
      expect(await handle.page.evaluate(() => ((window as any).__cuqOverlay.wrap as HTMLElement)
        .getAnimations({ subtree: true }).every((animation) => animation.playState === "paused"))).toBe(true);

      await handle.page.bringToFront();
      await handle.page.waitForFunction(() => !document.hidden);
      const resumed = await handle.page.evaluate(async () => {
        const animations = ((window as any).__cuqOverlay.wrap as HTMLElement).getAnimations({ subtree: true });
        await Promise.all(animations.map((animation) => animation.ready));
        return animations.length > 0 && animations.every((animation) => animation.playState === "running");
      });
      expect(resumed).toBe(true);
    } finally {
      await other.page.close();
      await handle.page.bringToFront();
    }
  });
});
