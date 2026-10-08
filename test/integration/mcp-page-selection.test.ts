import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import puppeteer, { type Browser, type Page, type Target } from "puppeteer-core";

// 真 stdio 验证模型看到的选页语义；只创建、操作和清理本文件拥有的页面。
// 前置：npm run build。服务端 cwd 放临时目录，回放归档不会污染仓库。
let browser: Browser;
let client: Client;
let work: string;
let userPage: Page;
let operationPage: Page;
let userUrl: string;
let operationId: string;
const owned = new Set<Page>();

function pageId(page: Page): string {
  return (page.target() as Target & { _targetId: string })._targetId;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

function css(value: string) {
  return { descriptor: { strategies: [{ kind: "css", value }], framePath: [] } };
}

function selectedId(list: string): string | undefined {
  return list.match(/^\* ([^\s]+)$/m)?.[1];
}

async function userState() {
  return {
    url: userPage.url(),
    html: await userPage.content(),
    value: await userPage.$eval("#private-note", (element) => (element as HTMLInputElement).value)
  };
}

beforeAll(async () => {
  browser = await puppeteer.connect({ browserURL: inject("browserURL"), defaultViewport: null });
});

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "cuq-mcp-page-selection-"));
  userPage = await browser.newPage();
  owned.add(userPage);
  userUrl = `data:text/html;charset=utf-8,${encodeURIComponent(
    '<!doctype html><title>用户自己的页面</title><label>私人备注<input id="private-note" value="用户未提交内容"></label>'
  )}`;
  await userPage.goto(userUrl);
  operationPage = await browser.newPage();
  owned.add(operationPage);
  operationId = pageId(operationPage);
  await operationPage.goto(`${inject("fixtureURL")}/form.html#${work.split(/[\\/]/).pop()}`);

  client = new Client({ name: "r7-page-selection", version: "1" });
  const env = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/index.js")],
    cwd: work,
    env: { ...env, CUQ_BROWSER_URL: inject("browserURL"), CUQ_WATCH: "off", CUQ_LAUNCH: "" },
    stderr: "pipe"
  });
  await client.connect(transport);
  const initial = await client.callTool({ name: "snapshot", arguments: { pageId: operationId } });
  expect(initial.isError).not.toBe(true);
  expect(selectedId(text(await client.callTool({ name: "list_pages", arguments: {} })))).toBe(operationId);
});

afterEach(async () => {
  await client?.close();
  for (const page of owned) {
    if (!page.isClosed()) await page.close().catch(() => {});
  }
  owned.clear();
  if (work) await rm(work, { recursive: true, force: true });
});

afterAll(() => { browser?.disconnect(); });

describe("MCP page selection（真实 SDK / stdio）", () => {
  it("显式无效或已关闭 pageId 拒绝执行，不改变原默认页与用户页面", async () => {
    const beforeUser = await userState();
    const beforePages = (await browser.pages()).map(pageId).sort();
    const missing = await client.callTool({ name: "batch", arguments: {
      pageId: "r7-page-does-not-exist",
      // 只读操作：即使红测暴露旧的 pages[0] 回退，也不改动共享首个标签页。
      steps: [{ action: "assert", type: "url-contains", expected: "/form.html" }]
    } });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("list_pages");
    expect(text(missing)).toContain("r7-page-does-not-exist");
    expect((await browser.pages()).map(pageId).sort()).toEqual(beforePages);
    expect(await userState()).toEqual(beforeUser);
    expect(selectedId(text(await client.callTool({ name: "list_pages", arguments: {} })))).toBe(operationId);

    await userPage.close();
    const closedId = pageId(userPage);
    const afterClose = (await browser.pages()).map(pageId).sort();
    const closed = await client.callTool({ name: "batch", arguments: {
      pageId: closedId,
      steps: [{ action: "assert", type: "url-contains", expected: "/form.html" }]
    } });
    expect(closed.isError).toBe(true);
    expect(text(closed)).toContain("list_pages");
    expect(text(closed)).toContain(closedId);
    expect((await browser.pages()).map(pageId).sort()).toEqual(afterClose);
    expect(selectedId(text(await client.callTool({ name: "list_pages", arguments: {} })))).toBe(operationId);
    expect(operationPage.url()).toContain("/form.html");
  });

  it("默认页关闭后列页不接管其它页，隐式操作新建页面并只告知一次", async () => {
    const beforeUser = await userState();
    const snapshot = text(await client.callTool({ name: "snapshot", arguments: {} }));
    const oldRef = snapshot.split("\n").find((line) => line.includes('textbox "用户名"'))?.match(/\[(e\d+)\]/)?.[1];
    expect(oldRef).toBeDefined();
    await operationPage.close();
    const remainingIds = (await browser.pages()).map(pageId).sort();

    const listed = text(await client.callTool({ name: "list_pages", arguments: {} }));
    expect(selectedId(listed)).toBeUndefined();
    expect((await browser.pages()).map(pageId).sort()).toEqual(remainingIds);
    expect(await userState()).toEqual(beforeUser);

    const recoveredUrl = `${inject("fixtureURL")}/form.html#recovered-${work.split(/[\\/]/).pop()}`;
    const recovered = await client.callTool({ name: "batch", arguments: {
      steps: [{ action: "navigate", url: recoveredUrl }]
    } });
    // 只认本次导航的唯一 URL；绝不把共享 Chrome 的未知页面加入清理集合。
    const newPages = (await browser.pages()).filter((page) => page.url() === recoveredUrl);
    for (const page of newPages) owned.add(page);
    expect(recovered.isError).not.toBe(true);
    expect(newPages).toHaveLength(1);
    const replacement = newPages[0];
    const replacementId = pageId(replacement);
    expect(remainingIds).not.toContain(replacementId);
    expect(text(recovered)).toContain(operationId);
    expect(text(recovered)).toContain(replacementId);
    expect(text(recovered)).toMatch(/新建|新开|创建/);
    expect((await browser.pages()).map(pageId).sort()).toEqual([...remainingIds, replacementId].sort());

    const listedAgain = text(await client.callTool({ name: "list_pages", arguments: {} }));
    expect(selectedId(listedAgain)).toBe(replacementId);
    expect(listedAgain).not.toContain(operationId);
    const snapshotAgain = text(await client.callTool({ name: "snapshot", arguments: {} }));
    expect(snapshotAgain).not.toContain(operationId);

    // 旧 ID / ref 必须一起失效，不能被转投给用户页或恢复后的新页面。
    const stale = await client.callTool({ name: "batch", arguments: {
      pageId: operationId,
      steps: [{ action: "fill", target: { ref: oldRef }, value: "不应被写入" }]
    } });
    expect(stale.isError).toBe(true);
    expect(text(stale)).toContain("list_pages");
    expect(await replacement.$eval("#user", (element) => (element as HTMLInputElement).value)).toBe("");
    expect(await userState()).toEqual(beforeUser);
  });

  it("batch 执行中关闭目标页返回 page-closed，停止后续操作且不接管用户页", async () => {
    const beforeUser = await userState();
    const remainingIds = (await browser.pages()).map(pageId).filter((id) => id !== operationId).sort();
    let closing: Promise<void> | undefined;
    const progress: number[] = [];
    const result = await client.callTool({ name: "batch", arguments: {
      pageId: operationId,
      steps: [
        { action: "fill", target: css("#user"), value: "执行已开始" },
        { action: "wait", until: { type: "response", urlPattern: "/r7-never-requested" }, timeout: 20_000 },
        { action: "navigate", url: `${inject("fixtureURL")}/form.html#must-not-run` }
      ]
    } }, undefined, {
      timeout: 8000,
      onprogress: (notification) => {
        progress.push(notification.progress);
        if (notification.progress === 1 && !closing) closing = operationPage.close();
      }
    });
    await closing;
    expect(closing).toBeDefined();
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("page-closed");
    expect(text(result)).toContain(operationId);
    expect(progress).not.toContain(3);
    expect((await browser.pages()).map(pageId).sort()).toEqual(remainingIds);
    expect(await userState()).toEqual(beforeUser);
  });

  it("suite 页面关闭不重试，heal_step 拒修且保留 trace", async () => {
    const beforeUser = await userState();
    const suiteUrl = `${inject("fixtureURL")}/form.html#suite-${work.split(/[\\/]/).pop()}`;
    const tracePath = join(work, "closed-suite.json");
    const trace = JSON.stringify({
      name: "closed-suite", baseUrl: inject("fixtureURL"), createdAt: "",
      steps: [
        { action: "navigate", url: suiteUrl },
        { action: "fill", target: css("#user"), value: "suite-running" },
        { action: "wait", until: { type: "response", urlPattern: "/r7-never-requested" }, timeout: 20_000 }
      ]
    });
    await writeFile(tracePath, trace, "utf8");
    const attempts = new Set<string>();
    const noticeTarget = (target: Target) => {
      if (target.type() !== "page" || target.url() !== suiteUrl) return;
      void target.page().then((page) => {
        if (page) { owned.add(page); attempts.add(pageId(page)); }
      }).catch(() => {}); // 目标可能紧接着关闭，不能制造无关的未处理拒绝。
    };
    browser.on("targetchanged", noticeTarget);
    let suiteRun: ReturnType<Client["callTool"]> | undefined;
    try {
      const targetReady = browser.waitForTarget((target) => target.type() === "page" && target.url() === suiteUrl,
        { timeout: 8000 });
      suiteRun = client.callTool({ name: "replay_suite", arguments: {
        tracePaths: [tracePath], concurrency: 1
      } }, undefined, { timeout: 10_000 });
      void suiteRun.catch(() => {}); // 等待外部可观察信号期间也接住服务端的提前失败。
      const target = await targetReady;
      const suitePage = await target.page();
      expect(suitePage).not.toBeNull();
      owned.add(suitePage!);
      attempts.add(pageId(suitePage!));
      await suitePage!.waitForFunction(() =>
        (document.querySelector("#user") as HTMLInputElement | null)?.value === "suite-running",
      { timeout: 5000 });
      await suitePage!.close();
      const result = await suiteRun;
      expect(text(result)).toContain("page-closed");
      expect(text(result)).toContain("SUITE_RESULT ok=0 failed=1 total=1");
      expect(text(result)).toContain("heal_required=false");
      expect(attempts.size).toBe(1);
      for (let i = 0; i < 3; i++) {
        const heal = await client.callTool({ name: "heal_step", arguments: {
          tracePath, actions: [{ action: "sleep", ms: 1 }]
        } });
        expect(heal.isError).toBe(true);
        expect(text(heal)).toMatch(/page-closed|页面.*关闭|标签页.*关闭/);
        expect(text(heal)).not.toContain("上限");
      }
      expect(await readFile(tracePath, "utf8")).toBe(trace);
      expect(await userState()).toEqual(beforeUser);
    } finally {
      browser.off("targetchanged", noticeTarget);
      await suiteRun?.catch(() => {});
    }
  });
});
