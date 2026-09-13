import type { PrunedNode, SnapshotNode, CollapsedGroup } from "../types.js";
import { isCollapsedGroup } from "../types.js";

export interface CollapseOptions {
  threshold?: number;
  expand?: string[];
}

/** 结构签名：role 序列递归到指定深度，不含 name（name 是区别性内容，不进签名） */
export function signature(node: SnapshotNode, depth = 2): string {
  if (isCollapsedGroup(node)) return `group(${node.count})`;
  if (depth === 0) return node.role;
  return `${node.role}(${node.children.map((c) => signature(c, depth - 1)).join(",")})`;
}

/** 稳定 hash：同样的输入必然得到同样的 groupId */
function stableId(sig: string, path: string): string {
  let h = 0;
  const s = `${path}|${sig}`;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return `g${(h >>> 0).toString(36)}`;
}

/** 取一个节点的区别性摘要：自身 name + 所有后代里的非空文本，去重后拼接 */
function summarize(node: PrunedNode): string {
  const parts: string[] = [];
  if (node.name) parts.push(node.name);
  const walk = (n: SnapshotNode): void => {
    if (isCollapsedGroup(n)) return;
    if (n.name && !parts.includes(n.name)) parts.push(n.name);
    for (const c of n.children) walk(c);
  };
  for (const c of node.children) walk(c);
  return parts.join(" · ");
}

/** 取组内成员共有的字段名（用第一项的后代 role/name 列表代表结构） */
function fieldsOf(node: PrunedNode): string[] {
  const out: string[] = [];
  const walk = (n: SnapshotNode): void => {
    if (isCollapsedGroup(n)) return;
    out.push(n.name || n.role);
    for (const c of n.children) walk(c);
  };
  for (const c of node.children) walk(c);
  return out;
}

export function collapse(root: PrunedNode, opts: CollapseOptions = {}): PrunedNode {
  const threshold = opts.threshold ?? 3;
  const expand = new Set(opts.expand ?? []);

  function walk(node: PrunedNode, path: string): PrunedNode {
    const kids = node.children.map((c, i) =>
      isCollapsedGroup(c) ? c : walk(c, `${path}/${c.role}[${i}]`)
    );

    const out: SnapshotNode[] = [];
    let i = 0;
    while (i < kids.length) {
      const cur = kids[i];
      if (isCollapsedGroup(cur)) { out.push(cur); i++; continue; }

      const sig = signature(cur);
      let j = i + 1;
      while (j < kids.length) {
        const next = kids[j];
        if (isCollapsedGroup(next) || signature(next) !== sig) break;
        j++;
      }
      const run = kids.slice(i, j) as PrunedNode[];

      if (run.length >= threshold) {
        const groupId = stableId(sig, `${path}#${i}`);
        if (expand.has(groupId)) {
          out.push(...run);
        } else {
          out.push({
            kind: "collapsed-group",
            count: run.length,
            fields: fieldsOf(run[0]),
            items: run.map(summarize),
            groupId
          } satisfies CollapsedGroup);
        }
      } else {
        out.push(...run);
      }
      i = j;
    }

    return { ...node, children: out };
  }

  return walk(root, "");
}
