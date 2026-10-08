import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import puppeteer, { type Browser, type Page, type Target } from "puppeteer-core";

// 真 stdio 验证 URL 提示与失败上下文；共享 Chrome 中仅操作和清理自己创建的标签页。
// 前置：npm run build。每个用例启动独立 MCP 进程，保证 URL 基线互不影响。
let browser: Browser;
let client: Client;
let work: string;
let page: Page;
let initialUrl: string;
const owned = new Set<Page>();
const changedNotice = "页面自上次快照或批次结束后已变化";

function pageId(targetPage: Page): string {
  return (targetPage.target() as Target & { _targetId: string })._targetId;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

function css(value: string) {
  return { descriptor: { strategies: [{ kind: "css", value }], framePath: [] } };
}

function snapshot(targetPage = page, diff = false) {
  return client.callTool({ name: "snapshot", arguments: { pageId: pageId(targetPage), diff } });
}

function batch(steps: Record<string, unknown>[], targetPage = page) {
  return client.callTool({ name: "batch", arguments: {
    pageId: pageId(targetPage), steps, resolveRetryMs: 0,
    stability: { domQuietMs: 10, networkQuietMs: 10, timeoutMs: 1000 }
  } });
}

function expectChange(result: Awaited<ReturnType<Client["callTool"]>>, before: string, after: string) {
  const output = text(result);
  expect(output).toContain(changedNotice);
  expect(output).toContain(before);
  expect(output).toContain(after);
  expect(output).toContain("ref 可能已失效");
  expect(output).toContain("snapshot");
  return output;
}

beforeAll(async () => {
  browser = await puppeteer.connect({ browserURL: inject("browserURL"), defaultViewport: null });
});

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "cuq-mcp-page-url-"));
  page = await browser.newPage();
  owned.add(page);
  initialUrl = `${inject("fixtureURL")}/form.html`;
  await page.goto(initialUrl);

  client = new Client({ name: "r8-page-url", version: "1" });
  const env = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined));
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/index.js")],
    cwd: work,
    env: { ...env, CUQ_BROWSER_URL: inject("browserURL"), CUQ_WATCH: "off", CUQ_LAUNCH: "" },
    stderr: "pipe"
  }));
});

afterEach(async () => {
  await client?.close();
  for (const ownedPage of owned) {
    if (!ownedPage.isClosed()) await ownedPage.close().catch(() => {});
  }
  owned.clear();
  if (work) await rm(work, { recursive: true, force: true });
});

afterAll(() => { browser?.disconnect(); });

describe("MCP 页面 URL 变化提示（真实 SDK / stdio）", () => {
  it("首次 batch 没有观察基线时不告警，并正常执行", async () => {
    await page.goto(`${initialUrl}?first=1`);
    const result = await batch([{ action: "fill", target: css("#user"), value: "首次操作" }]);
    expect(result.isError).not.toBe(true);
    expect(text(result)).not.toContain(changedNotice);
    expect(await page.$eval("#user", (element) => (element as HTMLInputElement).value)).toBe("首次操作");
  });

  it("snapshot 后用户导航时给出前缀提示，动作照常执行且下一批不重复告警", async () => {
    expect((await snapshot()).isError).not.toBe(true);
    const nextUrl = `${initialUrl}?view=after-user-navigation`;
    await page.goto(nextUrl);
    const result = await batch([
      { action: "fill", target: css("#user"), value: "继续执行" },
      { action: "click", target: css("#submit") }
    ]);
    expect(result.isError).not.toBe(true);
    const output = expectChange(result, initialUrl, nextUrl);
    expect(output.indexOf(changedNotice)).toBeLessThan(output.indexOf("✅"));
    expect(await page.$eval("#result", (element) => element.textContent)).toBe("欢迎 继续执行");

    const again = await batch([{ action: "fill", target: css("#user"), value: "下一批" }]);
    expect(again.isError).not.toBe(true);
    expect(text(again)).not.toContain(changedNotice);
  });

  it("页面变化后旧快照的文本断言失败，返回 URL 提示及失败现场当前 URL", async () => {
    const before = await snapshot();
    const oldRef = text(before).split("\n")
      .find((line) => line.includes('textbox "用户名"'))?.match(/\[(e\d+)\]/)?.[1];
    expect(oldRef).toBeDefined();
    const nextUrl = `${initialUrl}?view=old-ref-invalid`;
    await page.goto(nextUrl);
    // 旧 ref 可能仍能解析；让原快照的业务断言不满足，以验证失败报告而非假定 ref 必然失效。
    const result = await batch([{ action: "assert", type: "text-equals", target: { ref: oldRef }, expected: "已登录工作区" }]);
    expect(result.isError).toBe(true);
    const output = expectChange(result, initialUrl, nextUrl);
    expect(output).toContain("当前 URL");
    expect(output.slice(output.indexOf("当前 URL"))).toContain(nextUrl);
    // 失效节点可能先被 CDP 拒绝；保留既有 action-failed / assert-failed 分类。
    expect(output).toMatch(/失败：(action-failed|assert-failed)/);
    expect(await page.$eval("#user", (element) => (element as HTMLInputElement).value)).toBe("");
  });

  it("用户导航后 snapshot diff 刷新 URL 基线，下次 batch 不再提示旧变化", async () => {
    await snapshot();
    await page.goto(`${initialUrl}?view=refreshed-snapshot`);
    const refreshed = await snapshot(page, true);
    expect(refreshed.isError).not.toBe(true);
    expect(text(refreshed)).toContain("快照 diff");
    const result = await batch([{ action: "fill", target: css("#user"), value: "已重新观察" }]);
    expect(result.isError).not.toBe(true);
    expect(text(result)).not.toContain(changedNotice);
  });

  it("batch 自己导航成功后按终态更新基线，不把自身导航当成外部变化", async () => {
    await snapshot();
    const nextUrl = `${initialUrl}?view=batch-navigation`;
    const navigated = await batch([{ action: "navigate", url: nextUrl }]);
    expect(navigated.isError).not.toBe(true);
    expect(text(navigated)).not.toContain(changedNotice);
    expect(page.url()).toBe(nextUrl);

    const result = await batch([{ action: "fill", target: css("#user"), value: "导航之后" }]);
    expect(result.isError).not.toBe(true);
    expect(text(result)).not.toContain(changedNotice);
  });

  it("batch 导航后后续步骤失败也记录终态 URL，下一批不误报变化", async () => {
    await snapshot();
    const nextUrl = `${initialUrl}?view=failed-batch`;
    const failed = await batch([
      { action: "navigate", url: nextUrl },
      { action: "click", target: css("#r8-missing") }
    ]);
    expect(failed.isError).toBe(true);
    expect(text(failed)).not.toContain(changedNotice);
    expect(text(failed)).toContain("target-not-found");
    expect(text(failed)).toContain("当前 URL");
    expect(text(failed).slice(text(failed).indexOf("当前 URL"))).toContain(nextUrl);

    const result = await batch([{ action: "fill", target: css("#user"), value: "失败后继续" }]);
    expect(result.isError).not.toBe(true);
    expect(text(result)).not.toContain(changedNotice);
  });

  it("按 pageId 隔离 URL 基线，只提示实际发生变化的页面", async () => {
    const otherPage = await browser.newPage();
    owned.add(otherPage);
    const otherUrl = `${initialUrl}?page=other`;
    await otherPage.goto(otherUrl);
    await snapshot();
    await snapshot(otherPage);
    const nextUrl = `${initialUrl}?page=changed`;
    await page.goto(nextUrl);

    const unchanged = await batch([{ action: "fill", target: css("#user"), value: "另一页" }], otherPage);
    expect(unchanged.isError).not.toBe(true);
    expect(text(unchanged)).not.toContain(changedNotice);
    expect(otherPage.url()).toBe(otherUrl);

    const changed = await batch([{ action: "fill", target: css("#user"), value: "变化页" }]);
    expect(changed.isError).not.toBe(true);
    expectChange(changed, initialUrl, nextUrl);
  });

  it.each([
    { name: "query pushState", suffix: "?view=spa-query", method: "pushState" as const },
    { name: "hash replaceState", suffix: "#spa-route", method: "replaceState" as const }
  ])("同文档 $name 改变完整 URL 也会提示", async ({ suffix, method }) => {
    await snapshot();
    const nextUrl = initialUrl + suffix;
    await page.evaluate((url, historyMethod) => window.history[historyMethod]({}, "", url), nextUrl, method);
    const result = await batch([{ action: "fill", target: css("#user"), value: "同文档路由" }]);
    expect(result.isError).not.toBe(true);
    expectChange(result, initialUrl, nextUrl);
  });

  it("敏感 query 仅值改变时仍检测变化，告警及失败当前 URL 均不泄露值", async () => {
    const beforeSecret = "r8-first-private-token";
    const afterSecret = "r8-second-private-token";
    await page.evaluate((url) => window.history.pushState({}, "", url), `${initialUrl}?token=${beforeSecret}`);
    await snapshot();
    await page.evaluate((url) => window.history.replaceState({}, "", url), `${initialUrl}?token=${afterSecret}`);
    const result = await batch([{ action: "click", target: css("#r8-missing") }]);
    expect(result.isError).toBe(true);
    const output = text(result);
    expect(output).toContain(changedNotice);
    expect(output).toContain("ref 可能已失效");
    expect(output).toContain("当前 URL");
    expect(output).toContain(initialUrl);
    expect(output).not.toContain(beforeSecret);
    expect(output).not.toContain(afterSecret);
  });
});
