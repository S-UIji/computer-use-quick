import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrowserSession } from "./session/browser.js";
import { takeSnapshot } from "./perception/snapshot.js";

/** 最近一次 snapshot 的 ref 表，按 pageId 保存，供 batch 用 ref 指代元素 */
export const refTables = new Map<string, Map<string, number>>();

export function createServer(session: BrowserSession): McpServer {
  const server = new McpServer({ name: "computer-use-quick", version: "0.1.0" });

  server.registerTool(
    "snapshot",
    {
      description:
        "返回当前页面的精简可交互元素快照（替代截图）。结构相同的兄弟节点会被折叠，" +
        "用 expand 传入折叠组 id 可展开查看完整细节。",
      inputSchema: {
        pageId: z.string().optional().describe("目标页面 id，省略则用当前选中页"),
        expand: z.array(z.string()).optional().describe("要展开的折叠组 id 列表"),
        threshold: z.number().int().min(2).optional().describe("折叠阈值，默认 3")
      }
    },
    async ({ pageId, expand, threshold }) => {
      const handle = await session.getPage(pageId);
      const snap = await takeSnapshot(handle, { expand, threshold });
      refTables.set(handle.pageId, snap.refs);
      return {
        content: [{
          type: "text" as const,
          text:
            `# 页面快照 (${handle.pageId})\n` +
            `节点 ${snap.stats.rawNodes} → ${snap.stats.prunedNodes}，折叠组 ${snap.stats.collapsedGroups}\n\n` +
            snap.text
        }]
      };
    }
  );

  return server;
}
