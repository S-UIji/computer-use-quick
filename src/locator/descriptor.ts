import type { PageHandle } from "../session/browser.js";
import type { Descriptor, Strategy } from "../types.js";
import { findAnchor } from "./container.js";
import { framePathOf } from "../session/frames.js";

interface DomInfo {
  tag: string;
  id: string;
  testId: string;
  classes: string[];
  text: string;
  xpath: string;
}

const DOM_INFO_FN = `function () {
  var el = this;
  function isStableClass(c) {
    // 过滤掉 CSS-in-JS / 构建期生成的随机类名（含连续数字或看起来像 hash）
    return c.length > 1 && !/\\d{3,}/.test(c) && !/^[a-z]+-[a-z0-9]{5,}$/i.test(c);
  }
  function xpathOf(node) {
    if (node.id) return '//*[@id="' + node.id + '"]';
    var parts = [], cur = node;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      var i = 1, sib = cur.previousElementSibling;
      while (sib) { if (sib.tagName === cur.tagName) i++; sib = sib.previousElementSibling; }
      parts.unshift(cur.tagName.toLowerCase() + "[" + i + "]");
      cur = cur.parentElement;
    }
    return "/html/" + parts.join("/");
  }
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || "",
    testId: el.getAttribute("data-testid") || el.getAttribute("data-test")
         || el.getAttribute("data-qa") || "",
    classes: Array.prototype.slice.call(el.classList).filter(isStableClass),
    text: (el.textContent || "").trim().slice(0, 60),
    xpath: xpathOf(el)
  };
}`;

async function domInfo(handle: PageHandle, backendNodeId: number): Promise<DomInfo> {
  const { object } = (await handle.cdp.send("DOM.resolveNode", { backendNodeId })) as {
    object: { objectId: string };
  };
  const { result } = (await handle.cdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: DOM_INFO_FN,
    returnByValue: true
  })) as { result: { value: DomInfo } };
  await handle.cdp.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
  return result.value;
}

/** 用 CDP 取元素的 a11y role 与 name */
async function axOf(
  handle: PageHandle,
  backendNodeId: number
): Promise<{ role: string; name: string }> {
  const { nodes } = (await handle.cdp.send("Accessibility.getPartialAXTree", {
    backendNodeId,
    fetchRelatives: false
  })) as { nodes: Array<{ role?: { value?: string }; name?: { value?: string } }> };
  const n = nodes[0];
  return { role: n?.role?.value ?? "", name: (n?.name?.value ?? "").trim() };
}

function cssOf(info: DomInfo): string {
  if (info.id) return `#${info.id}`;
  if (info.classes.length) return `${info.tag}.${info.classes.join(".")}`;
  return info.tag;
}

export async function buildDescriptor(
  handle: PageHandle,
  backendNodeId: number
): Promise<Descriptor> {
  const [info, ax, anchor, framePath] = await Promise.all([
    domInfo(handle, backendNodeId),
    axOf(handle, backendNodeId),
    findAnchor(handle, backendNodeId),
    framePathOf(handle, backendNodeId)
  ]);

  const strategies: Strategy[] = [];

  if (info.testId) strategies.push({ kind: "test-id", value: info.testId });

  if (anchor && ax.role && ax.name) {
    strategies.push(
      anchor.kind === "row"
        ? { kind: "row-role-name", rowText: anchor.anchorText, role: ax.role, name: ax.name }
        : { kind: "container-role-name", containerText: anchor.anchorText, role: ax.role, name: ax.name }
    );
  }

  if (ax.role && ax.name) strategies.push({ kind: "role-name", role: ax.role, name: ax.name });
  if (info.text) strategies.push({ kind: "text", tag: info.tag, text: info.text });
  strategies.push({ kind: "css", value: cssOf(info) });
  strategies.push({ kind: "xpath", value: info.xpath });

  return { strategies, framePath, distinguishers: anchor?.distinguishers };
}
