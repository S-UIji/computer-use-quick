import { beforeEach, afterEach, describe, it, expect, inject } from "vitest";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";

let session: BrowserSession;
const owned: PageHandle[] = [];
async function page(): Promise<PageHandle> {
  const h = await session.newPage();
  owned.push(h);
  return h;
}
beforeEach(async () => { session = await BrowserSession.connect(inject("browserURL")); });
afterEach(async () => {
  for (const h of owned.splice(0)) await h.page.close().catch(() => {});
  await session.close();
});

describe("关闭后的页面选择", () => {
  it("无效显式 pageId 不回退、不新增页、不改变默认选择", async () => {
    const user = await page();
    await session.getPage(user.pageId);
    const before = await session.listPages();
    await expect(session.getPage("invalid-page-id")).rejects.toThrow(/invalid-page-id.*list_pages/);
    expect(await session.listPages()).toEqual(before);
    expect(session.currentPageId()).toBe(user.pageId);
  });

  it("默认页关闭后并发取页只新建一页，告知一次且不动用户页", async () => {
    const user = await page();
    await user.page.goto(inject("fixtureURL") + "/form.html");
    const originalUrl = user.page.url(), originalHtml = await user.page.content();
    const active = await page();
    await session.getPage(active.pageId);
    session.selectPage(active.pageId);
    await active.page.close();
    const before = await session.listPages();
    const [a, b] = await Promise.all([session.getPage(), session.getPage()]);
    if (!before.some((p) => p.pageId === a.pageId)) owned.push(a);
    expect(a.pageId).not.toBe(user.pageId);
    expect(before.some((p) => p.pageId === a.pageId)).toBe(false);
    expect(a.pageId).toBe(b.pageId);
    expect(a.page.url()).toBe("about:blank");
    expect((await session.listPages()).length).toBe(before.length + 1);
    expect(session.currentPageId()).toBe(a.pageId);
    expect(session.takeNotice()).toMatch(new RegExp("已关闭.*已新开标签页.*" + a.pageId));
    expect(session.takeNotice()).toBeUndefined();
    expect((await session.getPage()).pageId).toBe(a.pageId);
    expect(user.page.url()).toBe(originalUrl);
    expect(await user.page.content()).toBe(originalHtml);
  });

  it("失效显式 ID 不消费默认页恢复，随后仍新建", async () => {
    const active = await page();
    session.selectPage(active.pageId);
    await active.page.close();
    await expect(session.getPage(active.pageId)).rejects.toThrow(/list_pages/);
    const before = await session.listPages();
    const recovered = await session.getPage();
    if (!before.some((p) => p.pageId === recovered.pageId)) owned.push(recovered);
    expect(before.some((p) => p.pageId === recovered.pageId)).toBe(false);
  });

  it("关闭默认页后显式选有效页，后续默认取页复用该页", async () => {
    const active = await page(), chosen = await page();
    session.selectPage(active.pageId);
    await active.page.close();
    await session.getPage(chosen.pageId);
    expect((await session.getPage()).pageId).toBe(chosen.pageId);
    expect(session.currentPageId()).toBe(chosen.pageId);
    expect(session.takeNotice()).toBeUndefined();
  });

  it("关闭非默认页不会触发新页恢复", async () => {
    const active = await page(), other = await page();
    session.selectPage(active.pageId);
    await other.page.close();
    expect((await session.getPage()).pageId).toBe(active.pageId);
    expect(session.takeNotice()).toBeUndefined();
  });

  it("closePage 与隔离页 release 同样禁止退回用户页", async () => {
    const active = await page();
    session.selectPage(active.pageId);
    await session.closePage(active.pageId);
    const before = await session.listPages();
    const recovered = await session.getPage();
    if (!before.some((p) => p.pageId === recovered.pageId)) owned.push(recovered);
    expect(recovered.pageId).not.toBe(active.pageId);
    const isolated = await session.newIsolatedPage();
    session.selectPage(isolated.handle.pageId);
    await isolated.release();
    const afterRelease = await session.getPage();
    if (!before.some((p) => p.pageId === afterRelease.pageId)) owned.push(afterRelease);
    expect(afterRelease.pageId).not.toBe(recovered.pageId);
  });
});
