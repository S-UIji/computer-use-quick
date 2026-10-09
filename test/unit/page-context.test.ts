import { afterEach, describe, it, expect, vi } from "vitest";
import { readPageContext, renderPageContext } from "../../src/session/pageContext.js";
import type { PageHandle } from "../../src/session/browser.js";
afterEach(() => { vi.useRealTimers(); });
function handle(send: (method: string, params?: any) => Promise<any>, url: string): PageHandle {
  return { pageId: "target", page: { url: () => url, isClosed: () => false } as any, cdp: { send } as any };
}
describe("R17 文档标题真实性与隐私", () => {
  it("HTML无HTML标题时不把内联SVG标题冒充文档标题", async () => {
    const url = "http://example.test/page";
    const h = handle(async method => {
      if (method === "Target.getTargetInfo") return { targetInfo: { url, title: "example.test/page" } };
      if (method === "DOM.getDocument") return { root: { nodeId: 1, documentURL: url, children: [{ nodeId: 2, nodeType: 1, nodeName: "HTML" }] } };
      if (method === "DOM.querySelector") return { nodeId: 3 };
      if (method === "DOM.querySelectorAll") return { nodeIds: [3] };
      return { node: { nodeId: 3, nodeType: 1, nodeName: "title", children: [{ nodeType: 3, nodeValue: "SVG graphics caption" }] } };
    }, url);
    const context = await readPageContext(h);
    expect(context.title).toBe("");
    expect(renderPageContext(context, text => text)).not.toContain("SVG graphics caption");
  });
  it("文档标题的非ASCII边缘空白保留", async () => {
    const url = "http://example.test/page";
    const h = handle(async method => {
      if (method === "Target.getTargetInfo") return { targetInfo: { url, title: "fallback" } };
      if (method === "DOM.getDocument") return { root: { nodeId: 1, documentURL: url, children: [{ nodeId: 2, nodeType: 1, nodeName: "HTML" }] } };
      if (method === "DOM.querySelectorAll") return { nodeIds: [3] };
      return { node: { nodeId: 3, nodeType: 1, nodeName: "TITLE", children: [{ nodeType: 3, nodeValue: " \u00a0Title\u3000 " }] } };
    }, url);
    expect((await readPageContext(h)).title).toBe("\u00a0Title\u3000");
  });
  it("DOM超时后的浏览器URL标题不能泄露未知凭证", async () => {
    vi.useFakeTimers();
    const secret = "unknown-credential-r17", url = "http://example.test/page?token=" + secret;
    const h = handle(async method => {
      if (method === "Target.getTargetInfo") return { targetInfo: { url, title: url.slice(7) } };
      return new Promise(() => {});
    }, url);
    const pending = readPageContext(h);
    await vi.advanceTimersByTimeAsync(201);
    const text = renderPageContext(await pending, value => value);
    expect(text).not.toContain(secret); expect(text).toContain("文档标题不可获取");
  });
});
