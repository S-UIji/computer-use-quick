import type { SuiteTraceResult } from "../trace/suite.js";
import { renderFailureContext, renderRunRecord } from "./runRecord.js";

/** 对象字段顺序无关；数组顺序、字段是否存在及原始值类型都保留。 */
function normalizedValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${Array.from(value, (item, index) => index in value ? normalizedValue(item) : "hole").join(",")}]`;
  }
  if (typeof value === "object") {
    const fields = value as Record<string, unknown>;
    return `{${Object.keys(fields).sort().map((key) => `${JSON.stringify(key)}:${normalizedValue(fields[key])}`).join(",")}}`;
  }
  if (typeof value === "number") return `number:${Object.is(value, -0) ? "-0" : String(value)}`;
  return `${typeof value}:${JSON.stringify(value)}`;
}

/** 只合并报告正文，保留每条完整台账；外层负责失败分类和机读收尾行。 */
export function renderSuiteFailureGroups(results: SuiteTraceResult[]): string[] {
  const groups: SuiteTraceResult[][] = [];
  const keyedGroups = new Map<string, SuiteTraceResult[]>();
  for (const result of results) {
    const rec = result.record;
    if (!rec?.failure) {
      groups.push([result]);
      continue;
    }
    const key = normalizedValue({ failure: rec.failure, healRequired: rec.healRequired });
    const group = keyedGroups.get(key);
    if (group) group.push(result);
    else {
      const first = [result];
      keyedGroups.set(key, first);
      groups.push(first);
    }
  }

  const lines: string[] = [];
  for (const group of groups) {
    if (group.length === 1) {
      const result = group[0];
      lines.push(
        `### ${result.name}`, "", `**tracePath**：${result.path}`, "",
        ...(result.record ? [renderRunRecord(result.record)] : []), ""
      );
      continue;
    }
    lines.push(`### 相同失败上下文（${group.length} 条）`, "", "**用例**", "");
    for (const result of group) lines.push(`- ${result.name} — ${result.path}`);
    lines.push("", "**逐条运行记录**", "");
    for (const result of group) {
      lines.push(`#### ${result.name}`, "", renderRunRecord(result.record!, "replay", { includeFailureContext: false }), "");
    }
    lines.push("**共用失败诊断**", "", renderFailureContext(group[0].record!), "");
  }
  return lines;
}
