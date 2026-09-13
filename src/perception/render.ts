import type { PrunedNode, SnapshotNode } from "../types.js";
import { isCollapsedGroup } from "../types.js";

export function render(root: PrunedNode): { text: string; refs: Map<string, number> } {
  const refs = new Map<string, number>();
  const lines: string[] = [];
  let counter = 0;

  function propsSuffix(props: Record<string, string>): string {
    const entries = Object.entries(props);
    return entries.length ? " " + entries.map(([k, v]) => `${k}=${v}`).join(" ") : "";
  }

  function emit(node: SnapshotNode, depth: number): void {
    const pad = "  ".repeat(depth);

    if (isCollapsedGroup(node)) {
      lines.push(
        `${pad}[${node.count} 项结构相同，展开用 expand=["${node.groupId}"]，字段：${node.fields.join("/")}]`
      );
      node.items.forEach((it, i) => lines.push(`${pad}  ${i + 1}. ${it}`));
      return;
    }

    let prefix = "";
    if (node.backendNodeId !== undefined) {
      const ref = `e${++counter}`;
      refs.set(ref, node.backendNodeId);
      prefix = `[${ref}] `;
    }
    lines.push(
      `${pad}${prefix}${node.role}${node.name ? ` "${node.name}"` : ""}${propsSuffix(node.props)}`
    );
    for (const c of node.children) emit(c, depth + 1);
  }

  // 根节点自身不渲染成一行，直接渲染其子树
  for (const c of root.children) emit(c, 0);

  return { text: lines.join("\n"), refs };
}
