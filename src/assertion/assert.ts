import type { Step } from "../types.js";
import type { ActionContext } from "../executor/actions.js";
import { waitStable } from "../waiter/stability.js";
import { resolveTarget } from "../locator/resolve.js";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { baselineHash, decodePng, diffPng, encodePng } from "../perception/pngDiff.js";

export class AssertionFailure extends Error {
  constructor(message: string, public actual: string, public expected: string) {
    super(message);
    this.name = "AssertionFailure";
  }
}

type AssertStep = Extract<Step, { action: "assert" }>;

/** 截图前注入：冻结动画/过渡/光标闪烁，消除动态内容噪声（幂等） */
const FREEZE_CSS = `(function () {
  if (window.__cuqFreeze) return;
  window.__cuqFreeze = true;
  var s = document.createElement("style");
  s.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }";
  document.documentElement.appendChild(s);
})()`;

/**
 * screenshot-match：等待稳定 → 冻结动画 → 截图 → 基线不存在或更新模式则写基线通过，
 * 否则逐像素比对，超阈值抛 assert-failed 并把 actual/expected/diff 三图放进 artifacts。
 */
async function runScreenshotMatch(
  ctx: ActionContext,
  step: AssertStep,
  backendNodeId: number | null
): Promise<string | undefined> {
  const { handle } = ctx;
  const visual = ctx.visual ?? {};
  const dir = join(visual.baselineRoot ?? "traces/baselines", visual.traceName ?? "_explore");
  const hash = baselineHash(step.target, step.fullPage);
  const baselinePath = join(dir, `${hash}.png`);

  // 断言不走 runAction，得自己等稳定；随后冻结动画再截图
  await waitStable(handle, ctx.tracker, ctx.stability);
  await handle.cdp.send("Runtime.evaluate", { expression: FREEZE_CSS });

  let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
  if (!step.fullPage) {
    if (backendNodeId === null) {
      throw new AssertionFailure("视觉断言目标元素不存在", "(不存在)", "(基线)");
    }
    const { model } = (await handle.cdp.send("DOM.getBoxModel", { backendNodeId })) as {
      model?: { content: number[]; width: number; height: number };
    };
    if (!model || model.width <= 0 || model.height <= 0) {
      throw new AssertionFailure("视觉断言目标元素不可见", "(不可见)", "(基线)");
    }
    clip = { x: model.content[0], y: model.content[1], width: model.width, height: model.height, scale: 1 };
  }

  const { data } = (await handle.cdp.send("Page.captureScreenshot", {
    format: "png", ...(clip ? { clip } : {})
  })) as { data: string };
  const actualBuf = Buffer.from(data, "base64");

  await mkdir(dir, { recursive: true });
  const baselineExists = existsSync(baselinePath);
  if (visual.updateBaselines || !baselineExists) {
    await writeFile(baselinePath, actualBuf);
    return visual.updateBaselines && baselineExists ? "基线已更新" : "基线已创建";
  }

  const expectedBuf = await readFile(baselinePath);
  const threshold = step.threshold ?? 0.001;
  const { ratio, exceeded, diff, sizeMismatch } = diffPng(
    decodePng(actualBuf), decodePng(expectedBuf), { threshold }
  );
  if (!exceeded) return undefined;

  const base = `screenshot-${step.fullPage ? "full" : "el"}-${hash}`;
  ctx.artifacts?.push(
    { name: `${base}-actual.png`, base64: data },
    { name: `${base}-expected.png`, base64: expectedBuf.toString("base64") },
    { name: `${base}-diff.png`, base64: encodePng(diff).toString("base64") }
  );
  const sizeNote = sizeMismatch
    ? `（尺寸不一致：实际 ${sizeMismatch.actual.w}×${sizeMismatch.actual.h} vs 基线 ${sizeMismatch.expected.w}×${sizeMismatch.expected.h}）`
    : "";
  throw new AssertionFailure(
    `视觉差异 ${(ratio * 100).toFixed(3)}% 超过阈值 ${(threshold * 100).toFixed(3)}%${sizeNote}`,
    `${(ratio * 100).toFixed(3)}%`,
    `${(threshold * 100).toFixed(3)}%`
  );
}

export async function runAssert(ctx: ActionContext, step: AssertStep): Promise<string | undefined> {
  const { handle } = ctx;

  if (step.type === "url-contains") {
    const { result } = (await handle.cdp.send("Runtime.evaluate", {
      expression: "location.href",
      returnByValue: true
    })) as { result: { value: string } };
    if (!result.value.includes(step.expected ?? "")) {
      throw new AssertionFailure(
        `期望 url 包含「${step.expected}」，实际为「${result.value}」`,
        result.value,
        step.expected ?? ""
      );
    }
    return;
  }

  // 视觉断言：fullPage 可无 target，元素模式自行解析
  if (step.type === "screenshot-match") {
    if (!step.target && !step.fullPage) {
      throw new Error("assert screenshot-match 缺少 target（或设 fullPage: true）");
    }
    let nodeId: number | null = null;
    if (step.target) {
      try {
        nodeId = (await resolveTarget(handle, step.target, ctx.refs, { retryMs: ctx.resolveRetryMs })).backendNodeId;
      } catch { nodeId = null; }
      if (nodeId !== null) await ctx.onResolved?.(nodeId);
    }
    return await runScreenshotMatch(ctx, step, nodeId);
  }

  if (!step.target) throw new Error(`assert ${step.type} 缺少 target`);

  let backendNodeId: number | null = null;
  try {
    // hidden 断言不重试：目标不存在本就是它要断言的结果，白等一个重试预算纯属浪费
    const retryMs = step.type === "hidden" ? 0 : ctx.resolveRetryMs;
    backendNodeId = (await resolveTarget(handle, step.target, ctx.refs, { retryMs })).backendNodeId;
  } catch {
    backendNodeId = null;
  }
  // assert 不走 runAction，自己要触发固化回调，否则带 ref 的断言步进不了 trace。
  // 断言不改页面，此刻固化是安全的；hidden 断言目标不存在时跳过固化，
  // 由 batch 决定这一步不进 capturedSteps
  if (backendNodeId !== null) await ctx.onResolved?.(backendNodeId);

  const visible = await (async (): Promise<boolean> => {
    if (backendNodeId === null) return false;
    try {
      const { model } = (await handle.cdp.send("DOM.getBoxModel", { backendNodeId })) as {
        model?: { width: number; height: number };
      };
      return !!model && model.width > 0 && model.height > 0;
    } catch { return false; }
  })();

  if (step.type === "visible") {
    if (!visible) {
      throw new AssertionFailure("期望元素可见，实际不可见或不存在", "hidden", "visible");
    }
    return;
  }
  if (step.type === "hidden") {
    if (visible) throw new AssertionFailure("期望元素不可见，实际可见", "visible", "hidden");
    return;
  }

  if (backendNodeId === null) {
    throw new AssertionFailure("断言目标元素不存在", "(不存在)", step.expected ?? "");
  }

  const { object } = (await handle.cdp.send("DOM.resolveNode", { backendNodeId })) as {
    object: { objectId: string };
  };
  const { result } = (await handle.cdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: `function () { return (this.textContent || "").trim(); }`,
    returnByValue: true
  })) as { result: { value: string } };
  await handle.cdp.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});

  const actual = result.value;
  const expected = step.expected ?? "";
  const ok = step.type === "text-equals" ? actual === expected : actual.includes(expected);
  if (!ok) {
    throw new AssertionFailure(
      `期望文本${step.type === "text-equals" ? "等于" : "包含"}「${expected}」，实际为「${actual}」`,
      actual,
      expected
    );
  }
}
