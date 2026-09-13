/** CDP Accessibility.getFullAXTree 返回的原始节点（只保留我们用得到的字段） */
export interface RawAxNode {
  nodeId: string;
  ignored: boolean;
  role?: { value?: string };
  name?: { value?: string };
  description?: { value?: string };
  value?: { value?: string | number };
  properties?: Array<{ name: string; value: { value?: unknown } }>;
  childIds?: string[];
  backendDOMNodeId?: number;
}

/** 裁剪后的节点，树形结构 */
export interface PrunedNode {
  role: string;
  name: string;
  /** 附加语义：value / checked / pressed / expanded / disabled / description */
  props: Record<string, string>;
  backendNodeId?: number;
  children: SnapshotNode[];
}

/** 同构折叠后，快照树里的一个折叠组 */
export interface CollapsedGroup {
  kind: "collapsed-group";
  /** 组内项数 */
  count: number;
  /** 结构签名里出现的字段名，用于给模型解释折叠了什么 */
  fields: string[];
  /** 每一项的区别性摘要（不折叠掉，spec §5.2 缓解 2） */
  items: string[];
  /** 展开用的组 id，供 snapshot 的 expand 参数引用 */
  groupId: string;
}

export type SnapshotNode = PrunedNode | CollapsedGroup;

export function isCollapsedGroup(n: SnapshotNode): n is CollapsedGroup {
  return (n as CollapsedGroup).kind === "collapsed-group";
}

export interface SnapshotResult {
  /** 渲染好的缩进文本，直接给模型 */
  text: string;
  /** ref → backendNodeId 映射，仅本次快照有效 */
  refs: Map<string, number>;
  /** 统计，用于 benchmark */
  stats: { rawNodes: number; prunedNodes: number; collapsedGroups: number };
}

// ---------- 定位 ----------

export type Strategy =
  | { kind: "test-id"; value: string }
  | { kind: "container-role-name"; containerText: string; role: string; name: string; nth?: number }
  | { kind: "row-role-name"; rowText: string; role: string; name: string; nth?: number }
  | { kind: "role-name"; role: string; name: string; nth?: number }
  | { kind: "text"; tag: string; text: string; nth?: number }
  | { kind: "css"; value: string }
  | { kind: "xpath"; value: string };

export interface Descriptor {
  /** 按优先级排列，解析时依次尝试 */
  strategies: Strategy[];
  /** frame 路径，空数组表示主 frame */
  framePath: string[];
  /** 容器内区别性内容，用于同名元素兜底消歧（spec §6.4） */
  distinguishers?: string[];
}

export interface ResolveResult {
  backendNodeId: number;
  /** 命中的是第几条策略（0-based），用于漂移告警 */
  strategyIndex: number;
  strategyKind: Strategy["kind"];
}

// ---------- 执行 ----------

export type Step =
  | { action: "navigate"; url: string }
  | { action: "click"; target: TargetRef }
  | { action: "fill"; target: TargetRef; value: string }
  | { action: "select"; target: TargetRef; value: string }
  | { action: "press"; key: string }
  | { action: "hover"; target: TargetRef }
  | { action: "scroll"; target?: TargetRef; direction?: "up" | "down"; amount?: number }
  | { action: "wait"; until: WaitCondition; timeout?: number }
  | { action: "sleep"; ms: number }
  | { action: "assert"; type: AssertType; target?: TargetRef; expected?: string }
  | { action: "extract"; target: TargetRef; as: string; from?: "text" | "value" };

/** batch 里用 ref（本次快照的短期句柄）；trace 里用 descriptor（长期） */
export type TargetRef = { ref: string } | { descriptor: Descriptor };

export type WaitCondition =
  | { type: "visible"; target: TargetRef }
  | { type: "hidden"; target: TargetRef }
  | { type: "url-contains"; value: string }
  | { type: "response"; urlPattern: string };

export type AssertType = "visible" | "hidden" | "text-equals" | "text-contains" | "url-contains";

export interface StepResult {
  index: number;
  action: Step["action"];
  ok: boolean;
  durationMs: number;
  /** 命中的策略序号，仅 replay 时有值 */
  strategyIndex?: number;
  /** 漂移告警：命中的不是第一条策略 */
  drift?: { expected: Strategy["kind"]; actual: Strategy["kind"] };
  error?: string;
}

export type FailureKind =
  | "target-not-found"
  | "ambiguous"
  | "timeout"
  | "assert-failed"
  | "navigation-failed";

export interface FailureContext {
  failedIndex: number;
  failedStep: Step;
  kind: FailureKind;
  message: string;
  snapshot: string;
  candidates?: string[];
  consoleErrors: string[];
  failedRequests: string[];
}

// ---------- 轨迹 ----------

export interface Trace {
  name: string;
  baseUrl: string;
  createdAt: string;
  steps: Step[];
}

export interface RunRecord {
  traceName: string;
  startedAt: string;
  durationMs: number;
  ok: boolean;
  steps: StepResult[];
  drifts: Array<{ index: number; expected: string; actual: string }>;
  failure?: FailureContext;
  healRequired: boolean;
}

// ---------- role 白名单 ----------

export const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio",
  "combobox", "listbox", "option", "menuitem", "menuitemcheckbox",
  "menuitemradio", "tab", "switch", "slider", "spinbutton", "treeitem"
]);

export const SEMANTIC_TEXT_ROLES = new Set([
  "heading", "status", "alert", "alertdialog", "dialog", "tooltip"
]);

export function isInteractiveRole(role: string): boolean {
  return INTERACTIVE_ROLES.has(role);
}
