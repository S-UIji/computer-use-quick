import type { PageHandle } from "../session/browser.js";
import type { SnapshotResult } from "../types.js";
import { fetchAxTree, buildTree } from "./axtree.js";
import { prune } from "./prune.js";
import { collapse } from "./collapse.js";
import { render } from "./render.js";

export interface SnapshotOptions {
  expand?: string[];
  threshold?: number;
}

export async function takeSnapshot(
  handle: PageHandle,
  opts: SnapshotOptions = {}
): Promise<SnapshotResult> {
  const raw = await fetchAxTree(handle.cdp);
  const root = buildTree(raw);
  if (!root) throw new Error("a11y 树为空，页面可能尚未加载");

  const pruned = prune(raw, root.nodeId);
  if (!pruned) throw new Error("裁剪后无可用节点");

  const collapsed = collapse(pruned, { threshold: opts.threshold, expand: opts.expand });
  const { text, refs } = render(collapsed);

  let prunedCount = 0;
  let groupCount = 0;
  const count = (n: unknown): void => {
    const node = n as { kind?: string; children?: unknown[] };
    if (node.kind === "collapsed-group") { groupCount++; return; }
    prunedCount++;
    for (const c of node.children ?? []) count(c);
  };
  for (const c of collapsed.children) count(c);

  return {
    text,
    refs,
    stats: { rawNodes: raw.length, prunedNodes: prunedCount, collapsedGroups: groupCount }
  };
}
