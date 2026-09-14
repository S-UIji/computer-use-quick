#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BrowserSession } from "./session/browser.js";
import { createServer } from "./server.js";

const browserURL = process.env.CUQ_BROWSER_URL ?? "http://127.0.0.1:9222";

const session = await BrowserSession.connect(browserURL);
const server = createServer(session);
await server.connect(new StdioServerTransport());

process.on("SIGINT", async () => {
  await session.close();
  process.exit(0);
});
