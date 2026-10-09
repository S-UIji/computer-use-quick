import { createServer, type Server } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { BrowserSession } from "../../src/session/browser.js";
import { DiagnosticsCollector } from "../../src/diagnostics/collector.js";

let session: BrowserSession;
let server: Server;
let url: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url!, "http://localhost").pathname;
    if (path === "/" || path === "/nested") {
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(`<title>favicon diagnostic</title>${path === "/nested" ? '<link rel="icon" href="/assets/icons/favicon.ico?v=17">' : ""}<p>diagnostic fixture</p>`);
    } else {
      res.writeHead(path === "/api/server-error" ? 500 : 404, { "Cache-Control": "no-store" });
      res.end("Missing fixture resource");
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  url = `http://127.0.0.1:${address.port}`;
  session = await BrowserSession.connect(inject("browserURL"), { watch: false });
});

afterAll(async () => {
  await session?.close();
  await new Promise<void>((resolve, reject) => server?.close(error => error ? reject(error) : resolve()));
});

describe("favicon diagnostics with real CDP", () => {
  it.each([
    ["automatic", "/", "/favicon.ico"],
    ["nested-query", "/nested", "/assets/icons/favicon.ico?v=17"]
  ])("omits confirmed %s favicon 404 from both diagnostic channels", async (label, path, icon) => {
    const isolated = await session.newIsolatedPage();
    const h = isolated.handle;
    const c = await DiagnosticsCollector.attach(h);
    const events: unknown[] = [];
    for (const name of ["Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFinished", "Log.entryAdded"]) {
      h.cdp.on(name as never, event => events.push({ name, event }));
    }
    try {
      await h.page.goto(`${url}${path}`, { waitUntil: "networkidle0" });
      await expect.poll(() => events.some(item => {
        const e = item as { name: string; event: { response?: { url: string; status: number } } };
        return e.name === "Network.responseReceived" && e.event.response?.url === `${url}${icon}` && e.event.response.status === 404;
      })).toBe(true);
      await expect.poll(() => events.some(item => {
        const e = item as { name: string; event: { entry?: { url?: string } } };
        return e.name === "Log.entryAdded" && e.event.entry?.url === `${url}${icon}`;
      })).toBe(true);
      mkdirSync(".scratch", { recursive: true });
      writeFileSync(`.scratch/r17-diagnostics-${label}-cdp.json`, JSON.stringify({ events, consoleErrors: c.consoleErrors(), failedRequests: c.failedRequests() }, null, 2));
      expect(c.failedRequests()).toEqual([]);
      expect(c.consoleErrors()).toEqual([]);
    } finally { await isolated.release(); }
  });

  it("preserves business 404/500, favicon fetch 404 and explicit console.error/assert", async () => {
    const isolated = await session.newIsolatedPage();
    const h = isolated.handle;
    const c = await DiagnosticsCollector.attach(h);
    try {
      await h.page.goto(`${url}/`, { waitUntil: "networkidle0" });
      c.clear();
      await h.page.evaluate(async () => {
        console.error("application favicon.ico 404 error");
        console.assert(false, "application favicon 404 assertion");
        await Promise.all([fetch("/api/not-found"), fetch("/api/server-error"), fetch("/favicon.ico?business=1")]);
      });
      await expect.poll(() => c.failedRequests().length).toBe(3);
      expect(c.failedRequests()).toEqual(expect.arrayContaining([
        `404 ${url}/api/not-found`, `500 ${url}/api/server-error`, `404 ${url}/favicon.ico?business=1`
      ]));
      expect(c.consoleErrors()).toEqual(expect.arrayContaining([
        "application favicon.ico 404 error", "application favicon 404 assertion"
      ]));
      expect(c.consoleErrors().filter(error => error.startsWith("Failed to load resource:"))).toHaveLength(3);
    } finally { await isolated.release(); }
  });
});
