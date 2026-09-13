import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveTrace, loadTrace, assertNoSecrets } from "../../src/trace/store.js";
import type { Trace } from "../../src/types.js";

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "cuq-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const base: Trace = {
  name: "smoke-login",
  baseUrl: "http://localhost:3040",
  createdAt: "2026-09-11T00:00:00.000Z",
  steps: [{ action: "navigate", url: "/#/" }]
};

const cssTarget = (value: string) => ({
  descriptor: { strategies: [{ kind: "css" as const, value }], framePath: [] }
});

describe("saveTrace / loadTrace", () => {
  it("写入的文件名由 trace 名派生", async () => {
    const d = await tmp();
    expect(await saveTrace(d, base)).toBe(join(d, "smoke-login.json"));
  });

  it("往返一致：存进去再读出来内容相同", async () => {
    const d = await tmp();
    expect(await loadTrace(await saveTrace(d, base))).toEqual(base);
  });

  it("写出的是格式化 JSON，便于 git diff", async () => {
    const d = await tmp();
    expect(await readFile(await saveTrace(d, base), "utf8")).toContain("\n  ");
  });

  it("读到结构非法的文件时抛出明确错误", async () => {
    const d = await tmp();
    const p = join(d, "bad.json");
    await writeFile(p, JSON.stringify({ name: "x", baseUrl: "y" }), "utf8");
    await expect(loadTrace(p)).rejects.toThrow(/steps/);
  });
});

describe("assertNoSecrets", () => {
  it("密码字段是 ${VAR} 占位符时放行", () => {
    assertNoSecrets({ ...base, steps: [
      { action: "fill", target: cssTarget("#pwd"), value: "${PWD}" }
    ]});
  });

  it("密码字段是明文时抛错", () => {
    expect(() => assertNoSecrets({ ...base, steps: [
      { action: "fill", target: cssTarget("#password"), value: "hunter2" }
    ]})).toThrow(/明文/);
  });

  it("非敏感字段的明文值放行", () => {
    assertNoSecrets({ ...base, steps: [
      { action: "fill", target: cssTarget("#user"), value: "admin" }
    ]});
  });

  it("trace 里仍残留 ref 句柄时抛错（ref 不可长期保存）", () => {
    expect(() => assertNoSecrets({ ...base, steps: [
      { action: "click", target: { ref: "e3" } }
    ]})).toThrow(/ref/);
  });

  it("saveTrace 会把关卡前置，明文凭证根本落不了盘", async () => {
    const d = await tmp();
    await expect(saveTrace(d, { ...base, steps: [
      { action: "fill", target: cssTarget("#pwd"), value: "hunter2" }
    ]})).rejects.toThrow(/明文/);
  });
});
