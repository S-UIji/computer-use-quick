#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BrowserSession } from "./session/browser.js";
import { createServer } from "./server.js";
import { removeAllOverlays } from "./watch/overlay.js";

const browserURL = process.env.CUQ_BROWSER_URL ?? "http://127.0.0.1:9222";

const session = await BrowserSession.connect(browserURL);
const server = createServer(session);
await server.connect(new StdioServerTransport());

process.on("SIGINT", async () => {
  // 退出前尽力撤掉页面上的「待命」标注（总时长封顶 1s），免得残留误导用户
  await removeAllOverlays(session.allHandles());
  await session.close();
  process.exit(0);
});
