import { it, expect, inject, vi } from "vitest";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";

it("并发冷启动建页等待模式初始化完成", async () => {
  const baseline = await BrowserSession.connect(inject("browserURL"));
  const sample = await baseline.newPage();
  const proto = Object.getPrototypeOf(sample.cdp), send = proto.send;
  await sample.page.close();
  await baseline.close();

  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const hold = new Promise<void>(r => { release = r; });
  const spy = vi.spyOn(proto, "send").mockImplementation(async function(this: any, method: string, params: any) {
    if (method === "Target.setDiscoverTargets") { entered(); await hold; }
    return send.call(this, method, params);
  });
  const session = BrowserSession.lazy(inject("browserURL"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pages: PageHandle[] = [];
  try {
    const first = session.newPage();
    await started;
    const second = session.newPage();
    timer = setTimeout(release, 500);
    const handles = await Promise.all([first, second]);
    pages.push(...handles);
    expect(handles.map(h => h.headless)).toEqual([true, true]);
  } finally {
    release();
    if (timer) clearTimeout(timer);
    spy.mockRestore();
    for (const h of pages) await h.page.close().catch(() => {});
    await session.close();
  }
});
