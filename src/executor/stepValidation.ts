import { z } from "zod";
import type { Step } from "../types.js";

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
const descriptorSchema = z.object({
  strategies: z.array(strategySchema).min(1),
  framePath: z.array(nonempty),
  distinguishers: z.array(z.string()).optional()
});
const targetSchema = z.object({
  ref: nonempty.optional(), descriptor: descriptorSchema.optional()
}).superRefine((target, context) => {
  // 执行器按 ref 键是否存在分支，显式 undefined 不能借 descriptor 绕过校验。
  if ("ref" in target && target.ref === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["ref"], message: "应为非空字符串" });
  } else if (target.ref === undefined && target.descriptor === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "应为 { ref: 非空字符串 } 或 { descriptor: 定位描述 }"
    });
  }
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

// 只校验原始对象，不使用 Zod 解析产物，保留插值和合法透传字段。
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
  if (step.action !== "assert") return;
  if (step.type !== "url-contains" &&
      !(step.type === "screenshot-match" && step.fullPage) && !step.target) {
    context.addIssue({
      code: z.ZodIssueCode.custom, path: ["target"],
      message: "需要 target（截图断言可设置 fullPage: true）"
    });
  }
  if (["text-equals", "text-contains", "url-contains"].includes(step.type) && step.expected === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["expected"], message: "应为字符串，可为空字符串" });
  }
});

export class StepValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepValidationError";
  }
}

/** 不使用 issue.message：Zod 的 enum 错误可能回显凭证等非法输入值。 */
function expectedFormat(issue: z.ZodIssue): string {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type: {
      const names: Record<string, string> = {
        string: "字符串", number: "有限且非负数", integer: "非负整数",
        object: "对象", array: "数组", boolean: "布尔值"
      };
      return `应为${names[issue.expected] ?? "合法字段类型"}`;
    }
    case z.ZodIssueCode.invalid_union_discriminator:
    case z.ZodIssueCode.invalid_enum_value:
      return `应为以下值之一：${issue.options.join("、")}`;
    case z.ZodIssueCode.too_small:
      if (issue.type === "string") return "应为非空字符串";
      if (issue.type === "array") return "应为至少包含 1 项的数组";
      return "应为有限且非负数";
    case z.ZodIssueCode.too_big:
      return "应为 0 至 1 之间的有限数";
    case z.ZodIssueCode.not_finite:
      return "应为有限且非负数";
    case z.ZodIssueCode.custom:
      return issue.message;
    default:
      return "应为符合步骤格式的字段";
  }
}

/** 校验后返回原对象，调用方可继续使用 ref、插值和透传元数据。 */
export function validateStepInput(raw: unknown, label: string): Step {
  const result = stepSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues.map((issue) =>
      `${issue.path.join(".") || "步骤"}: ${expectedFormat(issue)}`
    ).join("；");
    throw new StepValidationError(`${label} 不合法：${details}`);
  }
  return raw as Step;
}

/** 整个数组校验完成后才返回；持久化 trace 传 true 以保留历史空 trace 行为。 */
export function validateStepsInput(raw: unknown, allowEmpty = false): Step[] {
  if (!Array.isArray(raw)) throw new StepValidationError("steps: 应为步骤数组");
  if (!allowEmpty && raw.length === 0) throw new StepValidationError("steps: 必须包含至少 1 个步骤");
  for (let index = 0; index < raw.length; index++) validateStepInput(raw[index], `第 ${index + 1} 步`);
  return raw as Step[];
}
