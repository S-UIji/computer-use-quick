import type { PageHandle } from "../session/browser.js";
import type { Step, TargetRef } from "../types.js";
import { resolveTarget } from "../locator/resolve.js";
import { NetworkTracker, waitStable } from "../waiter/stability.js";
import { waitFor } from "../waiter/explicit.js";

export interface ActionContext {
  handle: PageHandle;
  tracker: NetworkTracker;
  refs: Map<string, number>;
  vars: Record<string, string>;
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

async function nodeIdFor(ctx: ActionContext, target: TargetRef): Promise<number> {
  return (await resolveTarget(ctx.handle, target, ctx.refs)).backendNodeId;
}

/**
 * 经 CDP Input 域派发真实鼠标事件（spec §2.1）。这里派发的是浏览器级
 * trusted event，前端 JS 分辨不出来；但不做鼠标轨迹动画和人类化延迟。
 */
async function realClick(handle: PageHandle, backendNodeId: number): Promise<void> {
  const { x, y } = await centerOf(handle, backendNodeId);
  await handle.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await handle.cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", clickCount: 1
  });
  await handle.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", clickCount: 1
  });
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
      await realClick(handle, await nodeIdFor(ctx, step.target));
      break;
    }

    case "fill": {
      const id = await nodeIdFor(ctx, step.target);
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
      const id = await nodeIdFor(ctx, step.target);
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
      await handle.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: step.key });
      await handle.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: step.key });
      break;
    }

    case "hover": {
      const { x, y } = await centerOf(handle, await nodeIdFor(ctx, step.target));
      await handle.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      break;
    }

    case "scroll": {
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
  await waitStable(handle, tracker);
}
