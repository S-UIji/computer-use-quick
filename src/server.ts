import { readPageContext, renderPageContext } from "./session/pageContext.js";
import { validateStepsInput, validateStepInput, StepValidationError } from "./executor/stepValidation.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BrowserSession, PageHandle } from "./session/browser.js";
import { DialogGuard, describeDialog } from "./session/dialogs.js";
import { pageChangeNotice } from "./session/pageUrl.js";
import type { RunRecord, Step, FailureKind } from "./types.js";
import { takeSnapshot } from "./perception/snapshot.js";
import { diffLines, renderDiff } from "./perception/diff.js";
import { DiagnosticsCollector } from "./diagnostics/collector.js";
import { ExecutionDeadlineError, ExecutionQuarantinedError, validateStepTimeoutMs } from "./executor/deadline.js";
import { runBatch } from "./executor/batch.js";
import { resolveVariables, inspectVariables, MissingVariablesError, variableSourceNotice } from "./executor/variables.js";
import { saveTrace, loadTraceSnapshot, canonicalTracePath } from "./trace/store.js";
import { replayTrace, prepareExecution, preparationFailureRecord, captureFailureScreenshot } from "./trace/replay.js";
import {
  checkHealGate, runHeal, runMultiHeal, buildHealedTrace, renderDemoFailure, validationCountsAgainstBudget,
  HEALABLE_KINDS, MAX_HEALS_PER_TRACE, type HealBudget
} from "./trace/heal.js";
import { checkConcurrency, runSuite } from "./trace/suite.js";
import { buildRepairPlan, assessRepairs, repairFailureLocation, type TraceRepair } from "./trace/repairPlan.js";
import { archiveRun } from "./report/archive.js";
import { renderSuiteResult } from "./report/suiteReport.js";
import { renderRunRecord } from "./report/runRecord.js";
import { interruptionRecovery } from "./report/interruptionRecovery.js";
import { createVariableRedactor, redactVariableFailure, redactVariableSnapshot, redactVariableRecord } from "./report/variablePrivacy.js";
import { captureAuth, loadAuth, type AuthState } from "./session/auth.js";
import { RunWatch } from "./watch/runWatch.js";
import { ProgressReporter } from "./watch/progress.js";
import { SuiteProgress } from "./watch/suiteProgress.js";

const stepTimeoutSchema = z.number().int().min(100).max(300000).optional()
  .describe("单步骤整体执行预算（默认 30000ms，100~300000ms）；超时停止后续步骤，需要 snapshot 核实副作用。");

/** 最近一次 snapshot 的 ref 表，按 pageId 保存，供 batch 用 ref 指代元素 */
export const refTables = new Map<string, Map<string, number>>();
export const refLabelTables = new Map<string, Map<string, string>>();

/** 本 session 内每个页面成功执行过的步骤（ref 已固化成 descriptor），供 save_trace 消费 */
export const sessionSteps = new Map<string, Step[]>();

/** 每个 trace 最近一次 replay 的 run-record，供 heal_step 缺省定位失败步与白名单判定 */
export const lastRunByTrace = new Map<string, RunRecord>();

/** 每个 trace 的自愈预算；replay 全绿时清零，开启新一轮修复周期 */
export const healBudgets = new Map<string, HealBudget>();

/** 每个 pageId 上一次 snapshot 的渲染文本，snapshot diff 的对比基线 */
export const lastSnapshots = new Map<string, string>();

/** session 默认认证态：save_auth 设置，replay/suite/heal 注入链路共享 */
let sessionAuth: AuthState | undefined;

/** auth 解析：显式路径优先，否则 session 默认；显式路径加载失败返回错误文案 */
async function resolveAuth(
  explicitPath?: string
): Promise<{ auth?: AuthState; error?: string }> {
  if (explicitPath === undefined) return { auth: sessionAuth };
  const auth = await loadAuth(explicitPath);
  return auth
    ? { auth }
    : { error: `auth 文件 ${explicitPath} 不存在或结构非法` };
}

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

/** 会话步骤规模告警阈值：超过即在 batch/save_trace 响应中显形（只提示，不动数据） */
export const STEP_WARN_THRESHOLD = 200;

/** 超阈值时的告警行；未超返回 undefined（纯函数，便于单测） */
export function stepOverflowWarning(count: number): string | undefined {
  return count > STEP_WARN_THRESHOLD
    ? `⚠ 本页已记录 ${count} 步（超过 ${STEP_WARN_THRESHOLD}）：` +
      `探索弯路请先 discard_steps 再 save_trace，避免弯路固化进 trace`
    : undefined;
}

/**
 * 本次返回的告警前缀：会话告知（重连、自动拉起）+ 取页时处理掉的「两次调用之间弹出的窗」。
 * 处理分别在 BrowserSession / getPage 里完成，这里只负责报告；没有则为空串
 */
function notices(session: BrowserSession, handle?: PageHandle): string {
  const lines: string[] = [];
  const n = session.takeNotice();
  if (n) lines.push(`⚠ ${n}`);
  if (handle) {
    for (const d of DialogGuard.for(handle)?.takeHandled() ?? []) lines.push(`⚠ ${describeDialog(d)}`);
  }
  return lines.length ? lines.join("\n") + "\n\n" : "";
}

export function createServer(session: BrowserSession): McpServer {
  const server = new McpServer({ name: "computer-use-quick", version: "0.1.0" });
  // 只在本服务实例内保存原始 URL，避免不同会话的观察基线串扰。
  const observedUrls = new Map<string, string>();
  const healingTraces = new Set<string>();
  const healEvidence = new Map<string, { fingerprint: string; failures: Map<number, FailureKind>; retryBlocked?: boolean }>();
  const rememberRun = (path: string, fingerprint: string, record: RunRecord): void => {
    lastRunByTrace.set(path, record);
    if (record.ok) {
      healBudgets.delete(path);
      healEvidence.delete(path);
      return;
    }
    const previous = healEvidence.get(path);
    if (previous && previous.fingerprint !== fingerprint) healBudgets.delete(path);
    const evidence = previous?.fingerprint === fingerprint
      ? previous : { fingerprint, failures: new Map<number, FailureKind>(), retryBlocked: false };
    evidence.retryBlocked = !!record.failure?.retryBlocked;
    if (record.failure && !record.failure.retryBlocked) evidence.failures.set(record.failure.failedIndex, record.failure.kind);
    healEvidence.set(path, evidence);
  };

  server.registerTool(
    "snapshot",
    {
      description:
        "返回当前页面的精简可交互元素快照（替代截图）。结构相同的兄弟节点会被折叠，" +
        "用 expand 传入折叠组 id 可展开查看完整细节。",
      inputSchema: {
        pageId: z.string().optional().describe("目标页面 id，省略则用当前选中页"),
        expand: z.array(z.string()).optional().describe("要展开的折叠组 id 列表"),
        threshold: z.number().int().min(2).optional().describe("折叠阈值，默认 3"),
        diff: z.boolean().optional()
          .describe("true 时返回与上一次快照的行级增量（新增/消失），新元素带 ref 可直接操作")
      }
    },
    async ({ pageId, expand, threshold, diff }) => {
      const handle = await session.getPage(pageId);
      const notice = notices(session, handle);
      // 尽早挂上采集器，否则第一次失败时拿不到之前的 console 报错
      await DiagnosticsCollector.attach(handle);
      const snap = await takeSnapshot(handle, { expand, threshold });
      refTables.set(handle.pageId, snap.refs);
      refLabelTables.set(handle.pageId, snap.refLabels);
      observedUrls.set(handle.pageId, handle.page.url());

      // 任何参数的 snapshot 都刷新 diff 基线
      const prev = lastSnapshots.get(handle.pageId);
      lastSnapshots.set(handle.pageId, snap.text);

      if (diff) {
        return { content: [{ type: "text" as const, text: notice + renderDiff(diffLines(
          prev === undefined ? null : prev.split("\n"),
          snap.text.split("\n")
        )) }] };
      }

      return {
        content: [{
          type: "text" as const,
          text: notice +
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
        "JS 弹窗自动处理，结果里会写明弹窗内容与处理方式：confirm/prompt 默认确定，" +
        "要取消就在该步加 \"dialog\":\"dismiss\"，prompt 要填的文本用 \"promptText\"；alert 与离开页面确认总是放行。\n" +
        "target 用 snapshot 返回的 ref（{\"ref\":\"e3\"}）或 descriptor。\n" +
        "提示：快照里被折叠的组，组内元素没有 ref，但【不需要先 expand】——" +
        "直接用 container-role-name 定位即可，containerText 取组内条目的文字、name 取 fields 里的项，" +
        "例如 {\"descriptor\":{\"strategies\":[{\"kind\":\"container-role-name\"," +
        "\"containerText\":\"教育事业群\",\"role\":\"button\",\"name\":\"查看在岗干部明细\"}],\"framePath\":[]}}。",
      inputSchema: {
        pageId: z.string().optional(),
        steps: z.array(z.unknown()).min(1).describe("步骤数组，见 description"),
        stepTimeoutMs: stepTimeoutSchema,
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
    async ({ pageId, steps, vars, stability, resolveRetryMs, stepTimeoutMs }, extra) => {
      try { validateStepTimeoutMs(stepTimeoutMs); validateStepsInput(steps); }
      catch (error) {
        if (!(error instanceof StepValidationError)) throw error;
        return { isError: true, content: [{ type: "text" as const, text: error.message }] };
      }
      const variableState = resolveVariables(vars);
      const variableCheck = inspectVariables(steps as Step[], variableState.values, variableState.environmentNames);
      let redact = createVariableRedactor(variableState.values, variableCheck.environmentUsed);
      const handle = await session.getPage(pageId);
      const notice = variableSourceNotice(variableCheck.environmentUsed) +
        redact(pageChangeNotice(observedUrls.get(handle.pageId), handle.page.url()) + notices(session, handle));
      let prepared: Awaited<ReturnType<typeof prepareExecution>>;
      try { prepared = await prepareExecution(handle); }
      catch (error) {
        if (!(error instanceof ExecutionDeadlineError) && !(error instanceof ExecutionQuarantinedError)) throw error;
        return { isError: true, content: [{ type: "text" as const,
          text: notice + "执行前准备未完成，尚未开始任何步骤；准备超时或页面需要恢复。\n" + redact(error.message) }] };
      }
      const { collector, tracker } = prepared;
      const refs = refTables.get(handle.pageId) ?? new Map<string, number>();

      const watch = new RunWatch({
        handle, label: "探索", watch: session.watchEnabled, progress: ProgressReporter.from(extra),
        refLabels: refLabelTables.get(handle.pageId)
      });
      const r = await runBatch({
        handle, tracker, collector, refs, refLabels: refLabelTables.get(handle.pageId),
        vars: variableState.values, environmentNames: variableState.environmentNames,
        steps: steps as unknown as Step[],
        stability, resolveRetryMs, stepTimeoutMs,
        observer: watch
      });
      redact = createVariableRedactor(variableState.values, variableCheck.environmentUsed, r.variableRedactions);
      refTables.set(handle.pageId, refs);
      recordSteps(handle.pageId, r.capturedSteps);
      if (r.refLabels) refLabelTables.set(handle.pageId, r.refLabels);
      // 成功与步骤失败都已把现场返回给调用方，以批次终态作为下一次比较基线。
      observedUrls.set(handle.pageId, handle.page.url());
      const pageRedact = createVariableRedactor(variableState.values,
        [...variableCheck.environmentUsed, ...Object.keys(vars ?? {})], r.variableRedactions);
      const pageContext = renderPageContext(await readPageContext(handle), pageRedact);

      if (r.ok) {
        const total = r.results.reduce((a, s) => a + s.durationMs, 0);
        const warnings = r.results.filter((s) => s.error).map((s) => `第 ${s.index + 1} 步：${redact(s.error!)}`);
        const overflow = stepOverflowWarning(sessionSteps.get(handle.pageId)?.length ?? 0);
        if (overflow) warnings.push(overflow);
        if (watch.setupWarning) warnings.push(watch.setupWarning);
        return { content: [{ type: "text" as const, text: notice +
          `✅ ${r.results.length} 步全部成功（合计 ${total}ms）\n` +
          (warnings.length ? `\n⚠ ${warnings.join("\n⚠ ")}\n` : "") +
          "\n" + pageContext + `## 执行后快照\n${redactVariableSnapshot(r.snapshot, redact)}` }] };
      }

      const f = redactVariableFailure(r.failure!, redact);
      const head = f.kind === "user-interrupted"
        ? `✋ 第 ${f.failedIndex + 1} 步：user-interrupted（被用户打断，不是页面问题）`
        : `❌ 第 ${f.failedIndex + 1} 步失败：${f.kind}`;
      // isError 让客户端在协议层就能看出失败，不必去解析文案
      return { isError: true, content: [{ type: "text" as const, text: notice +
        `${head}\n${f.message}\n\n` +
        interruptionRecovery(f, "batch") +
        pageContext +
        (watch.setupWarning ? `⚠ ${watch.setupWarning}\n\n` : "") +
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
      const notice = notices(session);
      const current = session.currentPageId() ?? (session.needsPageRecovery ? undefined : pages[0]?.pageId);
      const lines = pages.map((p) =>
        `${p.pageId === current ? "*" : " "} ${p.pageId}\n    ${p.title || "(无标题)"}\n    ${p.url}`
      );
      return { content: [{ type: "text" as const, text: notice +
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
      const notice = notices(session, handle);
      const n = discardSteps(handle.pageId, count);
      const left = sessionSteps.get(handle.pageId)?.length ?? 0;
      return { content: [{ type: "text" as const,
        text: `${notice}已丢弃 ${n} 步，本页还剩 ${left} 步已记录步骤。` }] };
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
      const notice = notices(session, handle);
      const steps = sessionSteps.get(handle.pageId) ?? [];
      if (steps.length === 0) {
        return { content: [{ type: "text" as const,
          text: notice + "本 session 尚无成功执行的步骤，无可保存内容。" }] };
      }
      const path = await saveTrace(dir ?? "./traces", {
        name, baseUrl, createdAt: new Date().toISOString(), steps
      });
      const overflow = stepOverflowWarning(steps.length);
      return { content: [{ type: "text" as const, text: notice +
        `已保存 ${steps.length} 步到 ${path}` + (overflow ? `\n${overflow}` : "") }] };
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
        stepTimeoutMs: stepTimeoutSchema,
        vars: z.record(z.string()).optional().describe("变量表，凭证从这里传"),
        slowMoMs: z.number().int().min(0).optional()
          .describe("每步之间的延迟，演示场景用，默认 0"),
        resolveRetryMs: z.number().int().min(0).optional()
          .describe("目标解析的轮询重试预算，默认 3000ms；传 0 恢复一次性解析"),
        pageId: z.string().optional(),
        auth: z.string().optional()
          .describe("认证态文件路径；省略则用 save_auth 设置的 session 默认"),
        updateBaselines: z.boolean().optional()
          .describe("true 时重录全部视觉基线并一律通过（页面改版属预期时用），默认 false")
      }
    },
    async ({ tracePath, vars, slowMoMs, resolveRetryMs, stepTimeoutMs, pageId, auth, updateBaselines }, extra) => {
      validateStepTimeoutMs(stepTimeoutMs);
      const startedAt = Date.now();
      tracePath = await canonicalTracePath(tracePath);
      const { trace, fingerprint } = await loadTraceSnapshot(tracePath);
      const variableState = resolveVariables(vars);
      const variableCheck = inspectVariables(trace.steps, variableState.values, variableState.environmentNames);
      if (variableCheck.missing.length) {
        return { isError: true, content: [{ type: "text" as const,
          text: notices(session) + new MissingVariablesError(variableCheck.missing).message }] };
      }
      const { auth: authState, error: authError } = await resolveAuth(auth);
      if (authError) {
        return { isError: true, content: [{ type: "text" as const, text: notices(session) + authError }] };
      }
      let handle: PageHandle | undefined;
      let collector: DiagnosticsCollector | undefined;
      let watch: RunWatch | undefined;
      let rec: RunRecord;
      let notice = variableSourceNotice(variableCheck.environmentUsed);
      try {
        handle = await session.getPage(pageId);
        notice += notices(session, handle);
        const prepared = await prepareExecution(handle, authState);
        collector = prepared.collector;
        collector.clear();
        watch = new RunWatch({
          handle, label: trace.name, watch: session.watchEnabled,
          progress: ProgressReporter.from(extra), progressPrefix: `${trace.name} · `
        });
        rec = await replayTrace({
          handle, tracker: prepared.tracker, collector, trace, slowMoMs, resolveRetryMs, stepTimeoutMs,
          vars: variableState.values, environmentNames: variableState.environmentNames,
          visual: { traceName: trace.name, updateBaselines }, observer: watch
        });
      } catch (error) {
        const failure = preparationFailureRecord(trace, error, startedAt, handle);
        if (!failure) throw error;
        rec = redactVariableRecord(failure, createVariableRedactor(variableState.values,
          [...variableCheck.environmentUsed, ...Object.keys(vars ?? {})]));
      }
      // 截图收尾超时不覆盖主失败；其隔离状态必须先记入自愈证据。
      let screenshot: string | undefined;
      if (collector && handle) {
        const captured = await captureFailureScreenshot(handle, collector, rec);
        rec = captured.record;
        screenshot = captured.screenshot;
      }
      // 全绿 = 新一轮修复周期开始，自愈预算清零；失败则记下，供 heal_step 消费。
      rememberRun(tracePath, fingerprint, rec);
      await archiveRun({ traceName: trace.name, record: rec, trace, screenshotBase64: screenshot });

      return { content: [{ type: "text" as const,
        text: notice + renderRunRecord(rec) + (watch?.setupWarning ? `\n\n⚠ ${watch.setupWarning}` : "") }] };
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
        stepTimeoutMs: stepTimeoutSchema,
        concurrency: z.number().int().min(1).optional()
          .describe("并发数，默认 3，硬上限 8；1 即串行"),
        vars: z.record(z.string()).optional().describe("变量表，全部用例共享；凭证从这里传"),
        slowMoMs: z.number().int().min(0).optional().describe("每步之间的延迟，演示用"),
        resolveRetryMs: z.number().int().min(0).optional()
          .describe("目标解析的轮询重试预算，默认 3000ms"),
        auth: z.string().optional()
          .describe("认证态文件路径；省略则用 save_auth 设置的 session 默认"),
        updateBaselines: z.boolean().optional()
          .describe("true 时重录全部视觉基线并一律通过，默认 false")
      }
    },
    async ({ tracePaths, concurrency, vars, slowMoMs, resolveRetryMs, stepTimeoutMs, auth, updateBaselines }, extra) => {
      validateStepTimeoutMs(stepTimeoutMs);
      // 上限校验前置：不建任何浏览器资源就拒绝
      const gate = checkConcurrency(concurrency);
      if (!gate.ok) {
        return { isError: true, content: [{ type: "text" as const, text: gate.reason }] };
      }
      const progress = ProgressReporter.from(extra);
      const suiteProgress = new SuiteProgress(progress, tracePaths.length);
      suiteProgress.start();
      try {
        const { auth: authState, error: authError } = await resolveAuth(auth);
        if (authError) {
          return { isError: true, content: [{ type: "text" as const, text: authError }] };
        }
        const variableState = resolveVariables(vars);
        const result = await runSuite({
          session, paths: await Promise.all(tracePaths.map(canonicalTracePath)),
          vars: variableState.values, environmentNames: variableState.environmentNames,
          concurrency: gate.value, slowMoMs, resolveRetryMs, stepTimeoutMs, auth: authState, updateBaselines,
          observerFor: (handle, name) => new RunWatch({ handle, label: name, watch: session.watchEnabled }),
          onTraceEvent: progress.enabled ? event => suiteProgress.accept(event) : undefined
        });
        // 合并仅影响报告；各路径的完整运行证据仍独立记账。
        for (const trace of result.results) {
          if (trace.record && trace.traceFingerprint) rememberRun(trace.path, trace.traceFingerprint, trace.record);
        }
        return { isError: result.preflightFailed || undefined, content: [{ type: "text" as const,
          text: notices(session) + variableSourceNotice(result.environmentUsed ?? []) + renderSuiteResult(result) }] };
      } finally { suiteProgress.dispose(); }
    }
  );

  server.registerTool(
    "heal_step",
    {
      description:
        "修复 replay 失败的 trace：actions/step 单点演示捕获 descriptor，或 repairs 一次提交多处稳定步骤。" +
        "独立 Context 全量重放全绿才原子写回；dryRun 只验证，不写回、不消耗或清除预算。\n" +
        "只修有同一原文件失败证据的定位找不到/歧义/超时；原始 assert 与 assert-failed 均拒修。" +
        "候选暴露后续原步骤故障时会保留新证据，并返回可继续合并的 repairs。\n" +
        "actions/step/repairs 三选一。repairs 每项 stepIndex 是原文件的 0-based 步号，" +
        "每次 1~3 处、每处 1~3 steps，需要目标时必须用 descriptor（含 wait.until.target），禁止 ref。" +
        "repairs 与顶层 stepIndex 互斥。actions 可用当前 snapshot 的 ref 演示。\n" +
        "预算：同一原始点最多 2 次、周期最多 3 次失败修复验证；只计实际失败的替换块，" +
        "已通过修复不为后续原步骤失败扣次数。页面关闭、用户打断和演示失败不计。",
      inputSchema: {
        tracePath: z.string().describe("trace 文件路径，与 replay 相同"),
        stepTimeoutMs: stepTimeoutSchema,
        actions: z.array(z.unknown()).min(1).max(3).optional()
          .describe("单点演示的 1~3 步，target 可用 snapshot 返回的 ref"),
        step: z.unknown().optional().describe("单点手写完整步骤，目标用稳定 descriptor"),
        stepIndex: z.number().int().min(0).optional()
          .describe("单点修复的原文件 0-based 步号；省略用最近 replay 失败步"),
        repairs: z.array(z.object({
          stepIndex: z.number().int().min(0),
          steps: z.array(z.unknown()).min(1).max(3)
        }).strict()).min(1).max(3).optional()
          .describe("同时替换原文件的 1~3 处步骤；所有目标必须为稳定 descriptor，禁止 ref"),
        dryRun: z.boolean().optional().describe("只验证，不写回、不追加审计、不消耗或清除预算"),
        pageId: z.string().optional().describe("仅用于 actions/step 的演示页；repairs 使用独立验证页"),
        auth: z.string().optional().describe("认证态路径；省略用 session 默认"),
        vars: z.record(z.string()).optional().describe("变量表，供 ${VAR} 插值；凭证从这里传")
      }
    },
    async ({ tracePath, actions, step, stepIndex, repairs, dryRun = false, stepTimeoutMs, pageId, auth, vars }, extra) => {
      validateStepTimeoutMs(stepTimeoutMs);
      const fail = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });
      tracePath = await canonicalTracePath(tracePath);
      if (healingTraces.has(tracePath)) return fail("该 trace 正在自愈，请等待当前调用结束后重试（未计自愈次数）。");
      healingTraces.add(tracePath);
      try {
        if ([actions, step, repairs].filter((value) => value !== undefined).length !== 1 ||
            (repairs !== undefined && stepIndex !== undefined)) {
          return fail("actions、step 与 repairs 必须且只能提供一个；repairs 与顶层 stepIndex 互斥。");
        }
        if (actions !== undefined) validateStepsInput(actions);
        if (step !== undefined) validateStepInput(step, "修复步骤");
        if (repairs !== undefined) {
          for (const repair of repairs) validateStepsInput(repair.steps);
        }
        const { trace, fingerprint } = await loadTraceSnapshot(tracePath);
        const lastRun = lastRunByTrace.get(tracePath);
        const k = stepIndex ?? lastRun?.failure?.failedIndex;
        if (repairs === undefined && k === undefined) {
          return fail("该 trace 没有待修复的失败记录。请先 replay 让它失败一次。");
        }
        const evidence = healEvidence.get(tracePath);
        if (evidence && evidence.fingerprint !== fingerprint) {
          return fail("trace 文件已改变，旧失败证据已失效；请对当前文件重新 replay。");
        }

        const budget = healBudgets.get(tracePath) ?? { perStep: new Map<number, number>(), total: 0 };
        const indices = repairs?.map((repair) => repair.stepIndex) ?? [k!];
        if (new Set(indices).size !== indices.length) return fail("repairs 中 stepIndex 重复。");
        for (const index of indices) {
          if (index < 0 || index >= trace.steps.length) {
            return fail(`stepIndex ${index} 超出范围：trace 只有 ${trace.steps.length} 步（0-based）。`);
          }
          if (trace.steps[index].action === "assert") {
            return fail(`原第 ${index + 1} 步是断言，不可自动修复；断言失败可能是被测系统缺陷，需人工判定。`);
          }
          const gate = checkHealGate({
            lastFailureKind: evidence?.failures.get(index), budget, stepIndex: index,
            retryBlocked: evidence?.retryBlocked || lastRun?.failure?.retryBlocked
          });
          if (!gate.ok) return fail(`原第 ${index + 1} 步（stepIndex=${index}）：${gate.reason}`);
        }
        const stableRepairs = repairs as TraceRepair[] | undefined;
        // 稳定步骤形态在任何页面动作前完成完整校验；actions 在捕获 descriptor 后校验。
        if (stableRepairs) buildRepairPlan(trace, stableRepairs);
        if (step) buildRepairPlan(trace, [{ stepIndex: k!, steps: [step as Step] }]);
        const demoSteps = (actions ?? (step ? [step] : [])) as Step[];
        const variableState = resolveVariables(vars);
        const candidate = stableRepairs
          ? buildRepairPlan(trace, stableRepairs).trace
          : buildHealedTrace(trace, k!, demoSteps);
        const checks = [
          inspectVariables(candidate.steps, variableState.values, variableState.environmentNames),
          ...(!stableRepairs ? [inspectVariables(demoSteps, variableState.values, variableState.environmentNames)] : [])
        ];
        const missing = [...new Set(checks.flatMap((check) => check.missing))].sort();
        if (missing.length) return fail(new MissingVariablesError(missing).message);
        const sourceNotice = variableSourceNotice(checks.flatMap((check) => check.environmentUsed));
        const { auth: authState, error: authError } = await resolveAuth(auth);
        if (authError) return fail(authError);

        const progress = ProgressReporter.from(extra);
        const allRepairs = stableRepairs ?? [{ stepIndex: k!, steps: demoSteps }];
        const candidateCount = trace.steps.length - allRepairs.length +
          allRepairs.reduce((sum, repair) => sum + repair.steps.length, 0);
        const demoCount = stableRepairs ? 0 : demoSteps.length;
        const healTotal = demoCount + candidateCount;
        const common = {
          session, tracePath, trace, expectedFingerprint: fingerprint,
          vars: variableState.values, environmentNames: variableState.environmentNames,
          dryRun, stepTimeoutMs, auth: authState,
          validationObserverFor: (vHandle: PageHandle) => new RunWatch({
            handle: vHandle, label: "自愈验证", watch: session.watchEnabled,
            progress, progressPrefix: "验证门 · 全量重放 ", progressOffset: demoCount, progressTotal: healTotal
          })
        };
        let notice: string;
        let outcome: Awaited<ReturnType<typeof runHeal>>;
        if (stableRepairs) {
          notice = sourceNotice + notices(session);
          outcome = await runMultiHeal({ ...common, repairs: stableRepairs });
        } else {
          const handle = await session.getPage(pageId);
          notice = sourceNotice + notices(session, handle);
          let prepared: Awaited<ReturnType<typeof prepareExecution>>;
          try { prepared = await prepareExecution(handle); }
          catch (error) {
            if (!(error instanceof ExecutionDeadlineError) && !(error instanceof ExecutionQuarantinedError)) throw error;
            if (evidence && healEvidence.get(tracePath) === evidence) evidence.retryBlocked = true;
            const redact = createVariableRedactor(variableState.values, checks.flatMap(check => check.environmentUsed));
            return fail(notice + "自愈演示的执行前准备未完成；准备超时或页面需要恢复。trace 未写回、未计自愈次数。\n" + redact(error.message));
          }
          const { collector, tracker } = prepared;
          const refs = refTables.get(handle.pageId) ?? new Map<string, number>();
          const refLabels = refLabelTables.get(handle.pageId) ?? new Map<string, string>();
          outcome = await runHeal({
            ...common, handle, tracker, collector, refs, refLabels, stepIndex: k!, demoSteps,
            demoObserver: new RunWatch({
              handle, label: `自愈演示 · 第 ${k! + 1} 步`, watch: session.watchEnabled,
              refLabels,
              progress, progressPrefix: "演示修正步 ", progressTotal: healTotal
            })
          });
          refTables.set(handle.pageId, refs);
          refLabelTables.set(handle.pageId, refLabels);
        }
        if (outcome.status === "rejected") return fail(notice + outcome.reason);
        if (outcome.status === "demo-failed") {
          if (outcome.failure.retryBlocked && evidence && healEvidence.get(tracePath) === evidence) evidence.retryBlocked = true;
          return fail(notice + renderDemoFailure(outcome.failure));
        }
        const { plan, validation } = outcome;
        const states = assessRepairs(plan, validation).map((repair) => {
          const label = { passed: "已通过", failed: "仍失败", "not-reached": "未完整执行" }[repair.status];
          return `- 原第 ${repair.stepIndex + 1} 步（stepIndex=${repair.stepIndex}）：${repair.status}（${label}）`;
        }).join("\n");

        if (outcome.status === "validation-failed") {
          const location = repairFailureLocation(plan, validation);
          const failure = validation.failure;
          // failed candidate 的步号不写入 lastRun；只学习未替换原步骤的失败证据。
          const sameCycle = healEvidence.get(tracePath) === evidence;
          if (sameCycle && failure?.retryBlocked) evidence!.retryBlocked = true;
          if (sameCycle && location && location.repairIndex === undefined && failure && !failure.retryBlocked && HEALABLE_KINDS.has(failure.kind)) {
            evidence!.failures.set(location.originalIndex, failure.kind);
          }
          const charged = sameCycle && !dryRun && validationCountsAgainstBudget(validation) &&
            location?.repairIndex !== undefined;
          if (charged) {
            const index = location!.originalIndex;
            budget.perStep.set(index, (budget.perStep.get(index) ?? 0) + 1);
            budget.total += 1;
            healBudgets.set(tracePath, budget);
          }
          const blocker = location && failure
            ? `阻塞点：原第 ${location.originalIndex + 1} 步（stepIndex=${location.originalIndex}），` +
              `候选第 ${failure.failedIndex + 1} 步（index=${failure.failedIndex}）；` +
              (location.repairIndex === undefined ? "未替换的原步骤失败。" : "该修复块失败。")
            : "验证未完整执行，无法据此认定修复已通过。";
          const interruption = failure?.kind === "page-closed"
            ? "自愈验证的标签页已关闭；恢复页面后重新运行。\n"
            : failure?.kind === "user-interrupted" ? "✋ 验证被用户打断，trace 未写回。\n" : "";
          const accounting = charged
            ? `仅原第 ${location!.originalIndex + 1} 步计自愈次数；本轮已用 ${budget.total}/${MAX_HEALS_PER_TRACE}。\n`
            : "未计自愈次数，已有预算保持不变。\n";
          const repairHint = failure?.retryBlocked
            ? "本次运行需要人工恢复；请按失败提示恢复页面或连接、snapshot 核实副作用，再 replay 获取新证据。以下参数仅供核对，勿直接重试："
            : failure?.kind === "user-interrupted"
            ? "保留以下稳定修复步骤；用户操作完成并核实状态后重新提交："
            : "可复用以下稳定修复步骤；补齐其他已确认故障后一起提交：";
          return fail(notice + `❌ ${dryRun ? "dry-run " : ""}修复未通过验证门，trace 未写回。\n` +
            interruption + blocker + "\n" + accounting + states +
            "\n\n" + repairHint + "\n\n" +
            "```json\n" + JSON.stringify({ repairs: plan.repairs }, null, 2) + "\n```\n\n" +
            "以下 run-record 使用候选步号：\n" + renderRunRecord(validation, "heal"));
        }
        if (!outcome.dryRun) {
          healBudgets.delete(tracePath);
          healEvidence.delete(tracePath);
          lastRunByTrace.set(tracePath, validation);
        }
        const mode = outcome.dryRun ? "dry-run 验证通过（未写回，预算保持不变）" : "已写回";
        progress.report(healTotal, healTotal, mode);
        return { content: [{ type: "text" as const, text: notice +
          `✅ 自愈成功：${plan.repairs.length} 处修复全量验证通过，${mode}。\n` +
          (outcome.auditWarning ? `⚠ ${outcome.auditWarning}\n` : "") +
          states + "\n\n" + renderRunRecord(validation, "heal") }] };
      } finally {
        healingTraces.delete(tracePath);
      }
    }
  );

  server.registerTool(
    "save_auth",
    {
      description:
        "把当前页面的登录态（cookie + localStorage）保存为认证态文件并设为 session 默认。" +
        "replay/replay_suite/heal 验证门会自动注入，用例不必每次从头登录。" +
        "文件含凭证邻接数据，必须保持 gitignore（.cuq/）。登录过期后重新调用本工具即可。",
      inputSchema: {
        path: z.string().optional().describe("保存路径，默认 ./.cuq/auth.json"),
        pageId: z.string().optional()
      }
    },
    async ({ path, pageId }) => {
      const handle = await session.getPage(pageId);
      const notice = notices(session, handle);
      const auth = await captureAuth(handle);
      const p = path ?? "./.cuq/auth.json";
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, JSON.stringify(auth, null, 2) + "\n", "utf8");
      sessionAuth = auth;
      const lsCount = auth.origins.reduce((a, o) => a + Object.keys(o.localStorage).length, 0);
      return { content: [{ type: "text" as const, text: notice +
        `已保存认证态到 ${p}（cookie ${auth.cookies.length} 条，localStorage ${lsCount} 项）。` +
        `后续 replay/replay_suite/heal 默认注入；登录过期后重新调用本工具。` }] };
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
      const notice = notices(session, handle);
      const c = await DiagnosticsCollector.attach(handle);
      const parts: Array<
        { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
      > = [
        {
          type: "text",
          text: notice +
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
