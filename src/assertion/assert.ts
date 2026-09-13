import type { Step } from "../types.js";
import type { ActionContext } from "../executor/actions.js";
import { resolveTarget } from "../locator/resolve.js";

export class AssertionFailure extends Error {
  constructor(message: string, public actual: string, public expected: string) {
    super(message);
    this.name = "AssertionFailure";
  }
}

type AssertStep = Extract<Step, { action: "assert" }>;

export async function runAssert(ctx: ActionContext, step: AssertStep): Promise<void> {
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

  if (!step.target) throw new Error(`assert ${step.type} 缺少 target`);

  let backendNodeId: number | null = null;
  try {
    backendNodeId = (await resolveTarget(handle, step.target, ctx.refs)).backendNodeId;
  } catch {
    backendNodeId = null;
  }

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
