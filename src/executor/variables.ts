import type { Step } from "../types.js";

export function interpolate(text: string, vars: Record<string, string>): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    if (!(name in vars)) {
      throw new Error(
        `未定义的变量 \${${name}}，请在配置或环境变量中提供，或先用 extract 步骤生成`
      );
    }
    return vars[name];
  });
}

export function interpolateStep(step: Step, vars: Record<string, string>): Step {
  const s = { ...step } as Record<string, unknown>;
  for (const key of ["value", "url", "expected", "key"]) {
    if (typeof s[key] === "string") s[key] = interpolate(s[key] as string, vars);
  }
  return s as Step;
}
