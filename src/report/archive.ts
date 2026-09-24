import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunArtifact, RunRecord, Trace } from "../types.js";

/**
 * 运行归档：traces/runs/<时间戳>-<用例名>/ 落盘 run-record，失败附现场包。
 * 全程旁路——归档失败只记日志，绝不让落盘弄翻主流程。
 */

export interface ArchiveInput {
  traceName: string;
  record: RunRecord;
  /** 失败时的 trace 副本（现场包三件套之一） */
  trace?: Trace;
  /** 失败时刻截图（base64 PNG），在 Context release 前抓取 */
  screenshotBase64?: string;
  /** 归档根目录，默认 ./traces/runs */
  rootDir?: string;
  /** 目录名后缀（重试的第二次尝试用 "-retry"） */
  suffix?: string;
  /** 失败现场产物（视觉断言三图等），落成文件 */
  artifacts?: RunArtifact[];
}

/** 本地时间文件名安全戳：YYYYMMDD-HHmmss（ISO 的冒号在 Windows 文件名非法） */
export function timestampForFilename(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 尽力而为的归档；返回归档目录，失败返回 undefined（只记日志） */
export async function archiveRun(input: ArchiveInput): Promise<string | undefined> {
  try {
    const root = input.rootDir ?? "./traces/runs";
    const dir = join(root, `${timestampForFilename()}-${input.traceName}${input.suffix ?? ""}`);
    await mkdir(dir, { recursive: true });
    // artifacts 落成文件，不进 run-record.json（避免 base64 撑爆台账）
    const { artifacts, ...recordRest } = input.record as RunRecord & { artifacts?: RunArtifact[] };
    await writeFile(join(dir, "run-record.json"), JSON.stringify(recordRest, null, 2) + "\n", "utf8");

    for (const a of input.artifacts ?? artifacts ?? []) {
      await writeFile(join(dir, a.name), Buffer.from(a.base64, "base64"));
    }

    if (input.record.failure) {
      if (input.screenshotBase64) {
        await writeFile(join(dir, "screenshot.png"), Buffer.from(input.screenshotBase64, "base64"));
      }
      if (input.record.failure.snapshot) {
        await writeFile(join(dir, "snapshot.txt"), input.record.failure.snapshot, "utf8");
      }
      if (input.trace) {
        await writeFile(join(dir, "trace.json"), JSON.stringify(input.trace, null, 2) + "\n", "utf8");
      }
    }
    return dir;
  } catch (err) {
    console.error(
      `[archive] 归档失败（不影响运行结果）：${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
}
