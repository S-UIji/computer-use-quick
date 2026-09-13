import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrowserSession } from "./session/browser.js";
import type { Step } from "./types.js";
import { takeSnapshot } from "./perception/snapshot.js";
import { DiagnosticsCollector } from "./diagnostics/collector.js";
import { NetworkTracker } from "./waiter/stability.js";
import { runBatch } from "./executor/batch.js";

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
      // 尽早挂上采集器，否则第一次失败时拿不到之前的 console 报错
      await DiagnosticsCollector.attach(handle);
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

  server.registerTool(
    "batch",
    {
      description:
        "一次执行多个步骤，把 N 次往返压成 1 次——这是本服务提速的主要来源，" +
        "不要一次只传一步。\n" +
        "步骤类型：navigate/click/fill/select/press/hover/scroll/wait/sleep/assert/extract。\n" +
        "每个动作后自动做稳定性等待，无需写 sleep（纯 setTimeout 触发的更新除外，那种要用 wait）。\n" +
        "fail-fast：任一步失败即停，并一次性返回失败步、当前快照、console 报错和失败请求。\n" +
        "target 用 snapshot 返回的 ref（{\"ref\":\"e3\"}）或 descriptor。\n" +
        "提示：快照里被折叠的组，组内元素没有 ref，但【不需要先 expand】——" +
        "直接用 container-role-name 定位即可，containerText 取组内条目的文字、name 取 fields 里的项，" +
        "例如 {\"descriptor\":{\"strategies\":[{\"kind\":\"container-role-name\"," +
        "\"containerText\":\"教育事业群\",\"role\":\"button\",\"name\":\"查看在岗干部明细\"}],\"framePath\":[]}}。",
      inputSchema: {
        pageId: z.string().optional(),
        steps: z.array(z.record(z.any())).min(1).describe("步骤数组，见 description"),
        vars: z.record(z.string()).optional()
          .describe("变量表，供 ${VAR} 插值；凭证从这里传，不要写进步骤字面量")
      }
    },
    async ({ pageId, steps, vars }) => {
      const handle = await session.getPage(pageId);
      const collector = await DiagnosticsCollector.attach(handle);
      const tracker = await NetworkTracker.attach(handle);
      const refs = refTables.get(handle.pageId) ?? new Map<string, number>();

      const r = await runBatch({
        handle, tracker, collector, refs,
        vars: { ...process.env, ...(vars ?? {}) } as Record<string, string>,
        steps: steps as unknown as Step[]
      });
      refTables.set(handle.pageId, refs);

      if (r.ok) {
        const total = r.results.reduce((a, s) => a + s.durationMs, 0);
        const warnings = r.results.filter((s) => s.error).map((s) => `第 ${s.index + 1} 步：${s.error}`);
        return { content: [{ type: "text" as const, text:
          `✅ ${r.results.length} 步全部成功（合计 ${total}ms）\n` +
          (warnings.length ? `\n⚠ ${warnings.join("\n⚠ ")}\n` : "") +
          `\n## 执行后快照\n${r.snapshot}` }] };
      }

      const f = r.failure!;
      return { content: [{ type: "text" as const, text:
        `❌ 第 ${f.failedIndex + 1} 步失败：${f.kind}\n${f.message}\n\n` +
        `## 失败步骤\n${JSON.stringify(f.failedStep, null, 2)}\n\n` +
        (f.candidates?.length ? `## 同容器内的其它文字（可用于消歧）\n${f.candidates.join("\n")}\n\n` : "") +
        `## 当前快照\n${f.snapshot}\n\n` +
        `## console 报错\n${f.consoleErrors.join("\n") || "（无）"}\n\n` +
        `## 失败请求\n${f.failedRequests.join("\n") || "（无）"}` }] };
    }
  );

  server.registerTool(
    "inspect",
    {
      description:
        "取当前页面的诊断信息：截图、console 报错、失败网络请求。只在排查失败时调用——" +
        "batch 失败时已经把这些一并返回了，通常不需要再调。",
      inputSchema: {
        pageId: z.string().optional(),
        withScreenshot: z.boolean().optional().describe("是否附带截图，默认 true")
      }
    },
    async ({ pageId, withScreenshot = true }) => {
      const handle = await session.getPage(pageId);
      const c = await DiagnosticsCollector.attach(handle);
      const parts: Array<
        { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
      > = [
        {
          type: "text",
          text:
            `## console 报错（最近 ${c.consoleErrors().length} 条）\n` +
            `${c.consoleErrors().join("\n") || "（无）"}\n\n` +
            `## 失败请求（最近 ${c.failedRequests().length} 条）\n` +
            `${c.failedRequests().join("\n") || "（无）"}`
        }
      ];
      if (withScreenshot) {
        parts.push({ type: "image", data: await c.screenshot(), mimeType: "image/png" });
      }
      return { content: parts };
    }
  );

  return server;
}
