import type { FailureContext, RunRecord } from "../types.js";
import type { VariableTextMapping } from "../executor/variables.js";

export type VariableRedactor = (text: string) => string;

export function createVariableRedactor(
  values: Record<string, string>, names: readonly string[], mappings: readonly VariableTextMapping[] = []
): VariableRedactor {
  const replacements = new Map<string, string>();
  for (const mapping of mappings) {
    if (!mapping.value) continue;
    const variants = new Set([mapping.value, JSON.stringify(mapping.value).slice(1, -1)]);
    try { variants.add(encodeURI(mapping.value)); variants.add(encodeURIComponent(mapping.value)); } catch { /* 原值仍可替换。 */ }
    for (const variant of variants) replacements.set(variant, mapping.source);
  }
  for (const name of [...new Set(names)].sort()) {
    const value = values[name];
    if (!value) continue;
    const variants = new Set([value, JSON.stringify(value).slice(1, -1)]);
    try { variants.add(encodeURI(value)); variants.add(encodeURIComponent(value)); } catch { /* 原值仍可替换。 */ }
    for (const variant of variants) {
      if (variant && !replacements.has(variant)) replacements.set(variant, "$" + "{" + name + "}");
    }
  }
  if (!replacements.size) return (text) => text;
  const literals = [...replacements.keys()].sort((a, b) => b.length - a.length);
  const escape = (text: string) => text.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&");
  const pattern = new RegExp("\\$\\{[A-Za-z_][A-Za-z0-9_]*\\}|" + literals.map((value) => {
    const mapped = mappings.some((mapping) => mapping.value === value && !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(mapping.source));
    const before = !mapped && value.length < 4 && /^[\p{L}\p{N}_]/u.test(value) ? "(?<![\\p{L}\\p{N}_])" : "";
    const after = !mapped && value.length < 4 && /[\p{L}\p{N}_]$/u.test(value) ? "(?![\\p{L}\\p{N}_])" : "";
    return before + escape(value) + after;
  }).join("|"), "gu");
  return (text) => text.replace(pattern, (match) => /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(match) ? match : replacements.get(match)!);
}

export function redactVariableSnapshot(snapshot: string, redact: VariableRedactor): string {
  return snapshot.split("\n").map((line) => {
    const prefix = line.match(/^(\s*\[e\d+\]\s*)/);
    return prefix ? prefix[0] + redact(line.slice(prefix[0].length)) : redact(line);
  }).join("\n");
}

export function redactVariableFailure(failure: FailureContext, redact: VariableRedactor): FailureContext {
  return {
    ...failure, message: redact(failure.message), snapshot: redactVariableSnapshot(failure.snapshot, redact),
    ...(failure.currentUrl === undefined ? {} : { currentUrl: redact(failure.currentUrl) }),
    ...(failure.candidates === undefined ? {} : { candidates: failure.candidates.map(redact) }),
    consoleErrors: failure.consoleErrors.map(redact), failedRequests: failure.failedRequests.map(redact)
  };
}

/** 仅转换文本诊断；原始步骤、数值台账和机读结构保持不变。 */
export function redactVariableRecord(record: RunRecord, redact: VariableRedactor): RunRecord {
  return {
    ...record,
    steps: record.steps.map((step) => step.error === undefined ? step : { ...step, error: redact(step.error) }),
    ...(record.failure === undefined ? {} : { failure: redactVariableFailure(record.failure, redact) })
  };
}
