/**
 * 快照增量 diff：渲染文本的行级 LCS。
 * 不做树 diff——折叠树对插入极度敏感（兄弟插一项整棵子树签名漂移），
 * 而渲染行正是模型消费的原子单位，行级对比稳健且直接。
 */

export interface SnapshotDiff {
  /** 当前快照有、上一次没有的行（按当前顺序，带 [eN] ref 可直接操作） */
  added: string[];
  /** 上一次有、当前没有的行（按上次顺序） */
  removed: string[];
  /** 新增段截断未展示的行数 */
  truncatedAdded: number;
  /** 消失段截断未展示的行数 */
  truncatedRemoved: number;
  /** 无历史基线 */
  firstBaseline: boolean;
}

export const DIFF_LINE_CAP = 50;

export function diffLines(
  prev: string[] | null,
  curr: string[],
  cap = DIFF_LINE_CAP
): SnapshotDiff {
  if (prev === null) {
    const added = curr.slice(0, cap);
    return {
      added,
      removed: [],
      truncatedAdded: Math.max(0, curr.length - cap),
      truncatedRemoved: 0,
      firstBaseline: true
    };
  }

  // 标准 LCS 动态规划。典型快照 ~80 行，6400 格矩阵毫秒级。
  const m = prev.length, n = curr.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = prev[i] === curr[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const removed: string[] = [];
  const added: string[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (prev[i] === curr[j]) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { removed.push(prev[i]); i++; }
    else { added.push(curr[j]); j++; }
  }
  while (i < m) { removed.push(prev[i]); i++; }
  while (j < n) { added.push(curr[j]); j++; }

  return {
    added: added.slice(0, cap),
    removed: removed.slice(0, cap),
    truncatedAdded: Math.max(0, added.length - cap),
    truncatedRemoved: Math.max(0, removed.length - cap),
    firstBaseline: false
  };
}

/** 渲染 diff 报告（人读格式） */
export function renderDiff(d: SnapshotDiff): string {
  if (d.firstBaseline) {
    return [
      "# 首次快照（作为下次 diff 的基线）",
      ...d.added,
      d.truncatedAdded > 0 ? `（基线过长，仅展示前 ${d.added.length} 行）` : ""
    ].filter(Boolean).join("\n");
  }

  const lines = [`# 快照 diff（新增 ${d.added.length}${d.truncatedAdded ? "+" + d.truncatedAdded : ""} / 消失 ${d.removed.length}${d.truncatedRemoved ? "+" + d.truncatedRemoved : ""}）`, ""];
  if (d.added.length || d.truncatedAdded) {
    lines.push("新增：");
    for (const l of d.added) lines.push(`+ ${l}`);
    if (d.truncatedAdded) lines.push(`（还有 ${d.truncatedAdded} 行新增未展示，可用全量 snapshot 查看）`);
  }
  if (d.removed.length || d.truncatedRemoved) {
    lines.push("", "消失：");
    for (const l of d.removed) lines.push(`- ${l}`);
    if (d.truncatedRemoved) lines.push(`（还有 ${d.truncatedRemoved} 行消失未展示）`);
  }
  if (!d.added.length && !d.removed.length && !d.truncatedAdded && !d.truncatedRemoved) {
    lines.push("（与上一次快照无差异）");
  }
  return lines.join("\n");
}
