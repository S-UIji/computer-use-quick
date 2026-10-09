import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, inject, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { createServer } from "../../src/server.js";

let session: BrowserSession, client: Client, server: ReturnType<typeof createServer>, page: PageHandle;
const css = (value: string) => ({ descriptor: { strategies: [{ kind: "css", value }], framePath: [] } });
const output = (result: any) => result.content.filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n");
beforeAll(async () => {
  session = await BrowserSession.connect(inject("browserURL"), { watch: false });
  server = createServer(session); client = new Client({ name: "r17-page-context", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s); await client.connect(c);
});
beforeEach(async () => { page = await session.newPage(); await page.page.goto(inject("fixtureURL") + "/form.html"); });
afterEach(async () => { vi.restoreAllMocks(); await page.page.close().catch(() => {}); });
afterAll(async () => { await client.close(); await server.close(); await session.close(); });
const batch = (steps: unknown[], vars?: Record<string, string>) =>
  client.callTool({ name: "batch", arguments: { pageId: page.pageId, steps, vars, resolveRetryMs: 0 } });
describe("R17 batch页面身份与入口", () => {
  it("成功和失败都显示可确认URL及标题", async () => {
    const ok = output(await batch([{ action: "sleep", ms: 1 }]));
    expect(ok).toContain("**当前 URL**"); expect(ok).toContain(page.page.url()); expect(ok).toContain("**当前标题**：表单");
    const failed = output(await batch([{ action: "click", target: css("#missing") }]));
    expect(failed).toContain("**当前 URL**"); expect(failed).toContain("**当前标题**：表单");
  });
  it("SPA URL和文档标题变化后返回最新身份", async () => {
    await page.page.evaluate(() => { history.pushState({}, "", "?phase=r17"); document.title = "R17 updated title"; });
    const text = output(await batch([{ action: "sleep", ms: 1 }]));
    expect(text).toContain("?phase=r17"); expect(text).toContain("**当前标题**：R17 updated title");
  });
  it("空标题明确显示无标题", async () => {
    await page.page.evaluate(() => { document.title = ""; });
    expect(output(await batch([{ action: "sleep", ms: 1 }]))).toContain("**当前标题**：（无标题）");
  });
  it("标题和URL按变量与凭证规则脱敏", async () => {
    const secret = "r17-private-value-long";
    await page.page.evaluate(value => { document.title = "Title " + value; history.pushState({}, "", "?token=" + value); }, secret);
    const text = output(await batch([{ action: "fill", target: css("#user"), value: "$" + "{R17_TOKEN}" }], { R17_TOKEN: secret }));
    const context = text.split("## 执行后快照")[0];
    expect(context).not.toContain(secret); expect(context).toContain("$" + "{R17_TOKEN}"); expect(context).toContain("**当前标题**");
  });
  it("元信息查询失败不改变成功结果，不伪称当前身份", async () => {
    const send = page.cdp.send.bind(page.cdp);
    vi.spyOn(page.cdp, "send").mockImplementation((async (method: string, params: any) => {
      if (method === "Target.getTargetInfo") throw new Error("metadata not available");
      return send(method as any, params);
    }) as any);
    const result = await batch([{ action: "sleep", ms: 1 }]);
    expect(result.isError).not.toBe(true); expect(output(result)).toContain("最后已知 URL"); expect(output(result)).toContain("标题不可获取");
  });
  it("后台返回元信息期间用户页保持可见", async () => {
    const user = await session.newPage();
    try {
      await user.page.bringToFront();
      const text = output(await batch([{ action: "fill", target: css("#user"), value: "background" }]));
      expect(text).toContain("**当前标题**：表单"); expect(await user.page.evaluate(() => document.visibilityState)).toBe("visible");
    } finally { await user.page.close(); }
  });
  it("坏末步在正确前缀副作用前拒绝且不回显值", async () => {
    const result = await batch([{ action: "fill", target: css("#user"), value: "should-not-write" },
      { action: "click", target: null }, { action: "sleep", ms: "secret-invalid-value" }]);
    const text = output(result);
    expect(result.isError).toBe(true); expect(text).toMatch(/第 2 步.*target/);
    expect(text).not.toMatch(/Cannot use|in operator|secret-invalid-value/);
    expect(await page.page.$eval("#user", node => (node as HTMLInputElement).value)).toBe("");
  });
});
