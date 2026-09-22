import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { takeSnapshot } from "../../src/perception/snapshot.js";
import { findAnchor, markAncestors, clearMarks } from "../../src/locator/container.js";

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

/** 从快照里按 ref 顺序取第 n 个匹配 name 的元素的 backendNodeId */
async function nodeIdOf(h: PageHandle, name: string, nth = 0): Promise<number> {
  const snap = await takeSnapshot(h, { threshold: 99 });
  const lines = snap.text.split("\n").filter((l) => l.includes(`"${name}"`));
  const ref = lines[nth].match(/\[(e\d+)\]/)![1];
  return snap.refs.get(ref)!;
}

describe("findAnchor", () => {
  it("卡片墙里的同名按钮，能找到所属卡片的唯一锚文本", async () => {
    const h = await open("cards-no-container.html");
    const first = await findAnchor(h, await nodeIdOf(h, "查看在岗干部明细", 0));
    const second = await findAnchor(h, await nodeIdOf(h, "查看在岗干部明细", 1));
    expect(first?.anchorText).toBe("教育事业群");
    expect(second?.anchorText).toBe("技术平台中心");
    expect(first?.kind).toBe("container");
  });

  it("表格里的同名按钮，锚点识别为 row 且锚文本是单号", async () => {
    const h = await open("table-dup.html");
    const a = await findAnchor(h, await nodeIdOf(h, "删除", 1));
    expect(a?.kind).toBe("row");
    expect(a?.anchorText).toBe("ORD20260912");
  });

  it("收集容器内的区别性内容", async () => {
    const h = await open("cards-no-container.html");
    const a = await findAnchor(h, await nodeIdOf(h, "查看在岗干部明细", 0));
    expect(a?.distinguishers.join(" ")).toContain("5081");
  });

  it("全页唯一的元素（表单提交按钮）返回 null，无需容器锚定", async () => {
    const h = await open("form.html");
    expect(await findAnchor(h, await nodeIdOf(h, "登录"))).toBeNull();
  });

  it("markAncestors 打标记，clearMarks 清干净", async () => {
    const h = await open("cards-no-container.html");
    const { root } = (await h.cdp.send("DOM.getDocument", { depth: 0 })) as {
      root: { nodeId: number };
    };
    const levels = await markAncestors(h, root.nodeId, "教育事业群");
    expect(levels).toBeGreaterThan(0);

    const marked = await h.cdp.send("Runtime.evaluate", {
      expression: `document.querySelectorAll('[data-cuq-anchor]').length`,
      returnByValue: true
    });
    expect((marked.result as { value: number }).value).toBe(levels);

    await clearMarks(h, root.nodeId);
    const after = await h.cdp.send("Runtime.evaluate", {
      expression: `document.querySelectorAll('[data-cuq-anchor]').length`,
      returnByValue: true
    });
    expect((after.result as { value: number }).value).toBe(0);
  });
});
