import { describe, expect, it } from "vitest";
import { renderFailureContext, renderRunRecord } from "../../src/report/runRecord.js";
import { renderSuiteFailureGroups } from "../../src/report/suiteFailureGroups.js";
import { createVariableRedactor, redactVariableRecord } from "../../src/report/variablePrivacy.js";
import { renderSuiteResult } from "../../src/report/suiteReport.js";
import type { SuiteResult, SuiteTraceResult } from "../../src/trace/suite.js";
import type { FailureContext } from "../../src/types.js";

function failure(): FailureContext {
  return {
    failedIndex: 1,
    failedStep: {
      action: "click",
      target: { descriptor: {
        strategies: [
          { kind: "role-name", role: "button", name: "登录", nth: 0 },
          { kind: "css", value: "#login" }
        ],
        framePath: ["#app"], distinguishers: ["用户名", "密码"]
      } },
      dialog: "dismiss"
    },
    kind: "target-not-found", message: "全部策略均未命中",
    currentUrl: "https://app.test/login?next=app", snapshot: "R16 shared snapshot",
    candidates: ["候选甲", "候选乙"],
    consoleErrors: ["error-a", "error-b"], failedRequests: ["500 /a", "503 /b"]
  };
}

function trace(name: string, f: FailureContext | undefined = failure(), durationMs = 110): SuiteTraceResult {
  return {
    path: `/traces/${name}.json`, name, ok: false, durationMs,
    stepCount: 2, driftCount: 1, attempts: 1,
    record: {
      traceName: name, startedAt: "2026-10-09T00:00:00.000Z", durationMs,
      ok: false, healRequired: true,
      steps: [
        { index: 0, action: "navigate", ok: true, durationMs: durationMs - 10,
          description: `${name} 准备`, error: `${name} baseline warning` },
        { index: 1, action: "click", ok: false, durationMs: 10,
          description: `${name} 登录`, strategyIndex: 1 }
      ],
      drifts: [{ index: 0, expected: `${name} first`, actual: `${name} fallback` }],
      ...(f === undefined ? {} : { failure: f })
    }
  };
}

function suite(results: SuiteTraceResult[]): SuiteResult {
  return { total: results.length, ok: 0, failed: results.length, flaky: 0,
    durationMs: 1000, results };
}

function count(text: string, value: string): number {
  return text.split(value).length - 1;
}

describe("suite 失败诊断去重", () => {
  it("三个相同现场只保留一次正文，仍展示所有路径、独立台账和告警", () => {
    const results = [trace("alpha", failure(), 110), trace("beta", failure(), 220), trace("gamma", failure(), 330)];
    const before = structuredClone(results);
    const output = renderSuiteResult(suite(results));

    expect(count(output, "R16 shared snapshot")).toBe(1);
    expect(count(output, "## 失败上下文（heal_required=true）")).toBe(1);
    for (const t of results) {
      expect(output).toContain(t.path);
      expect(output).toContain(`${t.name} 准备 — ${t.durationMs - 10}ms`);
      expect(output).toContain(`${t.name} baseline warning`);
      expect(output).toContain(`${t.name} first`);
      expect(output).toContain(`${t.name} fallback`);
      expect(output).toContain(`已耗时 ${t.durationMs}ms`);
    }
    expect(output.split("\n").at(-1)).toBe("SUITE_RESULT ok=0 failed=3 total=3 wall_ms=1000");
    expect(results).toEqual(before);
  });

  it("完整结构相同且对象字段插入顺序不同仍共用正文", () => {
    const first = failure();
    const second: FailureContext = {
      failedRequests: first.failedRequests, consoleErrors: first.consoleErrors,
      candidates: first.candidates, snapshot: first.snapshot, currentUrl: first.currentUrl,
      message: first.message, kind: first.kind,
      failedStep: { dialog: "dismiss", target: { descriptor: {
        distinguishers: ["用户名", "密码"], framePath: ["#app"],
        strategies: [
          { nth: 0, name: "登录", role: "button", kind: "role-name" },
          { value: "#login", kind: "css" }
        ]
      } }, action: "click" },
      failedIndex: first.failedIndex
    };
    const output = renderSuiteResult(suite([trace("alpha", first), trace("beta", second)]));
    expect(count(output, "R16 shared snapshot")).toBe(1);
    expect(output).toContain("/traces/alpha.json");
    expect(output).toContain("/traces/beta.json");
  });

  const differences: Array<{ label: string; update: (f: FailureContext) => void }> = [
    { label: "失败步序", update: (f) => { f.failedIndex = 2; } },
    { label: "失败步骤动作", update: (f) => { f.failedStep = { action: "press", key: "Enter" }; } },
    { label: "失败步骤弹窗选项", update: (f) => { f.failedStep.dialog = "accept"; } },
    { label: "定位策略顺序", update: (f) => {
      if (f.failedStep.action === "click" && "descriptor" in f.failedStep.target) f.failedStep.target.descriptor.strategies.reverse();
    } },
    { label: "定位策略字段", update: (f) => {
      if (f.failedStep.action === "click" && "descriptor" in f.failedStep.target) f.failedStep.target.descriptor.strategies[0] = { kind: "role-name", role: "button", name: "注册", nth: 0 };
    } },
    { label: "frame 路径", update: (f) => {
      if (f.failedStep.action === "click" && "descriptor" in f.failedStep.target) f.failedStep.target.descriptor.framePath = ["#other"];
    } },
    { label: "区分项顺序", update: (f) => {
      if (f.failedStep.action === "click" && "descriptor" in f.failedStep.target) f.failedStep.target.descriptor.distinguishers!.reverse();
    } },
    { label: "失败类型", update: (f) => { f.kind = "ambiguous"; } },
    { label: "诊断消息", update: (f) => { f.message = "另一条消息"; } },
    { label: "现场 URL", update: (f) => { f.currentUrl = "https://app.test/register"; } },
    { label: "缺少 URL", update: (f) => { delete f.currentUrl; } },
    { label: "快照", update: (f) => { f.snapshot = "R16 changed snapshot"; } },
    { label: "候选内容", update: (f) => { f.candidates = ["候选丙", "候选乙"]; } },
    { label: "候选顺序", update: (f) => { f.candidates!.reverse(); } },
    { label: "console 内容", update: (f) => { f.consoleErrors = ["error-c", "error-b"]; } },
    { label: "console 顺序", update: (f) => { f.consoleErrors.reverse(); } },
    { label: "失败请求内容", update: (f) => { f.failedRequests = ["404 /a", "503 /b"]; } },
    { label: "失败请求顺序", update: (f) => { f.failedRequests.reverse(); } },
    { label: "retryBlocked=false 的显式字段", update: (f) => { f.retryBlocked = false; } }
  ];
  it.each(differences)("$label 不同不得合并正文", ({ update }) => {
    const changed = failure();
    update(changed);
    const output = renderSuiteResult(suite([trace("alpha", failure()), trace("beta", changed)]));
    expect(count(output, "## 失败上下文（heal_required=true）")).toBe(2);
  });

  it("healRequired 不同不得合并正文", () => {
    const second = trace("beta");
    second.record!.healRequired = false;
    const output = renderSuiteResult(suite([trace("alpha"), second]));
    expect(count(output, "R16 shared snapshot")).toBe(2);
    expect(output).toContain("heal_required=true");
    expect(output).toContain("heal_required=false");
  });
});
describe("run-record 共用正文接口兼容性", () => {
  it("关闭失败正文仍保留独立耗时、步骤告警和漂移", () => {
    const rec = trace("alpha").record!;
    const output = renderRunRecord(rec, "replay", { includeFailureContext: false });
    expect(output).toContain("已耗时 110ms");
    expect(output).toContain("alpha 准备 — 100ms");
    expect(output).toContain("alpha baseline warning");
    expect(output).toContain("alpha first");
    expect(output).toContain("alpha fallback");
    expect(output).not.toContain("## 失败上下文");
    expect(output).not.toContain("R16 shared snapshot");
  });

  it("缺省渲染保留原完整报告格式", () => {
    const rec = trace("compat").record!;
    rec.durationMs = 17;
    rec.steps = [{ index: 0, action: "click", ok: false, durationMs: 17, description: "点击登录" }];
    rec.drifts = [];
    rec.failure = {
      failedIndex: 0, failedStep: { action: "click", target: { ref: "e1" } },
      kind: "target-not-found", message: "目标不存在", snapshot: "compat snapshot",
      currentUrl: "https://app.test/login", consoleErrors: ["compat console"], failedRequests: ["500 /login"]
    };
    expect(renderRunRecord(rec)).toBe([
      "# ❌ compat 回放失败 — 在第 1 步中断，已耗时 17ms", "", "## 逐步耗时", "",
      "✗ 1. 点击登录 — 17ms ", "", "## 失败上下文（heal_required=true）", "",
      "**类型**：target-not-found", "**信息**：目标不存在", "",
      "**当前 URL**：https://app.test/login", "", "**失败步骤**", "```json",
      "{", '  "action": "click",', '  "target": {', '    "ref": "e1"', "  }", "}", "```", "",
      "**当前快照**", "```", "compat snapshot", "```", "", "**console 报错**", "compat console", "",
      "**失败请求**", "500 /login"
    ].join("\n"));
  });
});
describe("失败分组合并边界", () => {
  it("单例保留原标题和完整正文", () => {
    const output = renderSuiteFailureGroups([trace("single")]).join("\n");
    expect(output).toMatch(/^### single\n\n/);
    expect(output).toContain("**tracePath**：/traces/single.json");
    expect(output).toContain("\n# ❌ single");
    expect(output).toContain("single baseline warning");
    expect(count(output, "R16 shared snapshot")).toBe(1);
    expect(output).not.toContain("共用失败诊断");
  });

  it("缺少失败现场的记录逐条展示，不合并独立台账", () => {
    const results = [trace("alpha"), trace("beta")];
    for (const result of results) delete result.record!.failure;
    const output = renderSuiteFailureGroups(results).join("\n");
    expect(output).toContain("### alpha");
    expect(output).toContain("### beta");
    expect(output).toContain("alpha baseline warning");
    expect(output).toContain("beta baseline warning");
    expect(output).not.toContain("共用失败诊断");
    expect(output).not.toContain("SUITE_RESULT");
  });

  it("重复名称也逐个列出路径和独立台账", () => {
    const results = [trace("same", failure(), 110), trace("same", failure(), 220)];
    results[0].path = "/traces/one.json";
    results[1].path = "/traces/two.json";
    const output = renderSuiteFailureGroups(results).join("\n");
    expect(output).toContain("- same — /traces/one.json");
    expect(output).toContain("- same — /traces/two.json");
    expect(output).toContain("same 准备 — 100ms");
    expect(output).toContain("same 准备 — 210ms");
    expect(count(output, "R16 shared snapshot")).toBe(1);
  });

  it("同名但诊断不同的两个单例各自绑定文件路径", () => {
    const first = failure();
    first.message = "one-only diagnostic";
    first.snapshot = "one-only snapshot";
    const second = failure();
    second.message = "two-only diagnostic";
    second.snapshot = "two-only snapshot";
    const results = [trace("same", first, 110), trace("same", second, 220)];
    results[0].path = "/traces/one.json";
    results[1].path = "/traces/two.json";
    const output = renderSuiteResult(suite(results));
    const sections = output.split(/^### same$/m).slice(1);

    expect(sections).toHaveLength(2);
    expect(sections[0]).toContain("**tracePath**：/traces/one.json");
    expect(sections[0]).not.toContain("/traces/two.json");
    expect(sections[0]).toContain("one-only diagnostic");
    expect(sections[0]).toContain("one-only snapshot");
    expect(sections[0]).not.toContain("two-only diagnostic");
    expect(sections[1]).toContain("**tracePath**：/traces/two.json");
    expect(sections[1]).not.toContain("/traces/one.json");
    expect(sections[1]).toContain("two-only diagnostic");
    expect(sections[1]).toContain("two-only snapshot");
    expect(sections[1]).not.toContain("one-only diagnostic");
    expect(output).not.toContain("共用失败诊断");
  });
  it("字段缺失与显式 undefined 不视为同一完整结构", () => {
    const first = failure();
    delete first.candidates;
    const second = failure();
    second.candidates = undefined;
    const output = renderSuiteFailureGroups([trace("alpha", first), trace("beta", second)]).join("\n");
    expect(count(output, "R16 shared snapshot")).toBe(2);
  });

  it("空数组与含空位的稀疏数组不能误合并", () => {
    const first = failure();
    first.candidates = [];
    const second = failure();
    second.candidates = new Array<string>(1);
    const output = renderSuiteFailureGroups([trace("alpha", first), trace("beta", second)]).join("\n");
    expect(count(output, "R16 shared snapshot")).toBe(2);
  });
  it("相同文本值的不同运行时类型不能误合并", () => {
    const first = failure();
    first.failedStep = { action: "scroll", amount: 100 };
    const second = failure();
    second.failedStep = { action: "scroll", amount: "100" as unknown as number };
    const output = renderSuiteFailureGroups([trace("alpha", first), trace("beta", second)]).join("\n");
    expect(count(output, "R16 shared snapshot")).toBe(2);
  });

  it("比较完整对象，未来新增的诊断字段也影响分组", () => {
    const first = { ...failure(), futureDiagnostic: { revision: 1 } };
    const second = { ...failure(), futureDiagnostic: { revision: 2 } };
    const output = renderSuiteFailureGroups([trace("alpha", first), trace("beta", second)]).join("\n");
    expect(count(output, "R16 shared snapshot")).toBe(2);
  });

  it("共用正文沿用已脱敏诊断，不重新读取环境值或原始记录", () => {
    const secret = "r16-private/path?key=1";
    const token = "$" + "{TOKEN}";
    const f = failure();
    f.message = `expected ${secret}`;
    f.snapshot = `[e1] textbox value=${secret}`;
    f.currentUrl = `https://app.test/?business=${encodeURIComponent(secret)}`;
    f.consoleErrors = [`error ${secret}`];
    f.failedRequests = [`500 /${secret}`];
    f.candidates = [`candidate ${secret}`];
    const results = [trace("alpha", f), trace("beta", structuredClone(f))];
    const redact = createVariableRedactor({ TOKEN: secret }, ["TOKEN"]);
    for (const result of results) result.record = redactVariableRecord(result.record!, redact);
    const before = structuredClone(results);
    const output = renderSuiteFailureGroups(results).join("\n");
    expect(output).not.toContain(secret);
    expect(output).not.toContain(encodeURIComponent(secret));
    expect(output).toContain(token);
    expect(count(output, `[e1] textbox value=${token}`)).toBe(1);
    expect(results).toEqual(before);
  });

  it.each([
    { label: "可自愈", kind: "target-not-found" as const, retryBlocked: false },
    { label: "需人工恢复", kind: "action-failed" as const, retryBlocked: true },
    { label: "页面关闭", kind: "page-closed" as const, retryBlocked: false }
  ])("$label 分类也共用一致诊断且保留成员路径", ({ kind, retryBlocked }) => {
    const f = { ...failure(), kind, ...(retryBlocked ? { retryBlocked } : {}) };
    const results = [trace("alpha", f), trace("beta", structuredClone(f))];
    if (kind === "page-closed") {
      for (const result of results) {
        result.pageClosed = true;
        result.record!.healRequired = false;
      }
    }
    const output = renderSuiteResult(suite(results));
    expect(count(output, "R16 shared snapshot")).toBe(1);
    expect(output).toContain("/traces/alpha.json");
    expect(output).toContain("/traces/beta.json");
    expect(output.split("\n").at(-1)).toBe("SUITE_RESULT ok=0 failed=2 total=2 wall_ms=1000");
  });
});

describe("独立失败正文", () => {
  it("只渲染诊断，缺现场时为空字符串", () => {
    const rec = trace("alpha").record!;
    const output = renderFailureContext(rec);
    expect(output).toMatch(/^## 失败上下文（heal_required=true）/);
    expect(output).toContain("R16 shared snapshot");
    expect(output).toContain("https://app.test/login?next=app");
    expect(output).not.toContain("逐步耗时");
    expect(output).not.toContain("alpha baseline warning");
    delete rec.failure;
    expect(renderFailureContext(rec)).toBe("");
  });
});
