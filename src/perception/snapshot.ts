import type { PageHandle } from "../session/browser.js";
import type { PrunedNode, SnapshotResult } from "../types.js";
import { listFrames } from "../session/frames.js";
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
  const frames = await listFrames(handle);
  const mainFrameId = frames[0]?.frameId;

  let rawTotal = 0;
  const merged: PrunedNode = { role: "RootWebArea", name: "", props: {}, children: [] };

  for (const f of frames) {
    const raw = await fetchAxTree(handle.cdp, f.frameId);
    rawTotal += raw.length;

    const root = buildTree(raw);
    if (!root) continue;
    const pruned = prune(raw, root.nodeId);
    if (!pruned) continue;

    if (f.frameId === mainFrameId) {
      merged.children.push(...pruned.children);
    } else {
      // 子 frame 的内容包一层，让模型看得到归属
      merged.children.push({
        role: "iframe", name: f.key, props: { frame: f.key }, children: pruned.children
      });
    }
  }

  // 空白页（about:blank、尚未导航）是合法状态，不是错误——返回空快照即可
  const collapsed = collapse(merged, { threshold: opts.threshold, expand: opts.expand });
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
    stats: { rawNodes: rawTotal, prunedNodes: prunedCount, collapsedGroups: groupCount }
  };
}
