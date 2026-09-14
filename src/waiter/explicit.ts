import type { PageHandle } from "../session/browser.js";
import type { WaitCondition } from "../types.js";
import { resolveTarget } from "../locator/resolve.js";
import type { NetworkTracker } from "./stability.js";

async function isVisible(handle: PageHandle, backendNodeId: number): Promise<boolean> {
  try {
    const { model } = (await handle.cdp.send("DOM.getBoxModel", { backendNodeId })) as {
      model?: { width: number; height: number };
    };
    return !!model && model.width > 0 && model.height > 0;
  } catch {
    return false;
  }
}

async function currentUrl(handle: PageHandle): Promise<string> {
  const { result } = (await handle.cdp.send("Runtime.evaluate", {
    expression: "location.href",
    returnByValue: true
  })) as { result: { value: string } };
  return result.value;
}

export async function waitFor(
  handle: PageHandle,
  tracker: NetworkTracker,
  cond: WaitCondition,
  refs: Map<string, number>,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  const satisfied = async (): Promise<boolean> => {
    switch (cond.type) {
      case "visible": {
        try {
          const r = await resolveTarget(handle, cond.target, refs);
          return await isVisible(handle, r.backendNodeId);
        } catch { return false; }
      }
      case "hidden": {
        try {
          const r = await resolveTarget(handle, cond.target, refs);
          return !(await isVisible(handle, r.backendNodeId));
        } catch { return true; }
      }
      case "url-contains":
        return (await currentUrl(handle)).includes(cond.value);
      case "response":
        // 一期用"网络静默"近似，不做 urlPattern 精确匹配（见 README 已知边界）
        return tracker.inFlight() === 0 && Date.now() - tracker.lastChangeAt() >= 300;
    }
  };

  for (;;) {
    if (await satisfied()) return;
    if (Date.now() >= deadline) {
      throw new Error(`等待条件 ${cond.type} 超时（${timeoutMs}ms）`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
