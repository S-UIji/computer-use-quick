import { describe, expect, it } from "vitest";
import { renderRunRecord } from "../../src/report/runRecord.js";
import { renderDemoFailure } from "../../src/trace/heal.js";
import { renderSuiteResult } from "../../src/report/suiteReport.js";
import type { FailureContext, RunRecord } from "../../src/types.js";

const failure: FailureContext = {
  failedIndex: 0, failedStep: { action: "click", target: { ref: "e1" } },
  kind: "target-not-found", message: "目标不存在", snapshot: "snap",
  consoleErrors: [], failedRequests: []
};
function record(f: FailureContext): RunRecord {
  return { traceName: "url-test", startedAt: "", durationMs: 1, ok: false, steps: [], drifts: [],
    failure: f, healRequired: f.kind !== "page-closed" };
}
const renderers = [
  { name: "replay", render: (f: FailureContext) => renderRunRecord(record(f)) },
  { name: "heal", render: renderDemoFailure },
  { name: "suite", render: (f: FailureContext) => renderSuiteResult({
    total: 1, ok: 0, failed: 1, flaky: 0, durationMs: 1,
    results: [{ path: "url-test.json", name: "url-test", ok: false, durationMs: 1,
      stepCount: 0, driftCount: 0, attempts: 1, record: record(f) }]
  }) }
];
describe.each(renderers)("$name 的失败 URL", ({ render }) => {
  it("展示现场 URL，旧记录缺少字段时兼容", () => {
    const url = "https://app.test/login?next=app";
    const output = render({ ...failure, currentUrl: url });
    expect(output).toContain("当前 URL");
    expect(output).toContain(url);
    const legacy = render(failure);
    expect(legacy).toContain("目标不存在");
    expect(legacy).not.toContain("当前 URL");
    expect(legacy).not.toContain("undefined");
  });
  it("关闭页 URL 标为最后已知地址，不覆盖关闭类型", () => {
    const output = render({ ...failure, kind: "page-closed", currentUrl: "https://app.test/closed" });
    expect(output).toContain("page-closed");
    expect(output).toContain("最后已知");
    expect(output).toContain("https://app.test/closed");
  });
});
