// CLI 入口：npm run bench -- <tracePath>
import puppeteer from "puppeteer";
import { BrowserSession } from "../../src/session/browser.js";
import { NetworkTracker } from "../../src/waiter/stability.js";
import { DiagnosticsCollector } from "../../src/diagnostics/collector.js";
import { loadTrace } from "../../src/trace/store.js";
import { runBench } from "./run.js";

const tracePath = process.argv[2];
if (!tracePath) {
  console.error("用法：npm run bench -- <tracePath>");
  process.exit(1);
}

const browserURL = process.env.CUQ_BROWSER_URL;
let launched: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
let url = browserURL;
if (!url) {
  launched = await puppeteer.launch({ headless: true, args: ["--remote-debugging-port=0", "--no-sandbox"] });
  url = `http://127.0.0.1:${new URL(launched.wsEndpoint()).port}`;
  console.error(`未设置 CUQ_BROWSER_URL，已临时启动一个 headless Chrome：${url}`);
}

const session = await BrowserSession.connect(url);
const handle = await session.getPage();
const report = await runBench({
  handle,
  tracker: await NetworkTracker.attach(handle),
  collector: await DiagnosticsCollector.attach(handle),
  trace: await loadTrace(tracePath),
  vars: process.env as Record<string, string>
});
console.log(report.markdown);

await session.close();
if (launched) {
  const proc = launched.process();
  await Promise.race([launched.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
  if (proc && proc.exitCode === null) proc.kill("SIGKILL");
}
process.exit(0);
