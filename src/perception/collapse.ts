import type { PrunedNode, SnapshotNode, CollapsedGroup } from "../types.js";
import { isCollapsedGroup } from "../types.js";

export interface CollapseOptions {
  threshold?: number;
  expand?: string[];
  /** 重复单元的最大长度。行容器被裁掉后，一"行"会摊平成若干兄弟节点 */
  maxPeriod?: number;
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

/** 取一个节点的可读摘要：自身 name + 所有后代里的非空文本，去重后拼接 */
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

/** 从 start 开始，以 p 为周期能连续重复多少次 */
function periodRepeats(sigs: string[], start: number, p: number): number {
  let reps = 1;
  for (;;) {
    const base = start + reps * p;
    if (base + p > sigs.length) break;
    let same = true;
    for (let k = 0; k < p; k++) {
      if (sigs[base + k] !== sigs[start + k]) { same = false; break; }
    }
    if (!same) break;
    reps++;
  }
  return reps;
}

export function collapse(root: PrunedNode, opts: CollapseOptions = {}): PrunedNode {
  const threshold = opts.threshold ?? 3;
  const maxPeriod = opts.maxPeriod ?? 8;
  const expand = new Set(opts.expand ?? []);

  function walk(node: PrunedNode, path: string): PrunedNode {
    const kids = node.children.map((c, i) =>
      isCollapsedGroup(c) ? c : walk(c, `${path}/${c.role}[${i}]`)
    );
    const sigs = kids.map((k) => signature(k));

    const out: SnapshotNode[] = [];
    let i = 0;
    while (i < kids.length) {
      if (isCollapsedGroup(kids[i])) { out.push(kids[i]); i++; continue; }

      // 找能达到阈值的【最小】周期。p=1 就是"N 个连续相同兄弟"这种简单情形；
      // p>1 覆盖行容器被裁掉后摊平的重复单元（靶场的部门卡片正是如此）。
      let best: { p: number; reps: number } | null = null;
      for (let p = 1; p <= Math.min(maxPeriod, kids.length - i); p++) {
        if (kids.slice(i, i + p).some(isCollapsedGroup)) break;
        const reps = periodRepeats(sigs, i, p);
        if (reps >= threshold) { best = { p, reps }; break; }
      }

      if (!best) { out.push(kids[i]); i++; continue; }

      const { p, reps } = best;
      const span = kids.slice(i, i + p * reps) as PrunedNode[];
      const groupId = stableId(sigs.slice(i, i + p).join("|"), `${path}#${i}`);

      if (expand.has(groupId)) {
        out.push(...span);
      } else {
        // 把周期内"每次重复都一样"的位置提出来当结构说明（fields），
        // 只有真正变化的位置才逐项列出（items）——否则重复 N 遍常量纯属浪费 token
        const cells: string[][] = [];
        for (let r = 0; r < reps; r++) {
          cells.push(span.slice(r * p, r * p + p).map(summarize));
        }
        const constant: boolean[] = [];
        for (let pos = 0; pos < p; pos++) {
          constant.push(cells.every((row) => row[pos] === cells[0][pos]));
        }

        const fields = cells[0].filter((v, pos) => constant[pos] && v.length > 0);
        const items = cells
          .map((row) => row.filter((v, pos) => !constant[pos] && v.length > 0).join(" · "))
          .filter((s) => s.length > 0);

        out.push({
          kind: "collapsed-group",
          count: reps,
          fields: fields.length ? fields : cells[0].filter((v) => v.length > 0),
          items,
          groupId
        } satisfies CollapsedGroup);
      }
      i += p * reps;
    }

    return { ...node, children: out };
  }

  return walk(root, "");
}
