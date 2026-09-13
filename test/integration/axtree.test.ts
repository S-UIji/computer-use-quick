import { describe, it, expect, beforeAll, afterAll } from "vitest";
import puppeteer, { type Browser } from "puppeteer";
import { BrowserSession } from "../../src/session/browser.js";
import { startFixtureServer } from "../fixtures/server.js";
import { fetchAxTree, indexById, buildTree } from "../../src/perception/axtree.js";

let chrome: Browser, session: BrowserSession, fx: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  fx = await startFixtureServer();
  chrome = await puppeteer.launch({ headless: true, args: ["--remote-debugging-port=9334", "--no-sandbox"] });
  session = await BrowserSession.connect("http://127.0.0.1:9334");
  const h = await session.getPage();
  await h.cdp.send("Page.enable");
  await h.page.goto(`${fx.url}/form.html`, { waitUntil: "load" });
});

afterAll(async () => { await session?.close(); await chrome?.close(); await fx?.close(); });

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
