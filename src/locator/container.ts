import type { PageHandle } from "../session/browser.js";

export interface AnchorInfo {
  kind: "row" | "container";
  anchorText: string;
  distinguishers: string[];
}

/** 在浏览器里对目标元素求锚点。函数体以 this === 目标元素 的方式调用。 */
const FIND_ANCHOR_FN = `function () {
  var el = this;
  var bodyText = document.body.innerText || "";
  function countOf(s) {
    var n = 0, i = 0;
    while ((i = bodyText.indexOf(s, i)) !== -1) { n++; i += s.length; }
    return n;
  }
  function leafTexts(root) {
    var out = [];
    var all = root.querySelectorAll("*");
    for (var k = 0; k < all.length; k++) {
      var e = all[k];
      if (e.children.length !== 0) continue;
      var t = (e.textContent || "").trim();
      if (t.length >= 2 && t.length <= 60) out.push(t);
    }
    return out;
  }
  var cur = el.parentElement, depth = 0;
  while (cur && cur !== document.body && depth < 12) {
    var texts = leafTexts(cur);
    var unique = null;
    for (var i = 0; i < texts.length; i++) {
      if (countOf(texts[i]) === 1) { unique = texts[i]; break; }
    }
    if (unique) {
      return {
        kind: cur.tagName === "TR" ? "row" : "container",
        anchorText: unique,
        distinguishers: texts.filter(function (t) { return t !== unique; }).slice(0, 5)
      };
    }
    cur = cur.parentElement;
    depth++;
  }
  return null;
}`;

async function objectIdOf(handle: PageHandle, backendNodeId: number): Promise<string> {
  const { object } = (await handle.cdp.send("DOM.resolveNode", { backendNodeId })) as {
    object: { objectId: string };
  };
  return object.objectId;
}

/**
 * 以目标文档对象为执行主体调用函数（this === document）。
 * 打标/查找类操作统一走这条路：主 frame 与 iframe 同一条代码路径，
 * 不再依赖固定打在主 frame 的 Runtime.evaluate——那是 iframe 内锚定失效的根因。
 */
export async function callOnDocument<T>(
  handle: PageHandle,
  scopeNodeId: number,
  functionDeclaration: string,
  args: Array<{ value: unknown }> = []
): Promise<T | undefined> {
  const { object } = (await handle.cdp.send("DOM.resolveNode", { nodeId: scopeNodeId })) as {
    object: { objectId: string };
  };
  try {
    const { result } = (await handle.cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration,
      arguments: args,
      returnByValue: true
    })) as { result: { value: T | undefined } };
    return result.value;
  } finally {
    await handle.cdp.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
  }
}

/** 该元素在全页范围内是否已经能被 role+name 唯一确定 */
async function isGloballyUnique(handle: PageHandle, backendNodeId: number): Promise<boolean> {
  const { nodes } = (await handle.cdp.send("Accessibility.getPartialAXTree", {
    backendNodeId,
    fetchRelatives: false
  })) as { nodes: Array<{ role?: { value?: string }; name?: { value?: string } }> };

  const role = nodes[0]?.role?.value ?? "";
  const name = (nodes[0]?.name?.value ?? "").trim();
  if (!role || !name) return false;

  const { root } = (await handle.cdp.send("DOM.getDocument", { depth: 0 })) as {
    root: { nodeId: number };
  };
  const q = (await handle.cdp.send("Accessibility.queryAXTree", {
    nodeId: root.nodeId,
    accessibleName: name,
    role
  })) as { nodes: Array<{ ignored?: boolean; backendDOMNodeId?: number }> };

  return q.nodes.filter((n) => !n.ignored && n.backendDOMNodeId !== undefined).length === 1;
}

export async function findAnchor(
  handle: PageHandle,
  backendNodeId: number
): Promise<AnchorInfo | null> {
  // 全页已经能被 role+name 唯一确定的元素不需要容器锚定。
  // 硬套一层容器只会让 descriptor 凭空多依赖容器文本，反而更脆。
  if (await isGloballyUnique(handle, backendNodeId)) return null;

  const objectId = await objectIdOf(handle, backendNodeId);
  const { result } = (await handle.cdp.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: FIND_ANCHOR_FN,
    returnByValue: true
  })) as { result: { value: AnchorInfo | null } };
  await handle.cdp.send("Runtime.releaseObject", { objectId }).catch(() => {});
  return result.value;
}

/**
 * 在目标文档内打标：锚文本所在元素的祖先链由内向外标 data-cuq-anchor。
 * 以 document 为执行主体（callFunctionOn），iframe 子文档与主 frame 同路径。
 */
export async function markAncestors(
  handle: PageHandle,
  scopeNodeId: number,
  anchorText: string
): Promise<number> {
  const fn = `function (anchorText) {
    var doc = this, all = doc.querySelectorAll("*"), leaf = null;
    for (var i = 0; i < all.length; i++) {
      if (all[i].children.length === 0 && (all[i].textContent || "").trim() === anchorText) {
        leaf = all[i]; break;
      }
    }
    if (!leaf) return 0;
    var cur = leaf.parentElement, n = 0;
    while (cur && cur !== doc.body && n < 10) {
      cur.setAttribute("data-cuq-anchor", String(n));
      cur = cur.parentElement; n++;
    }
    return n;
  }`;
  return (await callOnDocument<number>(handle, scopeNodeId, fn, [{ value: anchorText }])) ?? 0;
}

/** 清理目标文档内的打标（与 markAncestors 同路径，幂等） */
export async function clearMarks(handle: PageHandle, scopeNodeId: number): Promise<void> {
  const fn = `function () {
    this.querySelectorAll("[data-cuq-anchor]")
      .forEach(function (e) { e.removeAttribute("data-cuq-anchor"); });
  }`;
  await callOnDocument(handle, scopeNodeId, fn);
}
