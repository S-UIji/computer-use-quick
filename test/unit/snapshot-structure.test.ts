import { describe, expect, it } from "vitest";
import { collapse } from "../../src/perception/collapse.js";
import { prune } from "../../src/perception/prune.js";
import { render } from "../../src/perception/render.js";
import { isCollapsedGroup, type PrunedNode, type RawAxNode, type CollapsedGroup } from "../../src/types.js";

const n = (role: string, name = "", children: PrunedNode[] = [], backendNodeId?: number): PrunedNode =>
  ({ role, name, children, props: {}, backendNodeId });
const root = (children: PrunedNode[]) => n("main", "", children);
const row = (name: string) => n("row", "", [
  n("cell", name), n("cell", "100"), n("cell", "100"), n("button", "查看")
]);

describe("叶子与表格折叠边界", () => {

  it("单元格内已有折叠组的内容仍进入整行摘要", () => {
    const rows = ["甲", "乙", "丙"].map((key) => n("row", "", [
      n("cell", key),
      n("cell", "商品明细", ["商品A", "商品B", "商品C"].flatMap((s) => [
        n("StaticText", s), n("button", "查看")
      ]))
    ]));
    const group = collapse(root(rows)).children[0] as CollapsedGroup;
    expect(group.count).toBe(3);
    for (const [i, key] of ["甲", "乙", "丙"].entries()) {
      expect(group.items[i]).toContain(key);
      for (const content of ["商品明细", "商品A", "商品B", "商品C", "查看"]) {
        expect(group.items[i]).toContain(content);
      }
    }
  });

  it.each([3, 6, 9])("%i 个同 role 叶子保留全部 ref，不被更大周期折叠", (count) => {
    const buttons = Array.from({ length: count }, (_, i) => n("button", "按钮" + i, [], i + 1));
    const result = collapse(root(buttons));
    expect(result.children).toEqual(buttons);
    expect(render(result).refs.size).toBe(count);
  });

  it("叶子序列后的多节点周期卡片继续折叠，公共字段保持真实", () => {
    const buttons = Array.from({ length: 6 }, (_, i) => n("button", "工具" + i, [], i + 1));
    const cards = Array.from({ length: 4 }, (_, i) => [
      n("StaticText", "员工" + i), n("button", "查看"), n("button", "编辑")
    ]).flat();
    const result = collapse(root([...buttons, ...cards]));
    expect(result.children.slice(0, 6)).toEqual(buttons);
    const group = result.children[6] as CollapsedGroup;
    expect(group.count).toBe(4);
    expect(group.fields).toEqual(["查看", "编辑"]);
    expect(group.items).toEqual(["员工0", "员工1", "员工2", "员工3"]);
  });

  it("无公共字段的同构容器不拿第一项充当字段", () => {
    const group = collapse(root(["甲", "乙", "丙"].map((s) => n("group", s, [n("button", s)]))))
      .children[0] as CollapsedGroup;
    expect(group.fields).toEqual([]);
    expect(group.items).toEqual(["甲", "乙", "丙"]);
    const output = render({ ...root([]), children: [group] }).text;
    expect(output).toContain('expand=["' + group.groupId + '"]');
    expect(output).not.toContain("字段：");
  });

  it.each(["row", "LayoutTableRow"])("%s 按列顺序摘要，数量与金额相同也不去重", (role) => {
    const group = collapse(root(["甲", "乙", "丙"].map((s) => ({ ...row(s), role })))).children[0] as CollapsedGroup;
    expect(group.count).toBe(3);
    expect(group.items).toEqual(["甲 · 100 · 100 · 查看", "乙 · 100 · 100 · 查看", "丙 · 100 · 100 · 查看"]);
  });

  it("合成行名不重复输出，显式行标签保留", () => {
    const rows = ["甲", "乙", "丙"].map((s) => ({ ...row(s), name: s + " 100 100 查看" }));
    const group = collapse(root(rows)).children[0] as CollapsedGroup;
    expect(group.items[0]).toBe("甲 · 100 · 100 · 查看");
    rows[0].name = "重点订单";
    expect((collapse(root(rows)).children[0] as CollapsedGroup).items[0]).toBe("重点订单 · 甲 · 100 · 100 · 查看");
  });

  it("一行的多个非叶子单元格不横向折叠", () => {
    const cells = ["资料", "账单", "记录"].map((s, i) => n("cell", "", [n("StaticText", s), n("button", "操作", [], i)]));
    const output = collapse(root([n("row", "", cells)]));
    const resultRow = output.children[0] as PrunedNode;
    expect(resultRow.children).toHaveLength(3);
    expect(resultRow.children.some(isCollapsedGroup)).toBe(false);
    expect(render(output).refs.size).toBe(3);
  });

  it("结构不同的表头不混入数据行组，重复列标题保持原位", () => {
    const header = n("row", "", [n("columnheader", "名称"), n("columnheader", "数值"), n("columnheader", "数值"), n("columnheader", "操作")]);
    const result = collapse(root([header, row("甲"), row("乙"), row("丙")]));
    expect(result.children).toHaveLength(2);
    expect(result.children[0]).toEqual(header);
    expect((result.children[1] as CollapsedGroup).count).toBe(3);
  });
});

function raw(nodeId: string, role: string, name: string, childIds: string[] = [], ignored = false): RawAxNode {
  return { nodeId, role: { value: role }, name: { value: name }, childIds, ignored };
}
describe("prune 的行边界", () => {
  it.each([["row", ""], ["row", "甲"], ["LayoutTableRow", ""], ["LayoutTableRow", "甲"]])("%s 行名 %s：单单元格行仍保留边界", (role, name) => {
    const result = prune([
      raw("1", "RootWebArea", "", ["2"]), raw("2", role, name, ["3"]), raw("3", "cell", "甲")
    ], "1")!;
    const keptRow = result.children[0] as PrunedNode;
    expect(keptRow.role).toBe(role);
    expect(keptRow.children[0]).toMatchObject({ role: "cell", name: "甲" });
  });

  it("命名 row 不吞掉与名称相同的直接文本", () => {
    const result = prune([
      raw("1", "RootWebArea", "", ["2"]), raw("2", "row", "甲", ["3"]), raw("3", "StaticText", "甲")
    ], "1")!;
    const keptRow = result.children[0] as PrunedNode;
    expect(keptRow.role).toBe("row");
    expect(keptRow.children[0]).toMatchObject({ role: "StaticText", name: "甲" });
  });

  it("ignored row 不因结构保留规则变成可见", () => {
    const result = prune([
      raw("1", "RootWebArea", "", ["2"]), raw("2", "row", "", ["3"], true), raw("3", "button", "操作")
    ], "1")!;
    expect(result.children[0]).toMatchObject({ role: "button", name: "操作" });
  });
});
