import type { CDPSession } from "puppeteer-core";
import type { RawAxNode } from "../types.js";

export async function fetchAxTree(cdp: CDPSession, frameId?: string): Promise<RawAxNode[]> {
  const { nodes } = (await cdp.send(
    "Accessibility.getFullAXTree",
    frameId ? { frameId } : {}
  )) as { nodes: RawAxNode[] };
  return nodes;
}

export function indexById(nodes: RawAxNode[]): Map<string, RawAxNode> {
  const map = new Map<string, RawAxNode>();
  for (const n of nodes) map.set(n.nodeId, n);
  return map;
}

export function buildTree(nodes: RawAxNode[]): RawAxNode | undefined {
  const childIds = new Set<string>();
  for (const n of nodes) for (const c of n.childIds ?? []) childIds.add(c);
  return nodes.find((n) => !childIds.has(n.nodeId));
}
