import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { BrowserSession } from "../../src/session/browser.js";
import { fetchAxTree, indexById, buildTree } from "../../src/perception/axtree.js";

let session: BrowserSession;
const fx = { url: "" };

beforeAll(async () => {
  fx.url = inject("fixtureURL");
  session = await BrowserSession.connect(inject("browserURL"));
  const h = await session.getPage();
  await h.cdp.send("Page.enable");
  await h.page.goto(`${fx.url}/form.html`, { waitUntil: "load" });
});

afterAll(async () => { await session?.close(); });

describe("fetchAxTree", () => {
  it("抓到的节点数大于 10", async () => {
    const h = await session.getPage();
    const nodes = await fetchAxTree(h.cdp);
    expect(nodes.length).toBeGreaterThan(10);
  });

  it("包含登录按钮，且带 backendDOMNodeId", async () => {
    const h = await session.getPage();
    const nodes = await fetchAxTree(h.cdp);
    const btn = nodes.find((n) => n.role?.value === "button" && n.name?.value === "登录");
    expect(btn).toBeDefined();
    expect(btn!.backendDOMNodeId).toBeGreaterThan(0);
  });

  it("buildTree 能找到 RootWebArea 根节点", async () => {
    const h = await session.getPage();
    const nodes = await fetchAxTree(h.cdp);
    const root = buildTree(nodes);
    expect(root?.role?.value).toBe("RootWebArea");
  });

  it("indexById 建出与节点数等长的索引", async () => {
    const h = await session.getPage();
    const nodes = await fetchAxTree(h.cdp);
    expect(indexById(nodes).size).toBe(nodes.length);
  });
});
