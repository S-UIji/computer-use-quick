import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { takeSnapshot } from "../../src/perception/snapshot.js";
import { buildDescriptor } from "../../src/locator/descriptor.js";
import { resolve } from "../../src/locator/resolve.js";

let session: BrowserSession;
const fx = { url: "" };

beforeAll(async () => {
  fx.url = inject("fixtureURL");
  session = await BrowserSession.connect(inject("browserURL"));
});
afterAll(async () => { await session?.close(); });

async function open(path: string): Promise<PageHandle> {
  const h = await session.getPage();
  await h.page.goto(`${fx.url}/${path}`, { waitUntil: "load" });
  return h;
}

async function nodeIdOf(h: PageHandle, name: string, nth = 0): Promise<number> {
  const snap = await takeSnapshot(h, { threshold: 99 });
  const lines = snap.text.split("\n").filter((l) => l.includes(`"${name}"`));
  const ref = lines[nth].match(/\[(e\d+)\]/)![1];
  return snap.refs.get(ref)!;
}

describe("resolve", () => {
  it("往返一致：build 出的 descriptor 能解析回同一个节点", async () => {
    const h = await open("form.html");
    const original = await nodeIdOf(h, "登录");
    const r = await resolve(h, await buildDescriptor(h, original));
    expect(r.backendNodeId).toBe(original);
    expect(r.strategyIndex).toBe(0);
  });

  it("卡片墙第 2 个同名按钮能被容器锚定精确解析", async () => {
    const h = await open("cards-no-container.html");
    const original = await nodeIdOf(h, "查看在岗干部明细", 1);
    const r = await resolve(h, await buildDescriptor(h, original));
    expect(r.backendNodeId).toBe(original);
    expect(r.strategyKind).toBe("container-role-name");
  });

  it("表格第 3 行的删除按钮能被行锚定精确解析", async () => {
    const h = await open("table-dup.html");
    const original = await nodeIdOf(h, "删除", 2);
    const r = await resolve(h, await buildDescriptor(h, original));
    expect(r.backendNodeId).toBe(original);
    expect(r.strategyKind).toBe("row-role-name");
  });

  it("首选策略失效时回退到后续策略，strategyIndex 反映漂移", async () => {
    const h = await open("form.html");
    const d = await buildDescriptor(h, await nodeIdOf(h, "登录"));
    d.strategies.unshift({ kind: "role-name", role: "button", name: "并不存在的按钮" });
    const r = await resolve(h, d);
    expect(r.strategyIndex).toBeGreaterThan(0);
  });

  it("全部策略失效时抛 LocatorError(target-not-found)", async () => {
    const h = await open("form.html");
    await expect(
      resolve(h, { strategies: [{ kind: "css", value: "#nope-nope" }], framePath: [] })
    ).rejects.toMatchObject({ kind: "target-not-found" });
  });

  it("策略命中多个时跳到下一策略而非报错", async () => {
    const h = await open("cards-no-container.html");
    const d = {
      strategies: [
        { kind: "role-name", role: "button", name: "查看在岗干部明细" } as const, // 命中 3 个
        { kind: "css", value: "#clicked" } as const                                // 唯一
      ],
      framePath: []
    };
    const r = await resolve(h, d);
    expect(r.strategyIndex).toBe(1);
  });

  it("text 策略能按可见文本唯一命中", async () => {
    const h = await open("form.html");
    const r = await resolve(h, {
      strategies: [{ kind: "text", tag: "button", text: "登录" }],
      framePath: []
    });
    expect(r.backendNodeId).toBe(await nodeIdOf(h, "登录"));
  });

  it("xpath 兜底策略可用", async () => {
    const h = await open("form.html");
    const r = await resolve(h, {
      strategies: [{ kind: "xpath", value: '//*[@id="submit"]' }],
      framePath: []
    });
    expect(r.backendNodeId).toBe(await nodeIdOf(h, "登录"));
  });

  it("解析后页面上不残留任何临时标记属性", async () => {
    const h = await open("cards-no-container.html");
    await resolve(h, await buildDescriptor(h, await nodeIdOf(h, "查看在岗干部明细", 0)));
    await resolve(h, { strategies: [{ kind: "text", tag: "p", text: "未点击" }], framePath: [] });
    const { result } = await h.cdp.send("Runtime.evaluate", {
      expression: `document.querySelectorAll('[data-cuq-anchor],[data-cuq-text]').length`,
      returnByValue: true
    });
    expect((result as { value: number }).value).toBe(0);
  });
});
