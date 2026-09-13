import type { RawAxNode, PrunedNode } from "../types.js";
import { INTERACTIVE_ROLES, SEMANTIC_TEXT_ROLES } from "../types.js";
import { indexById } from "./axtree.js";

export interface PruneOptions { maxNameLength?: number }

const KEEP_PROPS = new Set(["checked", "pressed", "expanded", "disabled", "selected", "level"]);

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function collectProps(n: RawAxNode): Record<string, string> {
  const props: Record<string, string> = {};
  for (const p of n.properties ?? []) {
    if (!KEEP_PROPS.has(p.name)) continue;
    const v = p.value?.value;
    if (v === undefined || v === null || v === false || v === "false") continue;
    props[p.name] = String(v);
  }
  const val = n.value?.value;
  if (val !== undefined && val !== null && val !== "") props.value = String(val);
  const desc = n.description?.value;
  if (desc) props.description = desc;
  return props;
}

/** Chrome 的纯文本节点。InlineTextBox 是布局内部产物，内容永远重复其父节点 */
const TEXT_ROLES = new Set(["StaticText", "InlineTextBox"]);

/**
 * 一个节点是否值得单独出现在快照里（不考虑其子孙）。
 * `ancestorName` 是最近一个【被保留的】祖先的可及名称，用于判断文本是否冗余。
 */
function isKeepable(role: string, name: string, ancestorName: string): boolean {
  if (INTERACTIVE_ROLES.has(role)) return true;
  if (SEMANTIC_TEXT_ROLES.has(role)) return true;
  if (TEXT_ROLES.has(role)) {
    // 文本只在尚未被最近的保留祖先覆盖时才有信息量：
    // button "查看详情" 里的 StaticText/InlineTextBox "查看详情" 是纯冗余；
    // 而独立的 <span>员工1</span> 没有任何祖先承载它，必须留。
    return name.length > 0 && !ancestorName.includes(name);
  }
  if (role === "generic") return false;
  // 有可及名称的容器（navigation "全局导航" 这类）保留，作为容器锚点参照
  return name.length > 0;
}

export function prune(
  nodes: RawAxNode[],
  rootId: string,
  opts: PruneOptions = {}
): PrunedNode | undefined {
  const maxName = opts.maxNameLength ?? 80;
  const index = indexById(nodes);

  function walk(id: string, ancestorName: string): PrunedNode[] {
    const n = index.get(id);
    if (!n) return [];

    const role = n.role?.value ?? "";
    const name = truncate((n.name?.value ?? "").trim(), maxName);

    // ignored 的语义是「这个节点」不暴露给辅助技术，不是「这棵子树」不暴露
    // ——真实 AX 树里 <html>/<body> 就是 ignored 的 role=none 包装节点，
    // 内容全在它们下面。所以自身不保留时要把子孙提升到父级，而不是丢掉。
    const keep = !n.ignored && isKeepable(role, name, ancestorName);

    // ancestorName 只在节点真的被保留时才推进，保证它始终指向"最近的保留祖先"
    const children = (n.childIds ?? []).flatMap((c) => walk(c, keep ? name : ancestorName));

    if (!keep) return children;
    return [{ role, name, props: collectProps(n), backendNodeId: n.backendDOMNodeId, children }];
  }

  const root = index.get(rootId);
  if (!root) return undefined;
  const rootName = truncate((root.name?.value ?? "").trim(), maxName);
  return {
    role: root.role?.value ?? "RootWebArea",
    name: rootName,
    props: {},
    backendNodeId: root.backendDOMNodeId,
    children: (root.childIds ?? []).flatMap((c) => walk(c, rootName))
  };
}
