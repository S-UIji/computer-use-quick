import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pagesDir = join(here, "pages");

/** /api/flaky-once 的进程内计数：首次 500，之后 200 */
let flakyHits = 0;

export async function startFixtureServer(port = 0) {
  const server = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];

    // 慢接口：用来验证隐式等待能靠网络在途信号等到异步结果
    if (path === "/api/orders") {
      await new Promise((r) => setTimeout(r, 800));
      res.writeHead(200, { "content-type": "application/json" })
         .end(JSON.stringify(["ORD20260911", "ORD20260912"]));
      return;
    }

    // 永不返回的接口：验证在途请求的导航清场与僵尸驱逐
    if (path === "/api/hang") return;

    // 进程内首次 500 之后 200：验证套件层单条重试的 flaky 标记（测试进程生命周期内有状态）
    if (path === "/api/flaky-once") {
      flakyHits += 1;
      if (flakyHits === 1) {
        res.writeHead(500).end("boom");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }

    const name = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, "");
    if (!name.endsWith(".html") || name.includes("..")) {
      res.writeHead(404).end("not found");
      return;
    }
    try {
      const body = await readFile(join(pagesDir, name), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;

  return {
    url: `http://127.0.0.1:${actualPort}`,
    close: () =>
      new Promise<void>((resolve) => {
        // 不能只 server.close()：它会等所有连接排空，而浏览器（尤其是被强杀的）
        // 留下的 keep-alive socket 不会自己断，收尾会一直挂着。
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}
