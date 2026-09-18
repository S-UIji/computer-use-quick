import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { takeSnapshot } from "../../src/perception/snapshot.js";
import { buildDescriptor } from "../../src/locator/descriptor.js";

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

/** 取快照里第 nth 个 role 为 button/textbox 等、name 匹配的元素 */
async function nodeIdOf(h: PageHandle, name: string, nth = 0): Promise<number> {
  const snap = await takeSnapshot(h, { threshold: 99 });
  const lines = snap.text.split("\n").filter((l) => l.includes(`"${name}"`));
  const ref = lines[nth].match(/\[(e\d+)\]/)![1];
  return snap.refs.get(ref)!;
}

describe("buildDescriptor", () => {
  it("全页唯一元素：第一条策略是 role-name", async () => {
    const h = await open("form.html");
    const d = await buildDescriptor(h, await nodeIdOf(h, "登录"));
    expect(d.strategies[0].kind).toBe("role-name");
    expect(d.strategies[0]).toMatchObject({ role: "button", name: "登录" });
  });

  it("卡片墙同名按钮：第一条策略是 container-role-name，带正确锚文本", async () => {
    const h = await open("cards-no-container.html");
    const d = await buildDescriptor(h, await nodeIdOf(h, "查看在岗干部明细", 1));
    expect(d.strategies[0].kind).toBe("container-role-name");
    expect(d.strategies[0]).toMatchObject({ containerText: "技术平台中心" });
  });

  it("表格同名按钮：第一条策略是 row-role-name", async () => {
    const h = await open("table-dup.html");
    const d = await buildDescriptor(h, await nodeIdOf(h, "删除", 2));
    expect(d.strategies[0].kind).toBe("row-role-name");
    expect(d.strategies[0]).toMatchObject({ rowText: "ORD20260913" });
  });

  it("策略链总是以 css 和 xpath 兜底收尾", async () => {
    const h = await open("form.html");
    const kinds = (await buildDescriptor(h, await nodeIdOf(h, "登录"))).strategies.map((s) => s.kind);
    expect(kinds).toContain("css");
    expect(kinds[kinds.length - 1]).toBe("xpath");
  });

  it("有 id 的元素，css 策略用 #id", async () => {
    const h = await open("form.html");
    const d = await buildDescriptor(h, await nodeIdOf(h, "登录"));
    const css = d.strategies.find((s) => s.kind === "css") as { value: string };
    expect(css.value).toBe("#submit");
  });

  it("记录 distinguishers 供同名兜底消歧", async () => {
    const h = await open("cards-no-container.html");
    const d = await buildDescriptor(h, await nodeIdOf(h, "查看在岗干部明细", 0));
    expect(d.distinguishers!.join(" ")).toContain("5081");
  });

  it("生成的 descriptor 不含任何临时标记属性残留", async () => {
    const h = await open("cards-no-container.html");
    await buildDescriptor(h, await nodeIdOf(h, "查看在岗干部明细", 0));
    const { result } = await h.cdp.send("Runtime.evaluate", {
      expression: `document.querySelectorAll('[data-cuq-anchor]').length`,
      returnByValue: true
    });
    expect((result as { value: number }).value).toBe(0);
  });

  it("StaticText（底层是 text 节点）也能固化成 descriptor", async () => {
    const h = await open("static-text.html");
    const snap = await takeSnapshot(h);
    const line = snap.text.split("\n").find((l) => l.includes("独立静态文本节点"))!;
    const ref = line.match(/\[(e\d+)\]/)![1];

    const d = await buildDescriptor(h, snap.refs.get(ref)!);
    const kinds = d.strategies.map((s) => s.kind);
    expect(kinds).toContain("text");
    expect(kinds[kinds.length - 1]).toBe("xpath");
    const text = d.strategies.find((s) => s.kind === "text") as { text: string };
    expect(text.text).toContain("独立静态文本节点");
  });
});
