import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startFixtureServer } from "../fixtures/server.js";

// 这个文件测的就是 fixture 服务本身，所以起自己的实例，不用全局共享那个
let server: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => { server = await startFixtureServer(); });
afterAll(async () => { await server?.close(); });

describe("fixture server", () => {
  it("返回可访问的 url", () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("能取到七个 fixture 页面", async () => {
    const pages = [
      "form", "async-list", "table-dup",
      "cards-no-container", "modal-iframe", "iframe-inner", "homo-list"
    ];
    for (const p of pages) {
      const res = await fetch(`${server.url}/${p}.html`);
      expect(res.status, `${p}.html 应可访问`).toBe(200);
      expect(await res.text()).toContain("<html");
    }
  });

  it("慢接口返回订单数据", async () => {
    const res = await fetch(`${server.url}/api/orders`);
    expect(res.status).toBe(200);
    expect(await res.json()).toContain("ORD20260911");
  });

  it("未知路径返回 404", async () => {
    const res = await fetch(`${server.url}/nope.html`);
    expect(res.status).toBe(404);
  });
});
