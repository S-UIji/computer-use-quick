import { z } from "zod";
import type { RunRecord, Step, Trace } from "../types.js";

/** stepIndex 始终使用磁盘上原 trace 的索引，不是此前替换扩展后的索引。 */
export interface TraceRepair {
  stepIndex: number;
  steps: Step[];
}

export interface RepairPlan {
  trace: Trace;
  /** 按原 stepIndex 升序排列。 */
  repairs: TraceRepair[];
  /** 候选 trace 的每一步对应的原步骤；repairIndex 指向排序后的 repairs。 */
  indexMap: Array<{ originalIndex: number; repairIndex?: number }>;
  /** 候选 trace 中每个替换块的范围，end 不包含在范围内。 */
  ranges: Array<{ stepIndex: number; start: number; end: number }>;
}

const nonempty = z.string().min(1);
const nonnegative = z.number().finite().nonnegative();
const nth = nonnegative.int().optional();
const strategySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("test-id"), value: nonempty }),
  z.object({ kind: z.literal("container-role-name"), containerText: nonempty, role: nonempty, name: z.string(), nth }),
  z.object({ kind: z.literal("row-role-name"), rowText: nonempty, role: nonempty, name: z.string(), nth }),
  z.object({ kind: z.literal("role-name"), role: nonempty, name: z.string(), nth }),
  z.object({ kind: z.literal("text"), tag: nonempty, text: z.string(), nth }),
  z.object({ kind: z.literal("css"), value: nonempty }),
  z.object({ kind: z.literal("xpath"), value: nonempty })
]);
const targetSchema = z.object({
  descriptor: z.object({
    strategies: z.array(strategySchema).min(1),
    framePath: z.array(nonempty),
    distinguishers: z.array(z.string()).optional()
  })
});
const waitSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("visible"), target: targetSchema }),
  z.object({ type: z.literal("hidden"), target: targetSchema }),
  z.object({ type: z.literal("url-contains"), value: z.string() }),
  z.object({ type: z.literal("response"), urlPattern: nonempty })
]);
const dialogFields = {
  dialog: z.enum(["accept", "dismiss"]).optional(),
  promptText: z.string().optional()
};

// 仅校验新增的替换步骤；不使用解析后的对象，避免 Zod 去掉合法的透传字段。
const stepSchema = z.discriminatedUnion("action", [
  z.object({ ...dialogFields, action: z.literal("navigate"), url: nonempty }),
  z.object({ ...dialogFields, action: z.literal("click"), target: targetSchema }),
  z.object({ ...dialogFields, action: z.literal("fill"), target: targetSchema, value: z.string(), sensitive: z.boolean().optional() }),
  z.object({ ...dialogFields, action: z.literal("select"), target: targetSchema, value: z.string() }),
  z.object({ ...dialogFields, action: z.literal("press"), key: nonempty }),
  z.object({ ...dialogFields, action: z.literal("hover"), target: targetSchema }),
  z.object({
    ...dialogFields, action: z.literal("scroll"), target: targetSchema.optional(),
    direction: z.enum(["up", "down"]).optional(), amount: nonnegative.optional()
  }),
  z.object({ ...dialogFields, action: z.literal("wait"), until: waitSchema, timeout: nonnegative.optional() }),
  z.object({ ...dialogFields, action: z.literal("sleep"), ms: nonnegative }),
  z.object({
    ...dialogFields, action: z.literal("assert"),
    type: z.enum(["visible", "hidden", "text-equals", "text-contains", "url-contains", "screenshot-match"]),
    target: targetSchema.optional(), expected: z.string().optional(),
    fullPage: z.boolean().optional(), threshold: nonnegative.max(1).optional()
  }),
  z.object({
    ...dialogFields, action: z.literal("extract"), target: targetSchema,
    as: nonempty, from: z.enum(["text", "value"]).optional()
  })
]).superRefine((step, context) => {
  if (step.action === "assert" && step.type !== "url-contains" &&
      !(step.type === "screenshot-match" && step.fullPage) && !step.target) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["target"], message: `assert ${step.type} 缺少 target` });
  }
});

function validateStep(step: Step, originalIndex: number, replacementIndex: number): void {
  const label = `原第 ${originalIndex + 1} 步的第 ${replacementIndex + 1} 个替换步骤`;
  // ref 即使与 descriptor 同时出现也拒绝：执行器优先使用 ref，不能靠 schema 忽略它。
  if (step && typeof step === "object") {
    const targets: unknown[] = [(step as { target?: unknown }).target];
    if (step.action === "wait" && step.until && typeof step.until === "object") {
      targets.push((step.until as { target?: unknown }).target);
    }
    if (targets.some((target) => target && typeof target === "object" && "ref" in target)) {
      throw new Error(`${label} 不能使用 ref；请提供可持久化的 descriptor`);
    }
  }
  const parsed = stepSchema.safeParse(step);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("；");
    throw new Error(`${label} 不合法：${details}`);
  }
}

/** 纯构造：不写磁盘、不执行浏览器动作，所有索引都从同一份原 trace 出发。 */
export function buildRepairPlan(trace: Trace, repairs: TraceRepair[]): RepairPlan {
  if (!Array.isArray(repairs) || repairs.length < 1 || repairs.length > 3) {
    throw new Error("修复点数量必须为 1 至 3 个");
  }
  const seen = new Set<number>();
  for (const repair of repairs) {
    if (!repair || !Number.isInteger(repair.stepIndex) ||
        repair.stepIndex < 0 || repair.stepIndex >= trace.steps.length) {
      throw new Error("修复 stepIndex 必须是原 trace 范围内的整数索引");
    }
    if (seen.has(repair.stepIndex)) throw new Error(`修复 stepIndex ${repair.stepIndex} 重复`);
    seen.add(repair.stepIndex);
    if (trace.steps[repair.stepIndex].action === "assert") {
      throw new Error(`原第 ${repair.stepIndex + 1} 步是 assert 断言，不能被修复替换`);
    }
    if (!Array.isArray(repair.steps) || repair.steps.length < 1 || repair.steps.length > 3) {
      throw new Error(`原第 ${repair.stepIndex + 1} 步必须替换为 1 至 3 个步骤`);
    }
    repair.steps.forEach((step, index) => validateStep(step, repair.stepIndex, index));
  }

  const sorted = repairs.map((repair) => ({ stepIndex: repair.stepIndex, steps: [...repair.steps] }))
    .sort((left, right) => left.stepIndex - right.stepIndex);
  const byOriginal = new Map(sorted.map((repair, repairIndex) => [repair.stepIndex, repairIndex]));
  const steps: Step[] = [];
  const indexMap: RepairPlan["indexMap"] = [];
  const ranges: RepairPlan["ranges"] = [];
  trace.steps.forEach((step, originalIndex) => {
    const repairIndex = byOriginal.get(originalIndex);
    if (repairIndex === undefined) {
      steps.push(step);
      indexMap.push({ originalIndex });
      return;
    }
    const start = steps.length;
    for (const replacement of sorted[repairIndex].steps) {
      steps.push(replacement);
      indexMap.push({ originalIndex, repairIndex });
    }
    ranges.push({ stepIndex: originalIndex, start, end: steps.length });
  });
  return { trace: { ...trace, steps }, repairs: sorted, indexMap, ranges };
}

/** 全块实际通过才算 passed；未开始和仅执行成功前缀都不能声称修复已验证。 */
export function assessRepairs(plan: RepairPlan, validation: RunRecord): Array<{
  stepIndex: number;
  status: "passed" | "failed" | "not-reached";
}> {
  const executed = new Map(validation.steps.map((step) => [step.index, step]));
  return plan.ranges.map((range) => {
    let complete = true;
    let failed = false;
    for (let index = range.start; index < range.end; index++) {
      const step = executed.get(index);
      if (!step) complete = false;
      else if (!step.ok) failed = true;
    }
    return { stepIndex: range.stepIndex, status: failed ? "failed" : complete ? "passed" : "not-reached" };
  });
}

/** 未执行的失败步（准备阶段关闭、步骤边界介入）不归因给修复或原步骤。 */
export function repairFailureLocation(plan: RepairPlan, validation: RunRecord): {
  originalIndex: number;
  repairIndex?: number;
} | undefined {
  const index = validation.failure?.failedIndex;
  if (index === undefined || !Number.isInteger(index) || !validation.steps.some((step) => step.index === index)) {
    return undefined;
  }
  const location = plan.indexMap[index];
  return location ? { ...location } : undefined;
}
