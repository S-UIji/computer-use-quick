import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Trace, Step } from "../types.js";

const SECRET_HINT = /(password|passwd|pwd|secret|token|credential|apikey|api_key)/i;

function targetText(step: Step): string {
  const t = (step as { target?: unknown }).target;
  return t ? JSON.stringify(t) : "";
}

export function assertNoSecrets(trace: Trace): void {
  for (const [i, step] of trace.steps.entries()) {
    const t = (step as { target?: { ref?: string } }).target;
    if (t && "ref" in t) {
      throw new Error(
        `第 ${i + 1} 步仍在使用 ref「${t.ref}」。ref 只在单次快照内有效，不能写进 trace——` +
        `请在保存前把它固化为 descriptor。`
      );
    }
    if (step.action !== "fill") continue;
    const looksSecret = SECRET_HINT.test(targetText(step));
    const isPlaceholder = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(step.value);
    if (looksSecret && !isPlaceholder) {
      throw new Error(
        `第 ${i + 1} 步向疑似凭证字段写入了明文值。请改用 \${VAR} 占位符，` +
        `真实值通过 batch/replay 的 vars 或环境变量传入。`
      );
    }
  }
}

export async function saveTrace(dir: string, trace: Trace): Promise<string> {
  assertNoSecrets(trace);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${trace.name}.json`);
  await writeFile(path, JSON.stringify(trace, null, 2) + "\n", "utf8");
  return path;
}

export async function loadTrace(path: string): Promise<Trace> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<Trace>;
  if (!Array.isArray(parsed.steps)) {
    throw new Error(`${path} 不是合法 trace：缺少 steps 数组`);
  }
  if (typeof parsed.name !== "string" || typeof parsed.baseUrl !== "string") {
    throw new Error(`${path} 不是合法 trace：缺少 name 或 baseUrl`);
  }
  return {
    name: parsed.name,
    baseUrl: parsed.baseUrl,
    createdAt: parsed.createdAt ?? "",
    steps: parsed.steps
  };
}
