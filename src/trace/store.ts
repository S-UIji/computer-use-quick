import { writeFile, readFile, mkdir, appendFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { Trace, Step, HealSidecarRecord } from "../types.js";

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

/**
 * 原子更新 trace：临时文件 + rename，崩溃不产生半截文件。
 * 序列化约定与 saveTrace 一致（2 空格缩进 + 末尾换行），配合 {...trace, steps}
 * 的改法，未触及的键序与内容逐字节不变，git diff 只体现被替换的步。
 */
export async function atomicWriteTrace(tracePath: string, trace: Trace): Promise<void> {
  assertNoSecrets(trace);
  const tmp = `${tracePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(trace, null, 2) + "\n", "utf8");
  await rename(tmp, tracePath);
}

/** heal 历史 sidecar 路径：traces/smoke-login.json → traces/smoke-login.heal.jsonl */
export function healSidecarPath(tracePath: string): string {
  return tracePath.replace(/\.json$/, "") + ".heal.jsonl";
}

export async function appendHealRecord(tracePath: string, record: HealSidecarRecord): Promise<void> {
  await appendFile(healSidecarPath(tracePath), JSON.stringify(record) + "\n", "utf8");
}

export async function readHealRecords(tracePath: string): Promise<HealSidecarRecord[]> {
  let text: string;
  try {
    text = await readFile(healSidecarPath(tracePath), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as HealSidecarRecord);
}
