import type { Step, TargetRef } from "../types.js";
import { displayPageUrl } from "../session/pageUrl.js";
import type { VariableRedactor } from "./variablePrivacy.js";

const ACTIONS: Record<Step["action"], string> = {
  navigate: "导航", click: "点击", fill: "填写", select: "选择", press: "按键",
  hover: "悬停", scroll: "滚动", wait: "等待", sleep: "暂停", assert: "检查", extract: "提取"
};
export function describeAction(action: Step["action"]): string {
  return typeof action === "string" && Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : "执行";
}
function compact(text: string): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > 70 ? value.slice(0, 70) + "…" : value;
}
function route(value: string): string {
  if (!value) return "当前页面";
  try {
    const absolute = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
    const raw = absolute ? value : new URL(value, "https://relative.invalid").href;
    return displayPageUrl(raw).replace("https://relative.invalid", "")
      .replaceAll("%7B", "{").replaceAll("%7D", "}");
  } catch { return value; }
}
function targetName(target: TargetRef | undefined, labels: ReadonlyMap<string, string> | undefined, shorten: (text: unknown) => string): string {
  if (!target || typeof target !== "object") return "元素";
  if ("ref" in target) return shorten(labels?.get(target.ref) || target.ref);
  const strategies = target.descriptor?.strategies;
  if (!Array.isArray(strategies)) return "元素";
  for (const strategy of strategies) {
    if (!strategy || typeof strategy !== "object") continue;
    if ("name" in strategy && typeof strategy.name === "string" && strategy.name) {
      const rawAnchor = strategy.kind === "container-role-name" ? strategy.containerText
        : strategy.kind === "row-role-name" ? strategy.rowText : "";
      const anchor = typeof rawAnchor === "string" ? rawAnchor : "";
      return shorten(anchor ? anchor + " › " + strategy.name : strategy.name);
    }
    if (strategy.kind === "text" && typeof strategy.text === "string" && strategy.text) return shorten(strategy.text);
  }
  const first = strategies.find((strategy) => strategy && typeof strategy === "object" && "value" in strategy && typeof strategy.value === "string");
  return first && "value" in first ? shorten(first.value) : "元素";
}
/** 描述是尽力而为的观察信息；先脱敏再截断，不能阻断真实动作。 */
export function describeStep(step: Step, labels?: ReadonlyMap<string, string>, redact: VariableRedactor = (text) => text): string {
  if (!step || typeof step !== "object") return "执行";
  try {
    const shorten = (text: unknown) => compact(redact(typeof text === "string" ? text : ""));
    const target = () => "「" + targetName("target" in step ? step.target : undefined, labels, shorten) + "」";
    const url = (value: unknown) => shorten(route(redact(typeof value === "string" ? value : "")));
    switch (step.action) {
      case "navigate": return "导航到 " + url(step.url);
      case "click": case "fill": case "select": case "hover": case "extract":
        return describeAction(step.action) + target();
      case "press": return "按键「" + shorten(step.key || "未知键") + "」";
      case "scroll": return (step.direction === "up" ? "向上" : "向下") + "滚动" + (step.target ? target() : "页面");
      case "sleep": return "暂停 " + step.ms + "ms";
      case "wait": {
        if (!step.until) return "等待";
        if (step.until.type === "visible") return "等待「" + targetName(step.until.target, labels, shorten) + "」出现";
        if (step.until.type === "hidden") return "等待「" + targetName(step.until.target, labels, shorten) + "」隐藏";
        if (step.until.type === "url-contains") return "等待地址包含「" + url(step.until.value) + "」";
        return "等待接口「" + url(step.until.urlPattern) + "」完成";
      }
      case "assert":
        return step.type === "url-contains" ? "检查页面地址"
          : step.type === "screenshot-match" ? "检查" + (step.target ? target() : "页面") + "截图"
            : "检查" + target() + (step.type === "visible" ? "可见" : step.type === "hidden" ? "隐藏" : "文本");
      default: return "执行";
    }
  } catch { return describeAction(step.action); }
}
