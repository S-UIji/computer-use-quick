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
  // response 的精确语义锚点：等待开始后才完成的匹配响应才算数，历史请求不计入
  const since = Date.now();

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
        // urlPattern 精确匹配：等待开始后有 URL 包含 pattern 的请求完成即满足。
        // 不做「网络静默」回退——静默近似正是本修复要消灭的缺陷（等错的接口安静了也会通过）
        return tracker.sawUrlSince(cond.urlPattern, since);
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
