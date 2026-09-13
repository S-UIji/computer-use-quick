import type { PageHandle } from "../session/browser.js";
import type { Descriptor, ResolveResult, Strategy, TargetRef } from "../types.js";
import { markAncestors, clearMarks } from "./container.js";
import { scopeNodeId } from "../session/frames.js";

export class LocatorError extends Error {
  constructor(
    message: string,
    public kind: "target-not-found" | "ambiguous",
    public candidates: string[] = []
  ) {
    super(message);
    this.name = "LocatorError";
  }
}

async function backendIdOfNodeId(handle: PageHandle, nodeId: number): Promise<number> {
  const { node } = (await handle.cdp.send("DOM.describeNode", { nodeId })) as {
    node: { backendNodeId: number };
  };
  return node.backendNodeId;
}

/** 用 CSS 选择器在 scope 内找唯一元素；找不到或非唯一返回 null */
async function bySelector(
  handle: PageHandle,
  scope: number,
  selector: string
): Promise<number | null> {
  const { nodeIds } = (await handle.cdp.send("DOM.querySelectorAll", {
    nodeId: scope,
    selector
  })) as { nodeIds: number[] };
  if (nodeIds.length !== 1) return null;
  return backendIdOfNodeId(handle, nodeIds[0]);
}

/** 在指定子树内按 role + accessibleName 查询，返回唯一命中的 backendNodeId */
async function byAx(
  handle: PageHandle,
  scopeNodeId: number,
  role: string,
  name: string
): Promise<number | null> {
  const { nodes } = (await handle.cdp.send("Accessibility.queryAXTree", {
    nodeId: scopeNodeId,
    accessibleName: name,
    role
  })) as { nodes: Array<{ backendDOMNodeId?: number; ignored?: boolean }> };
  const hits = nodes.filter((n) => !n.ignored && n.backendDOMNodeId !== undefined);
  return hits.length === 1 ? hits[0].backendDOMNodeId! : null;
}

/**
 * 锚定策略：给锚文本所在元素的祖先链打标记，由内向外逐层用 AX 查询，
 * 第一个唯一命中的层胜出。这正是真人的做法——先认是哪张卡，再点卡里的按钮。
 */
async function byAnchor(
  handle: PageHandle,
  scope: number,
  anchorText: string,
  role: string,
  name: string
): Promise<number | null> {
  const levels = await markAncestors(handle, anchorText);
  try {
    for (let i = 0; i < levels; i++) {
      const { nodeIds } = (await handle.cdp.send("DOM.querySelectorAll", {
        nodeId: scope,
        selector: `[data-cuq-anchor="${i}"]`
      })) as { nodeIds: number[] };
      if (nodeIds.length !== 1) continue;
      const hit = await byAx(handle, nodeIds[0], role, name);
      if (hit !== null) return hit;
    }
    return null;
  } finally {
    await clearMarks(handle);
  }
}

/**
 * 文本策略：一次 evaluate 里筛出唯一匹配并打临时标记，再用选择器取回。
 * 逐个 resolveNode 读 textContent 会是 2N 次 CDP 往返，页面稍大就不可接受。
 */
async function byText(
  handle: PageHandle,
  scope: number,
  tag: string,
  text: string
): Promise<number | null> {
  const expression = `(function (tag, text) {
    document.querySelectorAll("[data-cuq-text]").forEach(function (e) {
      e.removeAttribute("data-cuq-text");
    });
    var els = Array.prototype.slice.call(document.querySelectorAll(tag)).filter(function (e) {
      return (e.textContent || "").trim() === text;
    });
    if (els.length !== 1) return 0;
    els[0].setAttribute("data-cuq-text", "1");
    return 1;
  })(${JSON.stringify(tag)}, ${JSON.stringify(text)})`;

  const { result } = (await handle.cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true
  })) as { result: { value: number } };
  if (result.value !== 1) return null;

  try {
    return await bySelector(handle, scope, "[data-cuq-text]");
  } finally {
    await handle.cdp.send("Runtime.evaluate", {
      expression: `document.querySelectorAll("[data-cuq-text]")
        .forEach(function (e) { e.removeAttribute("data-cuq-text"); })`,
      returnByValue: true
    });
  }
}

async function byXPath(handle: PageHandle, xpath: string): Promise<number | null> {
  // performSearch 需要文档已完整加载到 DOM 域
  await handle.cdp.send("DOM.getDocument", { depth: -1 });
  const { searchId, resultCount } = (await handle.cdp.send("DOM.performSearch", {
    query: xpath
  })) as { searchId: string; resultCount: number };

  try {
    if (resultCount !== 1) return null;
    const { nodeIds } = (await handle.cdp.send("DOM.getSearchResults", {
      searchId,
      fromIndex: 0,
      toIndex: 1
    })) as { nodeIds: number[] };
    return nodeIds.length === 1 ? backendIdOfNodeId(handle, nodeIds[0]) : null;
  } finally {
    await handle.cdp.send("DOM.discardSearchResults", { searchId }).catch(() => {});
  }
}

async function tryStrategy(
  handle: PageHandle,
  s: Strategy,
  scope: number
): Promise<number | null> {
  switch (s.kind) {
    case "test-id":
      return bySelector(
        handle, scope,
        `[data-testid="${s.value}"],[data-test="${s.value}"],[data-qa="${s.value}"]`
      );
    case "container-role-name":
      return byAnchor(handle, scope, s.containerText, s.role, s.name);
    case "row-role-name":
      return byAnchor(handle, scope, s.rowText, s.role, s.name);
    case "role-name":
      return byAx(handle, scope, s.role, s.name);
    case "text":
      return byText(handle, scope, s.tag, s.text);
    case "css":
      return bySelector(handle, scope, s.value);
    case "xpath":
      return byXPath(handle, s.value);
  }
}

export async function resolve(handle: PageHandle, d: Descriptor): Promise<ResolveResult> {
  const scope = await scopeNodeId(handle, d.framePath);
  const tried: string[] = [];

  for (let i = 0; i < d.strategies.length; i++) {
    const s = d.strategies[i];
    let id: number | null = null;
    try {
      id = await tryStrategy(handle, s, scope);
    } catch {
      id = null;
    }
    if (id !== null) return { backendNodeId: id, strategyIndex: i, strategyKind: s.kind };
    tried.push(s.kind);
  }

  throw new LocatorError(
    `全部 ${d.strategies.length} 条策略均未唯一命中：${tried.join(" → ")}`,
    "target-not-found",
    d.distinguishers ?? []
  );
}

export async function resolveTarget(
  handle: PageHandle,
  target: TargetRef,
  refs: Map<string, number>
): Promise<ResolveResult> {
  if ("ref" in target) {
    const id = refs.get(target.ref);
    if (id === undefined) {
      throw new LocatorError(
        `ref ${target.ref} 不在当前快照中，请重新 snapshot`,
        "target-not-found"
      );
    }
    return { backendNodeId: id, strategyIndex: -1, strategyKind: "css" };
  }
  return resolve(handle, target.descriptor);
}
