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

/** 一个节点是否值得单独出现在快照里（不考虑其子孙） */
function isKeepable(role: string, name: string): boolean {
  if (INTERACTIVE_ROLES.has(role)) return true;
  if (SEMANTIC_TEXT_ROLES.has(role)) return true;
  // 有可及名称的容器（navigation "全局导航" 这类）保留，作为容器锚点参照
  if (name.length > 0 && role !== "generic" && role !== "StaticText") return true;
  return false;
}

export function prune(
  nodes: RawAxNode[],
  rootId: string,
  opts: PruneOptions = {}
): PrunedNode | undefined {
  const maxName = opts.maxNameLength ?? 80;
  const index = indexById(nodes);

  function walk(id: string): PrunedNode[] {
    const n = index.get(id);
    if (!n || n.ignored) return [];

    const role = n.role?.value ?? "";
    const name = truncate((n.name?.value ?? "").trim(), maxName);
    const children = (n.childIds ?? []).flatMap(walk);

    if (!isKeepable(role, name)) {
      // 自己不值得保留，但子孙可能值得：把子孙提升到父级
      return children;
    }
    return [{ role, name, props: collectProps(n), backendNodeId: n.backendDOMNodeId, children }];
  }

  const root = index.get(rootId);
  if (!root) return undefined;
  return {
    role: root.role?.value ?? "RootWebArea",
    name: truncate((root.name?.value ?? "").trim(), maxName),
    props: {},
    backendNodeId: root.backendDOMNodeId,
    children: (root.childIds ?? []).flatMap(walk)
  };
}
