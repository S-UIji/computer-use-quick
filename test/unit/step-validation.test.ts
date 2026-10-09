import { afterEach, describe, expect, it } from "vitest";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNoSecrets, atomicWriteTrace, loadTraceSnapshot, saveTrace
} from "../../src/trace/store.js";
import { buildRepairPlan } from "../../src/trace/repairPlan.js";
import type { Step, Trace } from "../../src/types.js";
import { StepValidationError, validateStepInput, validateStepsInput } from "../../src/executor/stepValidation.js";

const dirs: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cuq-step-validation-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const descriptor = { strategies: [{ kind: "css", value: "#submit" }], framePath: [] };
const target = { descriptor };
const trace = (steps: unknown[]): Trace => ({
  name: "validation", baseUrl: "https://app.test", createdAt: "2026-10-09",
  steps: steps as Step[]
});

function expectFormatError(run: () => unknown, field: string, label = "第 1 步"): void {
  let error: unknown;
  try { run(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).name).toBe("StepValidationError");
  expect((error as Error).message).toContain(label);
  expect((error as Error).message).toContain(field);
  expect((error as Error).message).toMatch(/应为|需要|必须/);
}

const malformedSteps: Array<[string, unknown, string]> = [
  ["null步骤", null, "步骤"],
  ["字符串步骤", "secret-value", "步骤"],
  ["数字步骤", 123, "步骤"],
  ["数组步骤", [], "步骤"],
  ["缺action", {}, "action"],
  ["未知action", { action: "credential-leak-sentinel" }, "action"],
  ["null target", { action: "click", target: null }, "target"],
  ["字符串target", { action: "click", target: "credential-leak-sentinel" }, "target"],
  ["空target", { action: "click", target: {} }, "target"],
  ["空ref", { action: "click", target: { ref: "" } }, "target.ref"],
  ["空descriptor策略", { action: "click", target: { descriptor: { strategies: [], framePath: [] } } }, "target.descriptor.strategies"],
  ["未知策略", { action: "click", target: { descriptor: { strategies: [{ kind: "credential-leak-sentinel" }], framePath: [] } } }, "target.descriptor.strategies.0.kind"],
  ["策略value类型", { action: "click", target: { descriptor: { strategies: [{ kind: "css", value: 7 }], framePath: [] } } }, "target.descriptor.strategies.0.value"],
  ["缺framePath", { action: "click", target: { descriptor: { strategies: [{ kind: "css", value: "#ok" }] } } }, "target.descriptor.framePath"],
  ["负nth", { action: "click", target: { descriptor: { strategies: [{ kind: "role-name", role: "button", name: "", nth: -1 }], framePath: [] } } }, "nth"],
  ["小数nth", { action: "click", target: { descriptor: { strategies: [{ kind: "text", tag: "div", text: "", nth: 0.5 }], framePath: [] } } }, "nth"],
  ["缺fill value", { action: "fill", target }, "value"],
  ["select value类型", { action: "select", target, value: null }, "value"],
  ["缺url", { action: "navigate" }, "url"],
  ["缺key", { action: "press" }, "key"],
  ["缺as", { action: "extract", target }, "as"],
  ["null until", { action: "wait", until: null }, "until"],
  ["wait嵌套null target", { action: "wait", until: { type: "visible", target: null } }, "until.target"],
  ["wait缺value", { action: "wait", until: { type: "url-contains" } }, "until.value"],
  ["wait缺urlPattern", { action: "wait", until: { type: "response" } }, "until.urlPattern"],
  ["未知wait类型", { action: "wait", until: { type: "credential-leak-sentinel" } }, "until.type"],
  ["负sleep", { action: "sleep", ms: -1 }, "ms"],
  ["无限sleep", { action: "sleep", ms: Infinity }, "ms"],
  ["NaN timeout", { action: "wait", until: { type: "url-contains", value: "" }, timeout: NaN }, "timeout"],
  ["负scroll", { action: "scroll", amount: -1 }, "amount"],
  ["非法dialog", { action: "press", key: "Enter", dialog: "credential-leak-sentinel" }, "dialog"],
  ["非法from", { action: "extract", target, as: "USER", from: "credential-leak-sentinel" }, "from"],
  ["缺assert target", { action: "assert", type: "visible" }, "target"],
  ["缺text expected", { action: "assert", type: "text-equals", target }, "expected"],
  ["缺url expected", { action: "assert", type: "url-contains" }, "expected"],
  ["非法threshold", { action: "assert", type: "screenshot-match", fullPage: true, threshold: 1.1 }, "threshold"]
];

describe("trace边界的共用步骤校验", () => {
  it.each(malformedSteps)("秘密检查前先拒绝%s，错误包含字段和格式", (_name, step, field) => {
    expectFormatError(() => assertNoSecrets(trace([step])), field);
  });

  it("末步格式错误标注原序号", () => {
    expectFormatError(() => assertNoSecrets(trace([
      { action: "navigate", url: "/form" }, { action: "click", target: null }
    ])), "target", "第 2 步");
  });

  it("repair的action和enum格式错误不回显输入值", () => {
    for (const step of [
      { action: "credential-leak-sentinel" },
      { action: "press", key: "Enter", dialog: "credential-leak-sentinel" },
      { action: "assert", type: "credential-leak-sentinel" }
    ]) {
      let error: unknown;
      try { buildRepairPlan(trace([{ action: "sleep", ms: 0 }]), [{ stepIndex: 0, steps: [step as Step] }]); }
      catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain("credential-leak-sentinel");
      expect((error as Error).message).toContain("原第 1 步的第 1 个替换步骤");
    }
  });

  it("磁盘load在提供trace前拒绝末步错误", async () => {
    const dir = await temporaryDirectory();
    const path = join(dir, "broken.json");
    await writeFile(path, JSON.stringify(trace([
      { action: "navigate", url: "/form" }, { action: "click", target: null }
    ])), "utf8");
    await expect(loadTraceSnapshot(path)).rejects.toMatchObject({
      name: "StepValidationError", message: expect.stringContaining("第 2 步")
    });
  });

  it("save格式失败不创建目标目录", async () => {
    const dir = await temporaryDirectory();
    const destination = join(dir, "not-created");
    await expect(saveTrace(destination, trace([{ action: "click", target: null }]))).rejects.toMatchObject({ name: "StepValidationError" });
    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("atomic格式失败不覆盖原文件也不留下临时文件", async () => {
    const dir = await temporaryDirectory();
    const path = join(dir, "original.json");
    const content = JSON.stringify(trace([{ action: "sleep", ms: 0 }]));
    await writeFile(path, content, "utf8");
    await expect(atomicWriteTrace(path, trace([{ action: "wait", until: null }]))).rejects.toMatchObject({ name: "StepValidationError" });
    expect(await readFile(path, "utf8")).toBe(content);
    expect(await readdir(dir)).toEqual(["original.json"]);
  });
});

describe("validateStepsInput 输入与保真契约", () => {
  it.each([null, undefined, 3, "credential-leak-sentinel", {}])("拒绝非数组步骤输入", (raw) => {
    expect(() => validateStepsInput(raw)).toThrow(StepValidationError);
    expect(() => validateStepsInput(raw)).toThrow(/steps.*数组/);
  });

  it("默认要求至少一步，可显式允许空trace", () => {
    const steps: unknown[] = [];
    expect(() => validateStepsInput(steps)).toThrow(/steps.*至少/);
    expect(validateStepsInput(steps, true)).toBe(steps);
  });

  it("全部动作、策略、空文本、可选字段和插值通过且返回原对象", () => {
    const richTarget = {
      descriptor: {
        strategies: [
          { kind: "test-id", value: "${TEST_ID}" },
          { kind: "container-role-name", containerText: "${CONTAINER}", role: "textbox", name: "", nth: 0 },
          { kind: "row-role-name", rowText: "row", role: "button", name: "", nth: 1 },
          { kind: "role-name", role: "button", name: "", nth: 2 },
          { kind: "text", tag: "div", text: "", nth: 0 },
          { kind: "css", value: "#ok" },
          { kind: "xpath", value: "//button" }
        ],
        framePath: ["frame"], distinguishers: [""], metadata: { preserved: true }
      },
      metadata: { original: true }
    };
    const steps = [
      { action: "navigate", url: "${BASE_URL}/form", dialog: "accept", promptText: "" },
      { action: "click", target: richTarget, extra: { preserved: true } },
      { action: "fill", target: richTarget, value: "", sensitive: false },
      { action: "select", target: { ref: "e2" }, value: "" },
      { action: "press", key: "${KEY}", dialog: "dismiss" },
      { action: "hover", target: { ref: "e3" } },
      { action: "scroll", direction: "down", amount: 0 },
      { action: "scroll", target: richTarget, direction: "up", amount: 1 },
      { action: "wait", until: { type: "visible", target: { ref: "e4" } }, timeout: 0 },
      { action: "wait", until: { type: "hidden", target: richTarget } },
      { action: "wait", until: { type: "url-contains", value: "" } },
      { action: "wait", until: { type: "response", urlPattern: "${API}" } },
      { action: "sleep", ms: 0 },
      { action: "assert", type: "visible", target: richTarget },
      { action: "assert", type: "hidden", target: { ref: "e5" } },
      { action: "assert", type: "text-equals", target: richTarget, expected: "" },
      { action: "assert", type: "text-contains", target: richTarget, expected: "${MESSAGE}" },
      { action: "assert", type: "url-contains", expected: "" },
      { action: "assert", type: "screenshot-match", fullPage: true, threshold: 1 },
      { action: "extract", target: richTarget, as: "USER", from: "text" },
      { action: "extract", target: { ref: "e6" }, as: "VALUE", from: "value" }
    ];
    const before = JSON.stringify(steps);
    expect(validateStepsInput(steps)).toBe(steps);
    for (const step of steps) expect(validateStepInput(step, "自定义标签")).toBe(step);
    expect(JSON.stringify(steps)).toBe(before);
    expect(steps[1].target).toBe(richTarget);
  });

  it("显式undefined ref不能绕过执行器ref分支", () => {
    expect(() => validateStepsInput([{ action: "click", target: { ref: undefined, descriptor } }])).toThrow(/target.ref.*非空字符串/);
  });

  it.each(malformedSteps)("共用API拒绝%s且不回显输入", (_name, step, field) => {
    expectFormatError(() => validateStepInput(step, "输入步骤"), field, "输入步骤");
    try { validateStepInput(step, "输入步骤"); }
    catch (error) { expect((error as Error).message).not.toContain("credential-leak-sentinel"); }
  });
});

describe("trace持久化兼容与安全错误", () => {
  it("历史空trace仍可save/load/atomic往返", async () => {
    const dir = await temporaryDirectory();
    const empty = trace([]);
    const path = await saveTrace(dir, empty);
    expect((await loadTraceSnapshot(path)).trace).toEqual(empty);
    await atomicWriteTrace(path, empty);
    expect((await loadTraceSnapshot(path)).trace).toEqual(empty);
  });

  it("合法descriptor步骤的透传字段保存后仍保留", async () => {
    const dir = await temporaryDirectory();
    const source = trace([{ action: "click", target, audit: { original: true } }]);
    expect((await loadTraceSnapshot(await saveTrace(dir, source))).trace).toEqual(source);
  });

  it("持久化拒绝直接和嵌套ref时不回显句柄值", () => {
    for (const step of [
      { action: "click", target: { ref: "credential-leak-sentinel" } },
      { action: "wait", until: { type: "visible", target: { ref: "credential-leak-sentinel" } } }
    ]) {
      let error: unknown;
      try { assertNoSecrets(trace([step])); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("ref");
      expect((error as Error).message).not.toContain("credential-leak-sentinel");
    }
  });

  it("原trace末步格式错误时整个repair规划先拒绝", () => {
    expectFormatError(() => buildRepairPlan(trace([
      { action: "sleep", ms: 0 }, { action: "click", target: null }
    ]), [{ stepIndex: 0, steps: [{ action: "sleep", ms: 1 }] }]), "target", "第 2 步");
  });
});

describe("loadTraceSnapshot JSON格式错误隐私", () => {
  it.each([
    '{"name":"credential-leak-sentinel","steps":[}',
    '"credential-leak-sentinel'
  ])("坏JSON用固定中文提示且不回显片段", async (content) => {
    const dir = await temporaryDirectory();
    const path = join(dir, "malformed.json");
    await writeFile(path, content, "utf8");
    let error: unknown;
    try { await loadTraceSnapshot(path); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/trace.*JSON.*格式/);
    expect((error as Error).message).not.toContain("credential-leak-sentinel");
    expect((error as Error).message).not.toContain('"steps"');
  });

  it("文件不存在仍保留ENOENT的IO错误语义", async () => {
    const dir = await temporaryDirectory();
    await expect(loadTraceSnapshot(join(dir, "not-present.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
