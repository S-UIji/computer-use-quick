import { describe, it, expect } from "vitest";
import { diffLines, renderDiff, DIFF_LINE_CAP } from "../../src/perception/diff.js";

describe("diffLines 行级增量", () => {
  it("无变化：新增与消失都为空", () => {
    const prev = ['[e1] button "登录"', '[e2] textbox "用户名"'];
    const d = diffLines(prev, [...prev]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.firstBaseline).toBe(false);
  });

  it("新增行保持当前顺序并带 ref", () => {
    const prev = ['[e1] button "登录"'];
    const curr = ['[e1] button "登录"', '[e4] button "保存"', '[e5] status "完成"'];
    const d = diffLines(prev, curr);
    expect(d.added).toEqual(['[e4] button "保存"', '[e5] status "完成"']);
    expect(d.removed).toEqual([]);
  });

  it("消失行保持上次顺序", () => {
    const prev = ['[e1] button "旧"', '[e2] button "登录"'];
    const curr = ['[e2] button "登录"'];
    const d = diffLines(prev, curr);
    expect(d.removed).toEqual(['[e1] button "旧"']);
    expect(d.added).toEqual([]);
  });

  it("变化行表现为 旧行消失 + 新行新增（LCS 最小编辑）", () => {
    const prev = ['[e7] status "加载中"', '[e1] button "登录"'];
    const curr = ['[e7] status "完成"', '[e1] button "登录"'];
    const d = diffLines(prev, curr);
    expect(d.removed).toEqual(['[e7] status "加载中"']);
    expect(d.added).toEqual(['[e7] status "完成"']);
  });

  it("首次基线：prev 为 null 时 firstBaseline=true 且新增为当前快照", () => {
    const d = diffLines(null, ['[e1] button "登录"']);
    expect(d.firstBaseline).toBe(true);
    expect(d.added).toEqual(['[e1] button "登录"']);
    expect(d.removed).toEqual([]);
  });

  it("导航后旧行全部消失、新行全部新增", () => {
    const d = diffLines(['[e1] heading "登录页"'], ['[e1] heading "主页"']);
    expect(d.removed).toEqual(['[e1] heading "登录页"']);
    expect(d.added).toEqual(['[e1] heading "主页"']);
  });

  it("超过上限截断并记录截断数量", () => {
    const curr = Array.from({ length: DIFF_LINE_CAP + 10 }, (_, i) => `[e${i}] button "b${i}"`);
    const d = diffLines([], curr);
    expect(d.added).toHaveLength(DIFF_LINE_CAP);
    expect(d.truncatedAdded).toBe(10);
  });
});

describe("renderDiff 报告形态", () => {
  it("无差异时明说", () => {
    const d = diffLines(["a"], ["a"]);
    expect(renderDiff(d)).toContain("无差异");
  });

  it("新增段以 + 前缀、消失段以 - 前缀", () => {
    const d = diffLines(['[e1] button "旧"'], ['[e1] button "新"']);
    const text = renderDiff(d);
    expect(text).toContain('+ [e1] button "新"');
    expect(text).toContain('- [e1] button "旧"');
  });

  it("截断时附汇总行", () => {
    const curr = Array.from({ length: DIFF_LINE_CAP + 3 }, (_, i) => `line${i}`);
    const text = renderDiff(diffLines([], curr));
    expect(text).toContain("还有 3 行新增未展示");
  });

  it("首次基线标注", () => {
    const text = renderDiff(diffLines(null, ["line1"]));
    expect(text).toContain("首次快照");
  });
});
