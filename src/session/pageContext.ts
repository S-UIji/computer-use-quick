import type { PageHandle } from "./browser.js";
import { displayPageUrl } from "./pageUrl.js";
import type { VariableRedactor } from "../report/variablePrivacy.js";

export interface PageContext {
  url: string;
  title?: string;
  current: boolean;
  closed: boolean;
}

const TITLE_BUDGET_MS = 200;

/** DOM读取无需求值，但同页弹窗仍可能阻塞；预算到点后不再发后续DOM请求。 */
async function documentTitle(handle: PageHandle, expectedUrl: string): Promise<string | undefined> {
  let expired = false, timer: ReturnType<typeof setTimeout> | undefined;
  const read = async (): Promise<string | undefined> => {
    const { root } = await handle.cdp.send("DOM.getDocument", { depth: 1 });
    if (expired || root.documentURL !== expectedUrl) return undefined;
    const element = root.children?.find(node => node.nodeType === 1);
    // 普通HTML文档的HTML节点/标题节点为大写；SVG/XML不凭全局title猜测。
    if (element?.nodeName !== "HTML") return undefined;
    const { nodeIds } = await handle.cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "title" });
    if (expired) return undefined;
    for (const nodeId of nodeIds) {
      const { node } = await handle.cdp.send("DOM.describeNode", { nodeId, depth: 1 });
      if (expired) return undefined;
      if (node.nodeName !== "TITLE") continue;
      return (node.children ?? []).filter(child => child.nodeType === 3 || child.nodeType === 4)
        .map(child => child.nodeValue).join("").replace(/[\t\n\f\r ]+/g, " ").replace(/^ +| +$/g, "");
    }
    return "";
  };
  try {
    return await Promise.race([
      read(),
      new Promise<undefined>(resolve => { timer = setTimeout(() => { expired = true; resolve(undefined); }, TITLE_BUDGET_MS); })
    ]);
  } catch { return undefined; }
  finally { expired = true; if (timer !== undefined) clearTimeout(timer); }
}

export async function readPageContext(handle: PageHandle): Promise<PageContext> {
  const lastKnown = (): PageContext => {
    let url = "（无法读取 URL）";
    try { url = displayPageUrl(handle.page.url()); } catch {}
    return { url, current: false, closed: handle.page.isClosed() };
  };
  if (handle.page.isClosed()) return lastKnown();
  try {
    const { targetInfo } = await handle.cdp.send("Target.getTargetInfo");
    if (handle.page.isClosed()) return lastKnown();
    const title = await documentTitle(handle, targetInfo.url);
    if (handle.page.isClosed()) return lastKnown();
    const latest = await handle.cdp.send("Target.getTargetInfo");
    if (handle.page.isClosed()) return lastKnown();
    return { url: displayPageUrl(latest.targetInfo.url),
      title: latest.targetInfo.url === targetInfo.url ? title : undefined,
      current: true, closed: false };
  } catch { return lastKnown(); }
}

export function renderPageContext(context: PageContext, redact: VariableRedactor): string {
  const label = context.current ? "当前 URL" : context.closed ? "最后已知 URL（页面已关闭）" : "最后已知 URL（无法确认当前页面）";
  const title = context.current && context.title !== undefined
    ? "**当前标题**：" + (context.title ? redact(context.title) : "（无标题）")
    : "**文档标题不可获取**";
  return "**" + label + "**：" + redact(context.url) + "\n" + title + "\n\n";
}
