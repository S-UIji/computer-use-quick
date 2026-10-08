import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { takeSnapshot } from "../../src/perception/snapshot.js";
import { runBatch } from "../../src/executor/batch.js";
import { NetworkTracker } from "../../src/waiter/stability.js";
import { DiagnosticsCollector } from "../../src/diagnostics/collector.js";
import type { SnapshotResult } from "../../src/types.js";

let session: BrowserSession;
let handle: PageHandle;
let tracker: NetworkTracker;
let collector: DiagnosticsCollector;

beforeAll(async () => {
  session = await BrowserSession.connect(inject("browserURL"), { watch: false });
  handle = await session.newPage();
  tracker = await NetworkTracker.attach(handle);
  collector = await DiagnosticsCollector.attach(handle);
});

afterAll(async () => {
  await handle?.page.close().catch(() => {});
  await session?.close();
});

async function open(path = "snapshot-controls-table.html"): Promise<SnapshotResult> {
  await handle.page.goto(`${inject("fixtureURL")}/${path}`, { waitUntil: "load" });
  return takeSnapshot(handle);
}

function groupIds(snapshot: SnapshotResult): string[] {
  return [...snapshot.text.matchAll(/expand=\["(g[a-z0-9]+)"\]/g)].map((match) => match[1]);
}

function buttonRefs(snapshot: SnapshotResult, name: string): string[] {
  return snapshot.text.split("\n")
    .filter((line) => line.includes(`button "${name}"`))
    .flatMap((line) => line.match(/\[(e\d+)\]/)?.[1] ?? []);
}

async function click(snapshot: SnapshotResult, refs: string[]): Promise<void> {
  const result = await runBatch({
    handle, tracker, collector, refs: snapshot.refs, vars: {},
    steps: refs.map((ref) => ({ action: "click", target: { ref } })),
    captureDescriptors: false,
    stability: { domQuietMs: 20, networkQuietMs: 20, timeoutMs: 1000 }
  });
  expect(result.failure?.message).toBeUndefined();
  expect(result.ok).toBe(true);
}

describe("快照结构与直接操作", () => {
  it("六个同 role 工具栏按钮首次快照都有 ref，能直接逐个点击", async () => {
    const snapshot = await open();
    const names = ["刷新", "新建订单", "删除全部", "导出", "筛选", "设置"];
    const refs = names.map((name) => {
      const matches = buttonRefs(snapshot, name);
      expect(matches, name).toHaveLength(1);
      return matches[0];
    });
    await click(snapshot, refs);
    expect(await handle.page.$eval("#click-log", (node) => node.textContent)).toBe(names.join("|"));
  });

  it("表格摘要逐行关联客户与各列，重复的数量金额不丢，表头仍可见", async () => {
    const snapshot = await open();
    for (const [index, customer] of ["华东分公司", "西北分公司", "华南分公司"].entries()) {
      const id = `ORD-00${index + 1}`;
      const summary = snapshot.text.split("\n").find((line) => line.includes(id));
      expect(summary).toMatch(new RegExp(`${id}.*${customer}.*100.*100.*查看.*编辑.*删除`));
      expect(summary).not.toContain(`ORD-00${(index + 1) % 3 + 1}`);
    }
    for (const header of ["编号", "客户", "数量", "金额", "操作"]) {
      expect(snapshot.text).toContain(`columnheader "${header}"`);
    }
    expect(groupIds(snapshot)).toHaveLength(1);
    expect(snapshot.text).not.toContain("字段：");
  });

  it("同一行的多个操作列保持内容和可点击 ref，不横向折叠", async () => {
    const snapshot = await open();
    for (const label of ["资料", "账单", "记录"]) expect(snapshot.text).toContain(label);
    const refs = ["预览", "下载", "归档"].map((name) => {
      const matches = buttonRefs(snapshot, name);
      expect(matches, name).toHaveLength(1);
      return matches[0];
    });
    await click(snapshot, refs);
    expect(await handle.page.$eval("#click-log", (node) => node.textContent))
      .toBe("分栏:预览|分栏:下载|分栏:归档");
  });

  it("相同页面的 groupId 稳定，展开后能点击指定行的同名操作", async () => {
    const snapshot = await open();
    const ids = groupIds(snapshot);
    expect(ids).toHaveLength(1);
    expect(groupIds(await takeSnapshot(handle))).toEqual(ids);
    const expanded = await takeSnapshot(handle, { expand: ids });
    const refs = buttonRefs(expanded, "删除");
    expect(refs).toHaveLength(3);
    expect(groupIds(expanded)).toEqual([]);
    await click(expanded, [refs[1]]);
    expect(await handle.page.$eval("#click-log", (node) => node.textContent)).toBe("ORD-002:删除");
  });

  it("扁平卡片继续压缩，展开后的同名按钮仍定位到正确卡片", async () => {
    const snapshot = await open("cards-no-container.html");
    expect(groupIds(snapshot).length).toBeGreaterThan(0);
    const expanded = await takeSnapshot(handle, { expand: groupIds(snapshot) });
    expect(expanded.stats.prunedNodes).toBeGreaterThan(snapshot.stats.prunedNodes);
    const refs = buttonRefs(expanded, "查看在岗干部明细");
    expect(refs).toHaveLength(3);
    await click(expanded, [refs[1]]);
    expect(await handle.page.$eval("#clicked", (node) => node.textContent))
      .toBe("技术平台中心 · 查看在岗干部明细");
  });

  it("二十项同构列表继续压缩，展开 ref 保持原有项顺序", async () => {
    const snapshot = await open("homo-list.html");
    expect(groupIds(snapshot).length).toBeGreaterThan(0);
    expect(snapshot.text.length).toBeLessThan(2000);
    const expanded = await takeSnapshot(handle, { expand: groupIds(snapshot) });
    const refs = buttonRefs(expanded, "编辑");
    expect(refs).toHaveLength(20);
    // 原夹具没有点击效果，记录真实收到 click 的列表项以验证展开 ref 的归属。
    await handle.page.evaluate(() => {
      document.querySelectorAll("#rows button").forEach((button) => {
        button.addEventListener("click", () => {
          document.body.dataset.clicked = button.parentElement?.querySelector(".nm")?.textContent ?? "";
        });
      });
    });
    await click(expanded, [refs[19]]);
    expect(await handle.page.evaluate(() => document.body.dataset.clicked)).toBe("员工20");
  });
});
