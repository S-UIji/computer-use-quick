import type { Step } from "../types.js";

const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const FIELDS = ["value", "url", "expected", "key", "promptText"] as const;
const SYSTEM_VARIABLES = new Set([
  "PWD", "OLDPWD", "HOME", "USER", "USERNAME", "USERPROFILE", "LOGNAME", "PATH",
  "TEMP", "TMP", "SHELL", "COMSPEC", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE",
  "HOMEPATH", "SYSTEMROOT", "WINDIR", "USERDOMAIN", "SESSIONNAME"
]);

export interface ResolvedVariables {
  values: Record<string, string>;
  environmentNames: Set<string>;
}

/** 显式值优先；系统环境字段不隐式参与步骤插值。 */
export function resolveVariables(
  explicit: Record<string, string> = {},
  environment: Record<string, string | undefined> = process.env
): ResolvedVariables {
  const values: Record<string, string> = Object.create(null);
  const environmentNames = new Set<string>();
  for (const [name, value] of Object.entries(environment)) {
    if (typeof value === "string" && !SYSTEM_VARIABLES.has(name.toUpperCase())) {
      values[name] = value;
      environmentNames.add(name);
    }
  }
  for (const [name, value] of Object.entries(explicit)) {
    if (typeof value === "string") values[name] = value;
    else delete values[name];
    environmentNames.delete(name);
  }
  return { values, environmentNames };
}

/** 使用当前执行器支持的字段，按顺序考虑 extract 的运行时输出。 */
export function inspectVariables(
  steps: readonly Step[], values: Record<string, string>,
  environmentNames: ReadonlySet<string> = new Set()
): { missing: string[]; environmentUsed: string[] } {
  const available = new Set(Object.keys(values).filter((name) => typeof values[name] === "string"));
  const fromEnvironment = new Set(environmentNames);
  const missing = new Set<string>();
  const environmentUsed = new Set<string>();
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const raw = step as unknown as Record<string, unknown>;
    for (const field of FIELDS) {
      const value = raw[field];
      if (typeof value !== "string") continue;
      for (const match of value.matchAll(VARIABLE)) {
        const name = match[1];
        if (!available.has(name)) missing.add(name);
        else if (fromEnvironment.has(name)) environmentUsed.add(name);
      }
    }
    if (step.action === "extract" && typeof step.as === "string") {
      available.add(step.as);
      fromEnvironment.delete(step.as);
    }
  }
  return { missing: [...missing].sort(), environmentUsed: [...environmentUsed].sort() };
}

export class MissingVariablesError extends Error {
  constructor(readonly variables: string[]) {
    super("变量预检失败，缺失：" + variables.map((name) => "$" + "{" + name + "}").join("、") +
      "。未执行任何步骤，请通过 vars 提供这些值，或把 extract 放到使用之前。");
    this.name = "MissingVariablesError";
  }
}

export function assertVariables(steps: readonly Step[], values: Record<string, string>): void {
  const { missing } = inspectVariables(steps, values);
  if (missing.length) throw new MissingVariablesError(missing);
}

export function variableSourceNotice(names: readonly string[]): string {
  if (!names.length) return "";
  return "⚠ 变量来源：" + [...new Set(names)].sort().map((name) => "$" + "{" + name + "}").join("、") +
    " 来自服务端环境变量（值不回显）。\n\n";
}

export function interpolate(text: string, vars: Record<string, string>): string {
  return text.replace(VARIABLE, (_m, name: string) => {
    if (!Object.hasOwn(vars, name) || typeof vars[name] !== "string") {
      throw new Error(
        "未定义的变量 $" + "{" + name + "}，请在配置或环境变量中提供，或先用 extract 步骤生成"
      );
    }
    return vars[name];
  });
}

export function interpolateStep(step: Step, vars: Record<string, string>): Step {
  const s = { ...step } as Record<string, unknown>;
  for (const key of FIELDS) {
    if (typeof s[key] === "string") s[key] = interpolate(s[key] as string, vars);
  }
  return s as unknown as Step;
}

export interface VariableTextMapping { value: string; source: string; }

/** 在真实插值点记录完整字段，支持短值拼接和动态 extract 的当前值。 */
export function variableFieldMappings(
  rawStep: Step, expandedStep: Step, environmentNames: ReadonlySet<string>
): VariableTextMapping[] {
  const raw = rawStep as unknown as Record<string, unknown>;
  const expanded = expandedStep as unknown as Record<string, unknown>;
  const mappings: VariableTextMapping[] = [];
  for (const field of FIELDS) {
    const source = raw[field];
    const value = expanded[field];
    if (typeof source !== "string" || typeof value !== "string" || !value) continue;
    if ([...source.matchAll(VARIABLE)].some((match) => environmentNames.has(match[1]))) {
      mappings.push({ value, source });
    }
  }
  return mappings;
}
