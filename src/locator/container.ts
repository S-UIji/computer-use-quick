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

export async function markAncestors(handle: PageHandle, anchorText: string): Promise<number> {
  const expression = `(function (anchorText) {
    var all = document.querySelectorAll("*"), leaf = null;
    for (var i = 0; i < all.length; i++) {
      if (all[i].children.length === 0 && (all[i].textContent || "").trim() === anchorText) {
        leaf = all[i]; break;
      }
    }
    if (!leaf) return 0;
    var cur = leaf.parentElement, n = 0;
    while (cur && cur !== document.body && n < 10) {
      cur.setAttribute("data-cuq-anchor", String(n));
      cur = cur.parentElement; n++;
    }
    return n;
  })(${JSON.stringify(anchorText)})`;

  const { result } = (await handle.cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true
  })) as { result: { value: number } };
  return result.value;
}

export async function clearMarks(handle: PageHandle): Promise<void> {
  await handle.cdp.send("Runtime.evaluate", {
    expression: `document.querySelectorAll('[data-cuq-anchor]')
      .forEach(function (e) { e.removeAttribute('data-cuq-anchor'); })`,
    returnByValue: true
  });
}
