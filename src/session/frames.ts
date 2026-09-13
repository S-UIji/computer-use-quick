import type { PageHandle } from "./browser.js";

export interface FrameInfo {
  frameId: string;
  key: string;
  url: string;
  documentNodeId: number;
}

interface FrameTreeNode {
  frame: { id: string; url: string };
  childFrames?: FrameTreeNode[];
}

/** frame 标识：取 url 最后一段路径。frameId 每次加载都变，不能进 trace */
export function frameKey(url: string): string {
  const path = url.split("?")[0].split("#")[0];
  return path.split("/").filter(Boolean).pop() ?? url;
}

export async function listFrames(handle: PageHandle): Promise<FrameInfo[]> {
  await handle.cdp.send("Page.enable");
  const { frameTree } = (await handle.cdp.send("Page.getFrameTree")) as {
    frameTree: FrameTreeNode;
  };

  const flat: Array<{ frameId: string; url: string }> = [];
  const walkTree = (n: FrameTreeNode): void => {
    flat.push({ frameId: n.frame.id, url: n.frame.url });
    for (const c of n.childFrames ?? []) walkTree(c);
  };
  walkTree(frameTree);

  // pierce 让 getDocument 把子 frame 的 contentDocument 一并带出来
  const { root } = (await handle.cdp.send("DOM.getDocument", { depth: -1, pierce: true })) as {
    root: { nodeId: number; children?: unknown[] };
  };

  const docByFrame = new Map<string, number>();
  if (flat[0]) docByFrame.set(flat[0].frameId, root.nodeId); // 主文档就是 pierce 树的根

  // 实测（Chrome 148）：contentDocument 上【没有】frameId，只有 nodeId/documentURL；
  // 带 frameId 的是它的宿主 <iframe> 元素节点。所以从宿主取 frameId、
  // 从它的 contentDocument 取 nodeId，两边配对。
  const collect = (node: unknown): void => {
    const n = node as {
      frameId?: string;
      contentDocument?: { nodeId: number };
      children?: unknown[];
    };
    if (n.frameId && n.contentDocument) {
      docByFrame.set(n.frameId, n.contentDocument.nodeId);
      collect(n.contentDocument);
    }
    for (const c of n.children ?? []) collect(c);
  };
  collect(root);

  return flat
    .filter((f) => docByFrame.has(f.frameId))
    .map((f) => ({
      frameId: f.frameId,
      key: frameKey(f.url),
      url: f.url,
      documentNodeId: docByFrame.get(f.frameId)!
    }));
}

export async function scopeNodeId(handle: PageHandle, framePath: string[]): Promise<number> {
  const frames = await listFrames(handle);
  if (framePath.length === 0) {
    const main = frames[0];
    if (!main) throw new Error("找不到主文档 frame");
    return main.documentNodeId;
  }
  // 一期只支持一层嵌套：取路径最后一段做查找
  const key = framePath[framePath.length - 1];
  const hit = frames.find((f) => f.key === key);
  if (!hit) {
    throw new Error(
      `找不到 frame「${key}」。当前页面的 frame 有：${frames.map((f) => f.key).join("、")}`
    );
  }
  return hit.documentNodeId;
}

/**
 * 反查某个元素属于哪个 frame，用于生成 descriptor 的 framePath。
 *
 * 不能走 DOM.describeNode 看 frameId——那个字段只在 frame 宿主元素和 document
 * 节点上有，普通按钮没有。也不能用 pushNodesByBackendIdsToFrontend，它依赖
 * frontend 节点表，和并发的 DOM.getDocument 会抢（实测报 "Could not find node"）。
 * 直接问元素自己所在文档的 url 最省事。
 */
export async function framePathOf(
  handle: PageHandle,
  backendNodeId: number
): Promise<string[]> {
  let ownerUrl: string;
  try {
    const { object } = (await handle.cdp.send("DOM.resolveNode", { backendNodeId })) as {
      object: { objectId: string };
    };
    const { result } = (await handle.cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: `function () {
        var d = this.ownerDocument || this;
        return (d.defaultView && d.defaultView.location.href) || d.documentURI || "";
      }`,
      returnByValue: true
    })) as { result: { value: string } };
    await handle.cdp.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
    ownerUrl = result.value;
  } catch {
    return []; // 跨进程 iframe 等拿不到的情况，按主 frame 处理（一期不支持 OOPIF）
  }
  if (!ownerUrl) return [];

  const frames = await listFrames(handle);
  if (!frames[0] || frames[0].url === ownerUrl) return [];
  const hit = frames.find((f) => f.url === ownerUrl);
  return hit ? [hit.key] : [];
}
