import puppeteer, { type Browser, type Page, type CDPSession } from "puppeteer-core";

export interface PageHandle {
  pageId: string;
  page: Page;
  cdp: CDPSession;
}

/**
 * 取页面的 target id。puppeteer 没有公开这个字段，但它就是 CDP 的 targetId
 * （已实测一致），比 url 稳定得多——同一 url 可以开多个标签页。
 * 拿不到时退回 url，至少不会崩。
 */
function targetIdOf(page: Page): string {
  const t = page.target() as unknown as { _targetId?: string };
  return t._targetId ?? page.url();
}

export class BrowserSession {
  private handles = new Map<string, PageHandle>();
  private selected?: string;

  private constructor(private browser: Browser) {}

  static async connect(browserURL: string): Promise<BrowserSession> {
    const browser = await puppeteer.connect({ browserURL, defaultViewport: null });
    return new BrowserSession(browser);
  }

  async listPages(): Promise<Array<{ pageId: string; title: string; url: string }>> {
    const pages = await this.browser.pages();
    const out: Array<{ pageId: string; title: string; url: string }> = [];
    for (const page of pages) {
      out.push({ pageId: targetIdOf(page), title: await page.title(), url: page.url() });
    }
    return out;
  }

  selectPage(pageId: string): void {
    this.selected = pageId;
  }

  async getPage(pageId?: string): Promise<PageHandle> {
    const id = pageId ?? this.selected;
    const pages = await this.browser.pages();

    let page: Page | undefined;
    if (id) page = pages.find((p) => targetIdOf(p) === id);
    page ??= pages[0];
    if (!page) throw new Error("浏览器中没有可用页面");

    const key = targetIdOf(page);
    const cached = this.handles.get(key);
    if (cached) return cached;

    const cdp = await page.createCDPSession();
    await cdp.send("Accessibility.enable");
    await cdp.send("DOM.enable");
    await cdp.send("Runtime.enable");

    const handle: PageHandle = { pageId: key, page, cdp };
    this.handles.set(key, handle);
    this.selected ??= key;
    return handle;
  }

  async close(): Promise<void> {
    for (const h of this.handles.values()) {
      await h.cdp.detach().catch(() => {});
    }
    this.handles.clear();
    this.browser.disconnect();
  }
}
