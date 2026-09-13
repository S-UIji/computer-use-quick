import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { BrowserSession } from "../../src/session/browser.js";
import { takeSnapshot } from "../../src/perception/snapshot.js";

let session: BrowserSession;
const fx = { url: "" };

beforeAll(async () => {
  fx.url = inject("fixtureURL");
  session = await BrowserSession.connect(inject("browserURL"));
});
afterAll(async () => { await session?.close(); });

async function open(path: string) {
  const h = await session.getPage();
  await h.page.goto(`${fx.url}/${path}`, { waitUntil: "load" });
  return h;
}

describe("takeSnapshot", () => {
  it("表单页快照含登录按钮和用户名输入框，且都带 ref", async () => {
    const snap = await takeSnapshot(await open("form.html"));
    expect(snap.text).toMatch(/\[e\d+\] button "登录"/);
    expect(snap.text).toMatch(/\[e\d+\] (textbox|searchbox) "用户名"/);
  });

  it("同构列表被折叠：20 项收成一个组", async () => {
    const snap = await takeSnapshot(await open("homo-list.html"));
    expect(snap.stats.collapsedGroups).toBeGreaterThanOrEqual(1);
    expect(snap.text).toContain("项结构相同");
    expect(snap.text).toContain("员工1");
  });

  it("expand 指定组后恢复完整细节，节点数明显变多", async () => {
    const h = await open("homo-list.html");
    const collapsed = await takeSnapshot(h);
    const gid = collapsed.text.match(/expand=\["(g[a-z0-9]+)"\]/)![1];
    const expanded = await takeSnapshot(h, { expand: [gid] });
    expect(expanded.stats.prunedNodes).toBeGreaterThan(collapsed.stats.prunedNodes);
    expect(expanded.stats.collapsedGroups).toBeLessThan(collapsed.stats.collapsedGroups);
  });

  it("卡片墙页面确实没有 a11y 容器（验证 spec §6.3 的前提成立）", async () => {
    const snap = await takeSnapshot(await open("cards-no-container.html"), { threshold: 99 });
    const dup = snap.text.split("\n").filter((l) => l.includes("查看在岗干部明细"));
    expect(dup.length).toBe(3);          // 三个同名按钮
    expect(snap.text).not.toContain("group ");  // 且没有把它们分组的容器节点
  });

  it("快照文本比同页截图省 token（用字符数近似）", async () => {
    const snap = await takeSnapshot(await open("homo-list.html"));
    expect(snap.text.length).toBeLessThan(2000);
  });
});
