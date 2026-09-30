import { spawn, execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer";

/**
 * 生命周期测试要自己启停 Chrome，不能动全套件共享的那个。
 * 不走 puppeteer.launch：它的收尾偶发挂死（见 global.ts），这里直接起进程、按 pid 杀进程树。
 */

export function chromePath(): string {
  return puppeteer.executablePath();
}

export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => res(port));
    });
  });
}

/** Chrome 是多进程：只杀主进程会留下子进程占着 profile */
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    else process.kill(-pid, "SIGKILL"); // detached 启动，自成进程组
  } catch { /* 已退出 */ }
}

/** Windows 上进程刚退出时文件句柄可能还没放完：重试删除，删不掉就留给系统临时目录 */
export function removeDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* 尽力 */ }
}

async function poll(check: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${ms}ms 内未${what}`);
}

const up = async (url: string): Promise<boolean> => {
  try { return (await fetch(`${url}/json/version`)).ok; } catch { return false; }
};

export async function startChrome(port: number): Promise<{ pid?: number; profileDir: string; stop(): Promise<void> }> {
  const profileDir = mkdtempSync(join(tmpdir(), "cuq-own-"));
  const child = spawn(chromePath(), [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`,
    "--headless=new", "--no-first-run", "--no-default-browser-check", "about:blank"
  ], { detached: true, stdio: "ignore" });
  child.unref();
  const url = `http://127.0.0.1:${port}`;
  await poll(() => up(url), 15_000, "就绪");
  return {
    pid: child.pid,
    profileDir,
    stop: async () => {
      killTree(child.pid);
      await poll(async () => !(await up(url)), 10_000, "退出");
      removeDir(profileDir);
    }
  };
}
