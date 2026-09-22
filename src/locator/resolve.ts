import type { PageHandle } from "../session/browser.js";
import type { Descriptor, ResolveResult, Strategy, TargetRef } from "../types.js";
import { markAncestors, clearMarks, callOnDocument } from "./container.js";
import { scopeNodeId } from "../session/frames.js";

export class LocatorError extends Error {
  constructor(
    message: string,
    public kind: "target-not-found" | "ambiguous",
    public candidates: string[] = []
  ) {
    super(message);
    this.name = "LocatorError";
  }
}

async function backendIdOfNodeId(handle: PageHandle, nodeId: number): Promise<number> {
  const { node } = (await handle.cdp.send("DOM.describeNode", { nodeId })) as {
    node: { backendNodeId: number };
  };
  return node.backendNodeId;
}

/** 用 CSS 选择器在 scope 内找唯一元素；找不到或非唯一返回 null */
/** 元素是否真的"能点"：有布局盒且宽高大于 0。命中不可见节点时不能当作解析成功。 */
export async function isActionable(handle: PageHandle, backendNodeId: number): Promise<boolean> {
  try {
    const { model } = (await handle.cdp.send("DOM.getBoxModel", { backendNodeId })) as {
      model?: { width: number; height: number };
    };
    return !!model && model.width > 0 && model.height > 0;
  } catch {
    return false;
  }
}

async function bySelector(
  handle: PageHandle,
  scope: number,
  selector: string
): Promise<number | null> {
  const { nodeIds } = (await handle.cdp.send("DOM.querySelectorAll", {
    nodeId: scope,
    selector
  })) as { nodeIds: number[] };
  if (nodeIds.length !== 1) return null;
  return backendIdOfNodeId(handle, nodeIds[0]);
}

/** 在指定子树内按 role + accessibleName 查询，返回唯一命中的 backendNodeId */
async function byAx(
  handle: PageHandle,
  scopeNodeId: number,
  role: string,
  name: string
): Promise<number | null> {
  const { nodes } = (await handle.cdp.send("Accessibility.queryAXTree", {
    nodeId: scopeNodeId,
    accessibleName: name,
    role
  })) as { nodes: Array<{ backendDOMNodeId?: number; ignored?: boolean }> };
  const hits = nodes.filter((n) => !n.ignored && n.backendDOMNodeId !== undefined);
  return hits.length === 1 ? hits[0].backendDOMNodeId! : null;
}

/**
 * 锚定策略：给锚文本所在元素的祖先链打标记，由内向外逐层用 AX 查询，
 * 第一个唯一命中的层胜出。这正是真人的做法——先认是哪张卡，再点卡里的按钮。
 */
async function byAnchor(
  handle: PageHandle,
  scope: number,
  anchorText: string,
  role: string,
  name: string
): Promise<number | null> {
  // 打标在目标文档内执行（iframe 子文档走同一路径），查询用 scope 的 nodeId  pierce 进对应文档
  const levels = await markAncestors(handle, scope, anchorText);
  try {
    for (let i = 0; i < levels; i++) {
      const { nodeIds } = (await handle.cdp.send("DOM.querySelectorAll", {
        nodeId: scope,
        selector: `[data-cuq-anchor="${i}"]`
      })) as { nodeIds: number[] };
      if (nodeIds.length !== 1) continue;
      const hit = await byAx(handle, nodeIds[0], role, name);
      if (hit !== null) return hit;
    }
    return null;
  } finally {
    await clearMarks(handle, scope);
  }
}

/**
 * 文本策略：在目标文档内筛出唯一匹配并打临时标记，再用选择器取回。
 * 逐个 resolveNode 读 textContent 会是 2N 次 CDP 往返，页面稍大就不可接受。
 * 与锚定同路径：callFunctionOn 以 document 为执行主体，iframe 内同样适用。
 */
async function byText(
  handle: PageHandle,
  scope: number,
  tag: string,
  text: string
): Promise<number | null> {
  const fn = `function (tag, text) {
    var doc = this;
    doc.querySelectorAll("[data-cuq-text]").forEach(function (e) {
      e.removeAttribute("data-cuq-text");
    });
    var els = Array.prototype.slice.call(doc.querySelectorAll(tag)).filter(function (e) {
      return (e.textContent || "").trim() === text;
    });
    if (els.length !== 1) return 0;
    els[0].setAttribute("data-cuq-text", "1");
    return 1;
  }`;

  const marked = await callOnDocument<number>(handle, scope, fn, [{ value: tag }, { value: text }]);
  if (marked !== 1) return null;

  try {
    return await bySelector(handle, scope, "[data-cuq-text]");
  } finally {
    await callOnDocument(handle, scope, `function () {
      this.querySelectorAll("[data-cuq-text]")
        .forEach(function (e) { e.removeAttribute("data-cuq-text"); });
    }`);
  }
}

async function byXPath(handle: PageHandle, xpath: string): Promise<number | null> {
  // performSearch 需要文档已完整加载到 DOM 域
  await handle.cdp.send("DOM.getDocument", { depth: -1 });
  const { searchId, resultCount } = (await handle.cdp.send("DOM.performSearch", {
    query: xpath
  })) as { searchId: string; resultCount: number };

  try {
    if (resultCount !== 1) return null;
    const { nodeIds } = (await handle.cdp.send("DOM.getSearchResults", {
      searchId,
      fromIndex: 0,
      toIndex: 1
    })) as { nodeIds: number[] };
    return nodeIds.length === 1 ? backendIdOfNodeId(handle, nodeIds[0]) : null;
  } finally {
    await handle.cdp.send("DOM.discardSearchResults", { searchId }).catch(() => {});
  }
}

async function tryStrategy(
  handle: PageHandle,
  s: Strategy,
  scope: number
): Promise<number | null> {
  switch (s.kind) {
    case "test-id":
      return bySelector(
        handle, scope,
        `[data-testid="${s.value}"],[data-test="${s.value}"],[data-qa="${s.value}"]`
      );
    case "container-role-name":
      return byAnchor(handle, scope, s.containerText, s.role, s.name);
    case "row-role-name":
      return byAnchor(handle, scope, s.rowText, s.role, s.name);
    case "role-name":
      return byAx(handle, scope, s.role, s.name);
    case "text":
      return byText(handle, scope, s.tag, s.text);
    case "css":
      return bySelector(handle, scope, s.value);
    case "xpath":
      return byXPath(handle, s.value);
  }
}

export interface ResolveOptions {
  /**
   * 交互类动作（click/fill/select/hover）要求目标"可见且可点"。
   * 命中不可见节点时不当成解析成功，而是继续试后面的策略——
   * 否则会拿着一个 display:none 的节点去 scrollIntoView/派发鼠标事件，
   * 报出来的是 `Node does not have a layout object` 这种看不懂的协议错误。
   */
  requireActionable?: boolean;
  /**
   * 解析失败后的轮询重试预算（ms），默认 0 = 一次性解析。
   * 页面异步渲染时目标可能晚到几百毫秒（前一步的条件满足 ≠ DOM 渲染完），
   * 一次性判负会把「还没渲染出来」误报成「元素不存在」。
   */
  retryMs?: number;
}

async function resolveOnce(
  handle: PageHandle,
  d: Descriptor,
  opts: ResolveOptions
): Promise<ResolveResult> {
  // scope 必须在每次尝试内重取：上一尝试到现在页面可能已经导航，旧 documentNodeId 已失效
  const scope = await scopeNodeId(handle, d.framePath);
  const tried: string[] = [];
  /** 命中过但不可见/不可点的元素，留到全部策略都落空时报错用 */
  let invisibleHit: number | null = null;

  for (let i = 0; i < d.strategies.length; i++) {
    const s = d.strategies[i];
    let id: number | null = null;
    try {
      id = await tryStrategy(handle, s, scope);
    } catch {
      id = null;
    }
    if (id !== null) {
      if (!opts.requireActionable || (await isActionable(handle, id))) {
        return { backendNodeId: id, strategyIndex: i, strategyKind: s.kind };
      }
      invisibleHit ??= id;
      tried.push(`${s.kind}(命中但不可见)`);
      continue;
    }
    tried.push(s.kind);
  }

  if (invisibleHit !== null) {
    throw new LocatorError(
      `命中了元素但它不可见/不可点击（无布局盒），已继续尝试其余策略：${tried.join(" → ")}`,
      "target-not-found",
      d.distinguishers ?? []
    );
  }

  throw new LocatorError(
    `全部 ${d.strategies.length} 条策略均未唯一命中：${tried.join(" → ")}`,
    "target-not-found",
    d.distinguishers ?? []
  );
}

export async function resolve(
  handle: PageHandle,
  d: Descriptor,
  opts: ResolveOptions = {}
): Promise<ResolveResult> {
  const deadline = Date.now() + (opts.retryMs ?? 0);

  for (;;) {
    try {
      return await resolveOnce(handle, d, opts);
    } catch (err) {
      // target-not-found 与 ambiguous 都可能是渲染中途态，值得重试；
      // 其它异常（协议错误等）重试无意义，直接抛
      if (!(err instanceof LocatorError) || Date.now() >= deadline) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

export async function resolveTarget(
  handle: PageHandle,
  target: TargetRef,
  refs: Map<string, number>,
  opts: ResolveOptions = {}
): Promise<ResolveResult> {
  if ("ref" in target) {
    const id = refs.get(target.ref);
    if (id === undefined) {
      throw new LocatorError(
        `ref ${target.ref} 不在当前快照中，请重新 snapshot`,
        "target-not-found"
      );
    }
    return { backendNodeId: id, strategyIndex: -1, strategyKind: "css" };
  }
  return resolve(handle, target.descriptor, opts);
}
