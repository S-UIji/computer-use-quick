import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrowserSession } from "./session/browser.js";
import type { RunRecord, Step } from "./types.js";
import { takeSnapshot } from "./perception/snapshot.js";
import { DiagnosticsCollector } from "./diagnostics/collector.js";
import { NetworkTracker } from "./waiter/stability.js";
import { runBatch } from "./executor/batch.js";
import { saveTrace, loadTrace } from "./trace/store.js";
import { replayTrace } from "./trace/replay.js";
import { checkHealGate, runHeal, renderDemoFailure, type HealBudget } from "./trace/heal.js";
import { checkConcurrency, runSuite } from "./trace/suite.js";
import { renderSuiteResult } from "./report/suiteReport.js";
import { renderRunRecord } from "./report/runRecord.js";

/** 最近一次 snapshot 的 ref 表，按 pageId 保存，供 batch 用 ref 指代元素 */
export const refTables = new Map<string, Map<string, number>>();

/** 本 session 内每个页面成功执行过的步骤（ref 已固化成 descriptor），供 save_trace 消费 */
export const sessionSteps = new Map<string, Step[]>();

/** 每个 trace 最近一次 replay 的 run-record，供 heal_step 缺省定位失败步与白名单判定 */
export const lastRunByTrace = new Map<string, RunRecord>();

/** 每个 trace 的自愈预算；replay 全绿时清零，开启新一轮修复周期 */
export const healBudgets = new Map<string, HealBudget>();

export function recordSteps(pageId: string, capturedSteps: Step[]): void {
  const acc = sessionSteps.get(pageId) ?? [];
  acc.push(...capturedSteps);
  sessionSteps.set(pageId, acc);
}

/**
 * 丢弃已记录的步骤：count 丢弃最近 N 步，省略则清空。返回丢弃的条数。
 * 探索走了弯路（点错、回退）时用——sessionSteps 只增不减，
 * 不丢弃的话弯路会一起被 save_trace 固化进 trace。
 */
export function discardSteps(pageId: string, count?: number): number {
  const steps = sessionSteps.get(pageId) ?? [];
  const n = count === undefined ? steps.length : Math.min(count, steps.length);
  sessionSteps.set(pageId, steps.slice(0, steps.length - n));
  return n;
}

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
        "点击会打开新标签页的链接后，用 list_pages 拿到新标签的 pageId 再做后续操作。\n" +
        "target 用 snapshot 返回的 ref（{\"ref\":\"e3\"}）或 descriptor。\n" +
        "提示：快照里被折叠的组，组内元素没有 ref，但【不需要先 expand】——" +
        "直接用 container-role-name 定位即可，containerText 取组内条目的文字、name 取 fields 里的项，" +
        "例如 {\"descriptor\":{\"strategies\":[{\"kind\":\"container-role-name\"," +
        "\"containerText\":\"教育事业群\",\"role\":\"button\",\"name\":\"查看在岗干部明细\"}],\"framePath\":[]}}。",
      inputSchema: {
        pageId: z.string().optional(),
        steps: z.array(z.record(z.any())).min(1).describe("步骤数组，见 description"),
        vars: z.record(z.string()).optional()
          .describe("变量表，供 ${VAR} 插值；凭证从这里传，不要写进步骤字面量"),
        resolveRetryMs: z.number().int().min(0).optional()
          .describe("目标解析的轮询重试预算（默认 3000ms）。页面异步渲染时目标会晚到，" +
            "重试能消除「还没渲染完被误判成不存在」的偶发失败；传 0 恢复一次性解析"),
        stability: z.object({
          domQuietMs: z.number().int().min(0).optional(),
          networkQuietMs: z.number().int().min(0).optional(),
          timeoutMs: z.number().int().min(0).optional()
        }).optional().describe(
          "隐式稳定性等待调参（默认 DOM 静默 150ms、网络静默 500ms、上限 5000ms）。" +
          "只有 XHR/Fetch/Document/Script/Stylesheet 计入网络在途信号，信标/图片类请求不拖住等待；" +
          "打满上限的步骤会在结果里带告警，看到告警再考虑调参"
        )
      }
    },
    async ({ pageId, steps, vars, stability, resolveRetryMs }) => {
      const handle = await session.getPage(pageId);
      const collector = await DiagnosticsCollector.attach(handle);
      const tracker = await NetworkTracker.attach(handle);
      const refs = refTables.get(handle.pageId) ?? new Map<string, number>();

      const r = await runBatch({
        handle, tracker, collector, refs,
        vars: { ...process.env, ...(vars ?? {}) } as Record<string, string>,
        steps: steps as unknown as Step[],
        stability, resolveRetryMs
      });
      refTables.set(handle.pageId, refs);
      recordSteps(handle.pageId, r.capturedSteps);

      if (r.ok) {
        const total = r.results.reduce((a, s) => a + s.durationMs, 0);
        const warnings = r.results.filter((s) => s.error).map((s) => `第 ${s.index + 1} 步：${s.error}`);
        return { content: [{ type: "text" as const, text:
          `✅ ${r.results.length} 步全部成功（合计 ${total}ms）\n` +
          (warnings.length ? `\n⚠ ${warnings.join("\n⚠ ")}\n` : "") +
          `\n## 执行后快照\n${r.snapshot}` }] };
      }

      const f = r.failure!;
      // isError 让客户端在协议层就能看出失败，不必去解析文案
      return { isError: true, content: [{ type: "text" as const, text:
        `❌ 第 ${f.failedIndex + 1} 步失败：${f.kind}\n${f.message}\n\n` +
        `## 失败步骤\n${JSON.stringify(f.failedStep, null, 2)}\n\n` +
        (f.candidates?.length ? `## 同容器内的其它文字（可用于消歧）\n${f.candidates.join("\n")}\n\n` : "") +
        `## 当前快照\n${f.snapshot}\n\n` +
        `## console 报错\n${f.consoleErrors.join("\n") || "（无）"}\n\n` +
        `## 失败请求\n${f.failedRequests.join("\n") || "（无）"}` }] };
    }
  );

  server.registerTool(
    "list_pages",
    {
      description:
        "列出浏览器里当前打开的所有标签页及各自的 pageId（* 标记的是默认作用页）。" +
        "点击会打开新标签的链接后，必须先用这里拿到的 pageId 去调 snapshot/batch，" +
        "否则读到的是第一个标签页而不是刚打开的那个。",
      inputSchema: {}
    },
    async () => {
      const pages = await session.listPages();
      const current = session.currentPageId() ?? pages[0]?.pageId;
      const lines = pages.map((p) =>
        `${p.pageId === current ? "*" : " "} ${p.pageId}\n    ${p.title || "(无标题)"}\n    ${p.url}`
      );
      return { content: [{ type: "text" as const, text:
        `# 标签页（${pages.length}）\n\n${lines.join("\n") || "（没有可用页面）"}` }] };
    }
  );

  server.registerTool(
    "discard_steps",
    {
      description:
        "丢弃本 session 已记录的步骤（最近 N 步或全部）。探索时点了弯路、做了多余操作，" +
        "在 save_trace 前调用它把弯路扔掉，避免固化进 trace。",
      inputSchema: {
        pageId: z.string().optional(),
        count: z.number().int().min(1).optional()
          .describe("丢弃最近 N 步；省略则清空本页全部已记录步骤")
      }
    },
    async ({ pageId, count }) => {
      const handle = await session.getPage(pageId);
      const n = discardSteps(handle.pageId, count);
      const left = sessionSteps.get(handle.pageId)?.length ?? 0;
      return { content: [{ type: "text" as const,
        text: `已丢弃 ${n} 步，本页还剩 ${left} 步已记录步骤。` }] };
    }
  );

  server.registerTool(
    "save_trace",
    {
      description:
        "把本次 session 中成功执行过的步骤固化成可回放的 trace 文件。" +
        "所有 ref 已自动转成稳定的 descriptor；凭证必须是 ${VAR} 占位符，" +
        "写了明文会直接拒绝保存。",
      inputSchema: {
        name: z.string().describe("用例名，将作为文件名"),
        baseUrl: z.string().describe("被测系统根地址"),
        dir: z.string().optional().describe("保存目录，默认 ./traces"),
        pageId: z.string().optional()
      }
    },
    async ({ name, baseUrl, dir, pageId }) => {
      const handle = await session.getPage(pageId);
      const steps = sessionSteps.get(handle.pageId) ?? [];
      if (steps.length === 0) {
        return { content: [{ type: "text" as const,
          text: "本 session 尚无成功执行的步骤，无可保存内容。" }] };
      }
      const path = await saveTrace(dir ?? "./traces", {
        name, baseUrl, createdAt: new Date().toISOString(), steps
      });
      return { content: [{ type: "text" as const, text: `已保存 ${steps.length} 步到 ${path}` }] };
    }
  );

  server.registerTool(
    "replay",
    {
      description:
        "回放一条已固化的 trace：一次调用跑完整条用例，全程不再经过模型。CI 回归用这个。" +
        "返回逐步耗时台账、定位漂移告警（首选策略失效但回放仍成功=页面可能已改版）" +
        "和失败上下文。",
      inputSchema: {
        tracePath: z.string().describe("trace 文件路径"),
        vars: z.record(z.string()).optional().describe("变量表，凭证从这里传"),
        slowMoMs: z.number().int().min(0).optional()
          .describe("每步之间的延迟，演示场景用，默认 0"),
        resolveRetryMs: z.number().int().min(0).optional()
          .describe("目标解析的轮询重试预算，默认 3000ms；传 0 恢复一次性解析"),
        pageId: z.string().optional()
      }
    },
    async ({ tracePath, vars, slowMoMs, resolveRetryMs, pageId }) => {
      const handle = await session.getPage(pageId);
      const collector = await DiagnosticsCollector.attach(handle);
      const tracker = await NetworkTracker.attach(handle);
      collector.clear();

      const trace = await loadTrace(tracePath);
      const rec = await replayTrace({
        handle, tracker, collector, trace, slowMoMs, resolveRetryMs,
        vars: { ...process.env, ...(vars ?? {}) } as Record<string, string>
      });
      // 全绿 = 新一轮修复周期开始，自愈预算清零；失败则记下，供 heal_step 消费
      lastRunByTrace.set(tracePath, rec);
      if (rec.ok) healBudgets.delete(tracePath);
      return { content: [{ type: "text" as const, text: renderRunRecord(rec) }] };
    }
  );

  server.registerTool(
    "replay_suite",
    {
      description:
        "并行回放多条 trace：每条一个独立 BrowserContext（零共享 cookie/storage），" +
        "跑完全部再汇总——任一失败不中断其他用例。CI 一轮回归用这个。\n" +
        "返回聚合报告：概览（总数/成功/失败/墙钟耗时）+ 每条 compact 结果；" +
        "失败用例附完整失败上下文，可直接进入 replay → heal_step 的自愈循环。\n" +
        "concurrency 默认 3、硬上限 8；串行等价于 concurrency=1。",
      inputSchema: {
        tracePaths: z.array(z.string()).min(1).describe("trace 文件路径数组，≥1 条"),
        concurrency: z.number().int().min(1).optional()
          .describe("并发数，默认 3，硬上限 8；1 即串行"),
        vars: z.record(z.string()).optional().describe("变量表，全部用例共享；凭证从这里传"),
        slowMoMs: z.number().int().min(0).optional().describe("每步之间的延迟，演示用"),
        resolveRetryMs: z.number().int().min(0).optional()
          .describe("目标解析的轮询重试预算，默认 3000ms")
      }
    },
    async ({ tracePaths, concurrency, vars, slowMoMs, resolveRetryMs }) => {
      // 上限校验前置：不建任何浏览器资源就拒绝
      const gate = checkConcurrency(concurrency);
      if (!gate.ok) {
        return { isError: true, content: [{ type: "text" as const, text: gate.reason }] };
      }
      const result = await runSuite({
        session, paths: tracePaths,
        vars: { ...process.env, ...(vars ?? {}) } as Record<string, string>,
        concurrency: gate.value, slowMoMs, resolveRetryMs
      });
      return { content: [{ type: "text" as const, text: renderSuiteResult(result) }] };
    }
  );

  server.registerTool(
    "heal_step",
    {
      description:
        "修复一条 replay 失败的 trace：先 replay 拿到失败上下文，用 snapshot/batch 在失败页面上" +
        "找到正确操作，再把修正步作为 actions 传给本工具。服务端捕获定位描述符后，会在新标签页" +
        "全量重放整条 trace 做验证——全绿才写回，修好即永久生效（也可 dryRun 只验证不写回）。\n" +
        "修什么：只修「定位找不到/歧义/超时」（target-not-found/ambiguous/timeout）；assert-failed 一律拒绝" +
        "——断言失败可能是被测系统真 bug，自动改期望等于掩盖缺陷。\n" +
        "怎么修：actions 里用当前快照的 ref 演示修正步（1~3 步，替换失败的那 1 步）；元素只在瞬态出现、" +
        "演示不了时改用 step 传手写完整步骤 JSON。二者只能给一个。\n" +
        "预算：同一步最多 2 次尝试，一轮最多 3 处；超出请转人工。验证不通过会返回新的失败上下文，可继续修。\n" +
        "提示：一次 heal 只替换失败的那一步。要修多步就循环 replay → heal_step。",
      inputSchema: {
        tracePath: z.string().describe("trace 文件路径，与 replay 相同"),
        actions: z.array(z.record(z.any())).min(1).max(3).optional()
          .describe("修正步数组（主形态）：在失败页面上演示的 1~3 步，target 用 snapshot 返回的 ref"),
        step: z.record(z.any()).optional()
          .describe("手写完整步骤 JSON（逃生舱）：含 strategies 数组，用于演示不了的瞬态元素"),
        stepIndex: z.number().int().min(0).optional()
          .describe("要修复的 0-based 步号；省略则用该 trace 最近一次 replay 的失败步"),
        dryRun: z.boolean().optional()
          .describe("true 时只验证不写回（不落盘、不记 heal 历史、不耗预算），默认 false"),
        pageId: z.string().optional().describe("演示执行的页面，省略则用当前选中页"),
        vars: z.record(z.string()).optional().describe("变量表，供 ${VAR} 插值；凭证从这里传")
      }
    },
    async ({ tracePath, actions, step, stepIndex, dryRun, pageId, vars }) => {
      const hasActions = actions !== undefined;
      const hasStep = step !== undefined;
      if (hasActions === hasStep) {
        return { isError: true, content: [{ type: "text" as const,
          text: "actions 与 step 必须且只能提供一个：actions 传演示步数组，step 传手写完整步骤 JSON。" }] };
      }

      const trace = await loadTrace(tracePath);
      const lastRun = lastRunByTrace.get(tracePath);

      // stepIndex 缺省取最近一次 replay 的失败步；没有失败记录就拒绝猜测
      const k = stepIndex ?? lastRun?.failure?.failedIndex;
      if (k === undefined) {
        return { isError: true, content: [{ type: "text" as const,
          text: "该 trace 没有待修复的失败记录。请先 replay 让它失败一次，或显式传 stepIndex。" }] };
      }
      if (k >= trace.steps.length) {
        return { isError: true, content: [{ type: "text" as const,
          text: `stepIndex ${k} 超出范围：trace 只有 ${trace.steps.length} 步（0-based）。` }] };
      }

      const budget = healBudgets.get(tracePath) ?? { perStep: new Map<number, number>(), total: 0 };
      const gate = checkHealGate({ lastFailureKind: lastRun?.failure?.kind, budget, stepIndex: k });
      if (!gate.ok) {
        return { isError: true, content: [{ type: "text" as const, text: gate.reason }] };
      }

      const handle = await session.getPage(pageId);
      const collector = await DiagnosticsCollector.attach(handle);
      const tracker = await NetworkTracker.attach(handle);
      const refs = refTables.get(handle.pageId) ?? new Map<string, number>();

      const outcome = await runHeal({
        session, handle, tracker, collector, refs,
        tracePath, trace, stepIndex: k,
        demoSteps: (hasActions ? actions! : [step!]) as unknown as Step[],
        vars: { ...process.env, ...(vars ?? {}) } as Record<string, string>,
        dryRun: dryRun ?? false
      });
      refTables.set(handle.pageId, refs);

      if (outcome.status === "demo-failed") {
        return { isError: true, content: [{ type: "text" as const,
          text: renderDemoFailure(outcome.failure) }] };
      }

      if (outcome.status === "validation-failed") {
        // 验证失败计入预算；lastRun 保持原始失败记录（步号对应磁盘上的 trace）
        budget.perStep.set(k, (budget.perStep.get(k) ?? 0) + 1);
        budget.total += 1;
        healBudgets.set(tracePath, budget);
        return { isError: true, content: [{ type: "text" as const, text:
          `❌ 修复未通过验证门（第 ${k + 1} 步的修复在新标签页全量重放时仍失败），trace 未写回。\n\n` +
          renderRunRecord(outcome.validation) }] };
      }

      // healed：写回成功 → 验证 run-record 就是这条 trace 的最新状态，开启新一轮周期
      healBudgets.delete(tracePath);
      if (!outcome.dryRun) lastRunByTrace.set(tracePath, outcome.validation);
      const mode = outcome.dryRun ? "dry-run 验证通过（未写回）" : "已写回";
      return { content: [{ type: "text" as const, text:
        `✅ 自愈成功：第 ${k + 1} 步已由 ${(hasActions ? actions! : [step!]).length} 步修复替换，${mode}。\n\n` +
        renderRunRecord(outcome.validation) }] };
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
