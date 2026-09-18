import type { PageHandle } from "../session/browser.js";
import type { ResolveResult, Step, TargetRef } from "../types.js";
import { resolveTarget, type ResolveOptions } from "../locator/resolve.js";
import { NetworkTracker, waitStable, type StabilityOptions } from "../waiter/stability.js";
import { waitFor } from "../waiter/explicit.js";

export interface ActionContext {
  handle: PageHandle;
  tracker: NetworkTracker;
  refs: Map<string, number>;
  vars: Record<string, string>;
  /** 最近一次 target 解析的结果，供 batch 记录 strategyIndex 与固化 descriptor */
  lastResolve?: ResolveResult;
  /** 隐式稳定性等待参数，batch 可整体覆盖（默认值见 waitStable） */
  stability?: StabilityOptions;
  /**
   * 元素刚解析出来、动作尚未执行时的回调。batch 用它把 ref 固化成 descriptor，
   * 这个时机是最后的安全窗口——动作可能把页面导航走。
   */
  onResolved?: (backendNodeId: number) => Promise<void>;
}

async function centerOf(
  handle: PageHandle,
  backendNodeId: number
): Promise<{ x: number; y: number }> {
  await handle.cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
  const { model } = (await handle.cdp.send("DOM.getBoxModel", { backendNodeId })) as {
    model: { content: number[] };
  };
  const [x1, y1, , , x3, y3] = model.content;
  return { x: (x1 + x3) / 2, y: (y1 + y3) / 2 };
}

async function nodeIdFor(
  ctx: ActionContext,
  target: TargetRef,
  opts: ResolveOptions = {}
): Promise<number> {
  const r = await resolveTarget(ctx.handle, target, ctx.refs, opts);
  ctx.lastResolve = r;
  await ctx.onResolved?.(r.backendNodeId);
  return r.backendNodeId;
}

/** 交互类动作要求目标可见可点：命中不可见节点时继续试后面的策略，而不是拿协议错误收场 */
const ACTIONABLE: ResolveOptions = { requireActionable: true };

/**
 * 派发输入事件前把被驱动的页面提到前台。
 * 实测：后台标签页里的 Input.dispatchMouseEvent 要等 ~5s 才返回（前台 8-46ms），
 * 点开新标签页、或浏览器里还开着别的标签时，每一步都会被拖满这个延迟；
 * Page.bringToFront 一次就把 5022ms 降到 28ms。
 */
async function bringToFront(handle: PageHandle): Promise<void> {
  await handle.cdp.send("Page.bringToFront").catch(() => {});
}

/**
 * 经 CDP Input 域派发真实鼠标事件（spec §2.1）。这里派发的是浏览器级
 * trusted event，前端 JS 分辨不出来；但不做鼠标轨迹动画和人类化延迟。
 *
 * CDP Input 事件按屏幕坐标派发，但目标元素可能被 CSS 隐藏（opacity:0、
 * 用伪元素/覆盖 div 替代视觉呈现等），导致事件落在覆盖物而非目标元素上。
 * 典型场景：百度搜索按钮 —— 原生 `<input type="submit">` 被 CSS 隐藏，
 * 视觉位置被一个 div 覆盖，CDP click 打到 div 上无法触发表单提交。
 *
 * 修复：派发前做 hit-test（elementFromPoint）。若目标元素不在坐标位置，
 * 在 CDP 鼠标事件链之后补一个 JS dispatchEvent('click') 直达目标元素。
 * CDP 事件保证了 hover/focus/mousedown/mouseup 链是 trusted；JS click
 * 保证 DOM click 事件命中正确的元素。
 */
async function realClick(handle: PageHandle, backendNodeId: number): Promise<void> {
  const { x, y } = await centerOf(handle, backendNodeId);

  // hit-test：检查目标元素是否在点击坐标的可视位置
  const { object: hitObj } = await handle.cdp.send("DOM.resolveNode", { backendNodeId });
  const { result: hitResult } = (await handle.cdp.send("Runtime.callFunctionOn", {
    objectId: hitObj.objectId,
    functionDeclaration: `function(cx, cy) {
      const el = document.elementFromPoint(cx, cy);
      if (!el) return false;
      if (el === this) return true;
      // 检查 this 是否包含 el（el 是 this 的子节点，例如点击在按钮内的文本节点上）
      if (this.contains(el)) return true;
      // 检查 el 是否是 this 的容器（this 被包裹在 el 内）
      if (el.contains(this)) return true;
      return false;
    }`,
    arguments: [{ value: x }, { value: y }],
    returnByValue: true
  })) as { result: { value: boolean } };
  if (hitObj.objectId) {
    await handle.cdp.send("Runtime.releaseObject", { objectId: hitObj.objectId }).catch(() => {});
  }

  const hitTarget = hitResult.value;

  await handle.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await handle.cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", clickCount: 1
  });
  await handle.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", clickCount: 1
  });

  if (!hitTarget) {
    // 目标元素被覆盖/隐藏：CDP 鼠标事件打在了错误元素上。
    // 补一个 JS click 事件直达目标，避免对 checkbox 等控件用 .click()
    // （.click() 会额外生成 mousedown/mouseup，造成双击副作用）。
    const { object: fixObj } = await handle.cdp.send("DOM.resolveNode", { backendNodeId });
    await handle.cdp.send("Runtime.callFunctionOn", {
      objectId: fixObj.objectId,
      functionDeclaration: `function(cx, cy) {
        this.dispatchEvent(new MouseEvent('click', {
          bubbles: true, cancelable: true,
          clientX: cx, clientY: cy, screenX: cx, screenY: cy,
          button: 0, buttons: 0, view: window
        }));
      }`,
      arguments: [{ value: x }, { value: y }],
      returnByValue: true
    });
    if (fixObj.objectId) {
      await handle.cdp.send("Runtime.releaseObject", { objectId: fixObj.objectId }).catch(() => {});
    }
  }
}

async function readProperty(
  handle: PageHandle,
  backendNodeId: number,
  fn: string
): Promise<string> {
  const { object } = (await handle.cdp.send("DOM.resolveNode", { backendNodeId })) as {
    object: { objectId: string };
  };
  const { result } = (await handle.cdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: fn,
    returnByValue: true
  })) as { result: { value: string } };
  await handle.cdp.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
  return result.value;
}

export async function runAction(ctx: ActionContext, step: Step): Promise<void> {
  const { handle, tracker } = ctx;

  switch (step.action) {
    case "navigate": {
      await handle.cdp.send("Page.enable");
      await handle.cdp.send("Page.navigate", { url: step.url });
      await new Promise((r) => setTimeout(r, 100));
      break;
    }

    case "click": {
      await bringToFront(handle);
      await realClick(handle, await nodeIdFor(ctx, step.target, ACTIONABLE));
      break;
    }

    case "fill": {
      await bringToFront(handle);
      const id = await nodeIdFor(ctx, step.target, ACTIONABLE);
      await handle.cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: id });
      await handle.cdp.send("DOM.focus", { backendNodeId: id });
      // 全选后插入：走真实输入路径，会正常触发 input/change
      for (const type of ["keyDown", "keyUp"] as const) {
        await handle.cdp.send("Input.dispatchKeyEvent", {
          type, modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65
        });
      }
      await handle.cdp.send("Input.insertText", { text: step.value });
      break;
    }

    case "select": {
      // 原生 <select> 的下拉是 OS 级控件，CDP 点不开。
      // 这是唯一一处刻意走 JS 赋值的 action，并显式补发 input/change 事件。
      await bringToFront(handle);
      const id = await nodeIdFor(ctx, step.target, ACTIONABLE);
      const { object } = (await handle.cdp.send("DOM.resolveNode", { backendNodeId: id })) as {
        object: { objectId: string };
      };
      await handle.cdp.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: `function (v) {
          this.value = v;
          this.dispatchEvent(new Event("input", { bubbles: true }));
          this.dispatchEvent(new Event("change", { bubbles: true }));
        }`,
        arguments: [{ value: step.value }],
        returnByValue: true
      });
      await handle.cdp.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
      break;
    }

    case "press": {
      await bringToFront(handle);
      await handle.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: step.key });
      await handle.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: step.key });
      break;
    }

    case "hover": {
      await bringToFront(handle);
      const { x, y } = await centerOf(handle, await nodeIdFor(ctx, step.target, ACTIONABLE));
      await handle.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      break;
    }

    case "scroll": {
      await bringToFront(handle);
      if (step.target) {
        await handle.cdp.send("DOM.scrollIntoViewIfNeeded", {
          backendNodeId: await nodeIdFor(ctx, step.target)
        });
      } else {
        const delta = (step.amount ?? 400) * (step.direction === "up" ? -1 : 1);
        await handle.cdp.send("Input.dispatchMouseEvent", {
          type: "mouseWheel", x: 10, y: 10, deltaX: 0, deltaY: delta
        });
      }
      break;
    }

    case "wait": {
      await waitFor(handle, tracker, step.until, ctx.refs, step.timeout);
      return; // 显式等待自带条件，不再叠加隐式等待
    }

    case "sleep": {
      await new Promise((r) => setTimeout(r, step.ms));
      return;
    }

    case "extract": {
      const id = await nodeIdFor(ctx, step.target);
      const fn = step.from === "value"
        ? `function () { return String(this.value == null ? "" : this.value); }`
        : `function () { return (this.textContent || "").trim(); }`;
      ctx.vars[step.as] = await readProperty(handle, id, fn);
      return;
    }

    case "assert":
      throw new Error("assert 由 runAssert 处理，不应进入 runAction");
  }

  // 除 wait/sleep/extract 外，每个动作后自动隐式等待（spec §7.2）
  await waitStable(handle, tracker, ctx.stability);
}
