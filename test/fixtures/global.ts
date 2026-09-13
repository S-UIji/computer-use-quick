import type { GlobalSetupContext } from "vitest/node";
import puppeteer, { type Browser } from "puppeteer";
import { startFixtureServer } from "./server.js";

/**
 * 全套件共享一个 Chrome 和一个 fixture 站点。
 *
 * 原先每个测试文件各起一个 Chrome，于是有 11 次启动 + 11 次收尾，
 * 每一次收尾都是一个可能挂死的点（实测 puppeteer 的 browser.close() 会偶发
 * 卡住，把整个文件拖成 hook timeout）。收敛成一份之后，只剩一次收尾，
 * 而且套件明显更快。
 */
let chrome: Browser | undefined;
let fx: Awaited<ReturnType<typeof startFixtureServer>> | undefined;

declare module "vitest" {
  export interface ProvidedContext {
    browserURL: string;
    fixtureURL: string;
  }
}

export async function setup({ provide }: GlobalSetupContext): Promise<void> {
  fx = await startFixtureServer();
  chrome = await puppeteer.launch({
    headless: true,
    args: ["--remote-debugging-port=0", "--no-sandbox"]
  });
  provide("browserURL", `http://127.0.0.1:${new URL(chrome.wsEndpoint()).port}`);
  provide("fixtureURL", fx.url);
}

export async function teardown(): Promise<void> {
  const proc = chrome?.process();
  await Promise.race([
    chrome?.close().catch(() => {}) ?? Promise.resolve(),
    new Promise((r) => setTimeout(r, 5000))
  ]);
  // close() 偶发不返回，到点直接杀，别把整轮测试卡在收尾上
  if (proc && proc.exitCode === null && !proc.killed) proc.kill("SIGKILL");
  await fx?.close();
}
