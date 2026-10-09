import { writeFile, readFile, mkdir, appendFile, rename, rm, realpath } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { Trace, Step, HealSidecarRecord } from "../types.js";
import { validateStepsInput } from "../executor/stepValidation.js";

/** 定位信息里出现这些字样即视为凭证字段。中文词不能少：中文系统的密码框标签就是「密码」 */
const SECRET_HINT = /(password|passwd|pwd|secret|token|credential|apikey|api_key|密码|口令|密钥|秘钥|令牌)/i;

const PLACEHOLDER = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

function targetText(step: Step): string {
  const t = (step as { target?: unknown }).target;
  return t ? JSON.stringify(t) : "";
}

/** fill 是否把明文写进了凭证字段：带 sensitive 标记（type=password）或定位信息含凭证字样，且值不是 ${VAR} */
export function isPlaintextSecret(step: Step): boolean {
  if (step.action !== "fill") return false;
  const looksSecret = step.sensitive === true || SECRET_HINT.test(targetText(step));
  return looksSecret && !PLACEHOLDER.test(step.value);
}

export function assertNoSecrets(trace: Trace): void {
  validateStepsInput(trace.steps, true);
  for (const [i, step] of trace.steps.entries()) {
    const direct = (step as { target?: { ref?: string } }).target;
    const nested = step.action === "wait" && "target" in step.until ? step.until.target : undefined;
    const t = [direct, nested].find((target) => target && "ref" in target);
    if (t && "ref" in t) {
      throw new Error(
        `第 ${i + 1} 步仍在使用 ref。ref 只在单次快照内有效，不能写进 trace——` +
        `请在保存前把它固化为 descriptor。`
      );
    }
    if (isPlaintextSecret(step)) {
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

/** 证据、预算与互斥共用同一个文件身份（Windows 大小写和符号链接别名归一）。 */
export async function canonicalTracePath(path: string): Promise<string> {
  const absolute = await realpath(path).catch(() => resolve(path));
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

export function traceFingerprint(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** 同一次读取提供执行内容与原始文件指纹，避免证据绑定到别的版本。 */
export async function loadTraceSnapshot(path: string): Promise<{ trace: Trace; fingerprint: string }> {
  const content = await readFile(path, "utf8");
  let parsed: Partial<Trace>;
  try { parsed = JSON.parse(content) as Partial<Trace>; }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error("trace 不是合法 JSON：JSON 格式不正确");
    throw error;
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.steps)) {
    throw new Error(`${path} 不是合法 trace：缺少 steps 数组`);
  }
  if (typeof parsed.name !== "string" || typeof parsed.baseUrl !== "string") {
    throw new Error(`${path} 不是合法 trace：缺少 name 或 baseUrl`);
  }
  validateStepsInput(parsed.steps, true);
  return {
    fingerprint: traceFingerprint(content),
    trace: {
      name: parsed.name, baseUrl: parsed.baseUrl,
      createdAt: parsed.createdAt ?? "", steps: parsed.steps
    }
  };
}

export async function loadTrace(path: string): Promise<Trace> {
  return (await loadTraceSnapshot(path)).trace;
}

export class TraceChangedError extends Error {
  constructor() {
    super("trace 文件已改变，修复未写回；请对当前文件重新 replay。");
    this.name = "TraceChangedError";
  }
}

/**
 * 原子更新 trace：临时文件 + rename，崩溃不产生半截文件。
 * 序列化约定与 saveTrace 一致（2 空格缩进 + 末尾换行），配合 {...trace, steps}
 * 的改法，未触及的键序与内容逐字节不变，git diff 只体现被替换的步。
 */
export async function atomicWriteTrace(
  tracePath: string, trace: Trace, expectedFingerprint?: string
): Promise<void> {
  assertNoSecrets(trace);
  const tmp = `${tracePath}.tmp-${randomUUID()}`;
  try {
    await writeFile(tmp, JSON.stringify(trace, null, 2) + "\n", "utf8");
    if (expectedFingerprint !== undefined) {
      let current: string;
      try { current = await readFile(tracePath, "utf8"); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new TraceChangedError();
        throw err;
      }
      if (traceFingerprint(current) !== expectedFingerprint) throw new TraceChangedError();
    }
    await rename(tmp, tracePath);
  } finally {
    await rm(tmp, { force: true });
  }
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
