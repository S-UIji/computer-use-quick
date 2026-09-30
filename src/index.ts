#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BrowserSession } from "./session/browser.js";
import { parseLaunchSetting } from "./session/launcher.js";
import { createServer } from "./server.js";

const browserURL = process.env.CUQ_BROWSER_URL ?? "http://127.0.0.1:9222";
const launch = parseLaunchSetting(process.env.CUQ_LAUNCH);
if (launch.warning) console.error(`[computer-use-quick] ${launch.warning}`);

// 启动时不连浏览器：先完成 MCP 握手，第一次工具调用再连；连不上返回启动指引，断开后下次调用自动重连
const session = BrowserSession.lazy(browserURL, { launch: launch.setting === "auto" ? {} : undefined });
const server = createServer(session);
await server.connect(new StdioServerTransport());

let shuttingDown = false;

/** 退出路径统一收口：session.close() 先撤掉页面标注（封顶 1s）再断开浏览器连接 */
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await session.close().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// MCP 客户端结束会话时通常只关 stdin（Windows 上也收不到信号）。浏览器连接会让进程一直挂着，
// 不在这里主动退出，每次会话都会留下一个残留进程和页面标注
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
