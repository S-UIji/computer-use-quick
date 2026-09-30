import { describe, it, expect, afterEach } from "vitest";
import { BrowserSession } from "../../src/session/browser.js";
import { BrowserUnavailableError } from "../../src/session/launcher.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromePath, freePort, killTree, removeDir, startChrome } from "../fixtures/own-chrome.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** 断开事件是异步传到会话的：反复取页，直到拿到指引错误 */
async function unavailable(session: BrowserSession, ms = 8000): Promise<BrowserUnavailableError> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const e = await session.getPage().then(() => undefined, (err: unknown) => err);
    if (e instanceof BrowserUnavailableError) return e;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${ms}ms 内没拿到 BrowserUnavailableError`);
}

describe("浏览器连接生命周期", () => {
  it("lazy：端口不通时取页返回启动指引；启动 Chrome 后同一会话直接可用", async () => {
    const port = await freePort();
    const session = BrowserSession.lazy(`http://127.0.0.1:${port}`);
    cleanups.push(() => session.close());

    const err = await session.getPage().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrowserUnavailableError);
    expect((err as Error).message).toContain(`--remote-debugging-port=${port}`);
    expect((err as Error).message).toContain("--user-data-dir=");

    const chrome = await startChrome(port);
    cleanups.push(chrome.stop);
    const [a, b] = await Promise.all([session.getPage(), session.getPage()]);
    expect(a.pageId).toBe(b.pageId);
    expect(session.takeNotice()).toBeUndefined(); // 首次连接不打扰
  });

  it("重连：浏览器被关后取页返回指引，重开后自动重连并告知一次", async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const first = await startChrome(port);
    const session = await BrowserSession.connect(url);
    cleanups.push(() => session.close());
    await session.getPage();

    await first.stop();
    expect((await unavailable(session)).message).toContain(`--remote-debugging-port=${port}`);

    const second = await startChrome(port);
    cleanups.push(second.stop);
    const handle = await session.getPage();
    expect(handle.pageId).toBeTruthy();
    expect(session.takeNotice()).toContain("已重新连接");
    expect(session.takeNotice()).toBeUndefined();
  });

  it("自动拉起：端口不通时自己拉起 Chrome 并连上，告知 profile", async () => {
    const port = await freePort();
    const profileDir = mkdtempSync(join(tmpdir(), "cuq-launch-"));
    const session = BrowserSession.lazy(`http://127.0.0.1:${port}`, {
      launch: { chromePath: chromePath(), profileDir, headless: true }
    });
    cleanups.push(() => removeDir(profileDir));
    cleanups.push(() => killTree(session.launchedPid));
    cleanups.push(() => session.close());

    const handle = await session.getPage();
    expect(handle.pageId).toBeTruthy();
    expect(session.launchedPid).toBeGreaterThan(0);
    expect(session.takeNotice()).toBe(`浏览器未运行，已自动拉起（profile：${profileDir}）`);
  });

  it("自动拉起只对本机地址生效：远程地址直接返回指引、不拉起", async () => {
    const session = BrowserSession.lazy("http://cuq-no-such-host.invalid:9222", {
      launch: { chromePath: chromePath(), headless: true }
    });
    cleanups.push(() => session.close());
    const err = await session.getPage().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrowserUnavailableError);
    expect((err as Error).message).toContain("请确认该地址上的 Chrome 已开启调试端口");
    expect(session.launchedPid).toBeUndefined();
  });

  it("自动拉起失败：指引里写明原因", async () => {
    const port = await freePort();
    const session = BrowserSession.lazy(`http://127.0.0.1:${port}`, {
      launch: { chromePath: "C:/不存在/chrome.exe", headless: true }
    });
    cleanups.push(() => session.close());
    const err = await session.getPage().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrowserUnavailableError);
    expect((err as Error).message).toContain("自动拉起失败：");
  });
});
