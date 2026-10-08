import type { PageHandle } from "./browser.js";

export class PageClosedError extends Error {
  constructor(pageId: string) {
    super(`被操作的标签页已关闭（pageId=${pageId}）。请用 list_pages 重新选页并 snapshot 确认，再重新运行。`);
    this.name = "PageClosedError";
  }
}

export function assertPageOpen(handle: PageHandle): void {
  if (handle.page.isClosed()) throw new PageClosedError(handle.pageId);
}
