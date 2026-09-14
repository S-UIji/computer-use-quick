import { describe, it, expect } from "vitest";
import { collapse, signature } from "../../src/perception/collapse.js";
import type { PrunedNode, CollapsedGroup } from "../../src/types.js";

function card(name: string, total: string): PrunedNode {
  return {
    role: "generic", name, props: {}, children: [
      { role: "button", name: "查看在岗干部明细", props: {}, children: [] },
      { role: "button", name: "负责人治理", props: {}, children: [] },
      { role: "StaticText", name: total, props: {}, children: [] }
    ]
  };
}

describe("signature", () => {
  it("结构相同的两个节点签名相同", () => {
    expect(signature(card("甲", "1"))).toBe(signature(card("乙", "2")));
  });

  it("结构不同的节点签名不同", () => {
    const other: PrunedNode = { role: "generic", name: "丙", props: {}, children: [
      { role: "link", name: "去详情", props: {}, children: [] }
    ]};
    expect(signature(card("甲", "1"))).not.toBe(signature(other));
  });
});

describe("collapse", () => {
  it("达到阈值的同构兄弟被折叠成一个组", () => {
    const root: PrunedNode = { role: "main", name: "", props: {}, children: [
      card("教育事业群", "5081"), card("技术平台中心", "0"), card("人力资源中心", "0")
    ]};
    const out = collapse(root, { threshold: 3 });
    expect(out.children).toHaveLength(1);
    const g = out.children[0] as CollapsedGroup;
    expect(g.kind).toBe("collapsed-group");
    expect(g.count).toBe(3);
  });

  it("未达阈值的不折叠", () => {
    const root: PrunedNode = { role: "main", name: "", props: {}, children: [
      card("甲", "1"), card("乙", "2")
    ]};
    const out = collapse(root, { threshold: 3 });
    expect(out.children).toHaveLength(2);
  });

  it("折叠组保留每项的区别性摘要", () => {
    const root: PrunedNode = { role: "main", name: "", props: {}, children: [
      card("教育事业群", "5081"), card("技术平台中心", "0"), card("人力资源中心", "0")
    ]};
    const g = collapse(root, { threshold: 3 }).children[0] as CollapsedGroup;
    expect(g.items).toHaveLength(3);
    expect(g.items[0]).toContain("教育事业群");
    expect(g.items[0]).toContain("5081");
  });

  it("expand 指定的组 id 不折叠", () => {
    const root: PrunedNode = { role: "main", name: "", props: {}, children: [
      card("甲", "1"), card("乙", "2"), card("丙", "3")
    ]};
    const collapsed = collapse(root, { threshold: 3 });
    const gid = (collapsed.children[0] as CollapsedGroup).groupId;
    const expanded = collapse(root, { threshold: 3, expand: [gid] });
    expect(expanded.children).toHaveLength(3);
  });

  it("周期为 3 的摊平重复单元也能折叠（行容器被裁掉后的真实形态）", () => {
    // 行容器 <div> 无可及名称会被 prune 丢掉，一"行"摊平成三个兄弟节点，
    // 连续相同签名最多只有 2 个——只认 p=1 的算法会完全漏掉。
    const flat: PrunedNode = { role: "main", name: "", props: {}, children: [] };
    for (let i = 1; i <= 20; i++) {
      flat.children.push(
        { role: "StaticText", name: `员工${i}`, props: {}, children: [] },
        { role: "button", name: "查看详情", props: {}, children: [] },
        { role: "button", name: "编辑", props: {}, children: [] }
      );
    }
    const out = collapse(flat, { threshold: 3 });
    expect(out.children).toHaveLength(1);
    const g = out.children[0] as CollapsedGroup;
    expect(g.count).toBe(20);
    expect(g.items).toHaveLength(20);
  });

  it("周期内恒定的位置进 fields，只有变化的位置逐项列出", () => {
    const flat: PrunedNode = { role: "main", name: "", props: {}, children: [] };
    for (let i = 1; i <= 5; i++) {
      flat.children.push(
        { role: "StaticText", name: `员工${i}`, props: {}, children: [] },
        { role: "button", name: "查看详情", props: {}, children: [] }
      );
    }
    const g = collapse(flat, { threshold: 3 }).children[0] as CollapsedGroup;
    expect(g.fields).toContain("查看详情");        // 每行都一样 → 结构说明
    expect(g.items).toEqual(["员工1", "员工2", "员工3", "员工4", "员工5"]);
    expect(g.items.join()).not.toContain("查看详情"); // 常量不该重复 5 遍
  });

  it("优先选最小周期：40 个相同按钮走 p=1 而非 p=2", () => {
    const flat: PrunedNode = { role: "main", name: "", props: {}, children: [] };
    for (let i = 0; i < 40; i++) {
      flat.children.push({ role: "button", name: "编辑", props: {}, children: [] });
    }
    const g = collapse(flat, { threshold: 3 }).children[0] as CollapsedGroup;
    expect(g.count).toBe(40);
  });

  it("同一输入两次折叠产生相同的 groupId（可稳定引用）", () => {
    const root: PrunedNode = { role: "main", name: "", props: {}, children: [
      card("甲", "1"), card("乙", "2"), card("丙", "3")
    ]};
    const a = (collapse(root, { threshold: 3 }).children[0] as CollapsedGroup).groupId;
    const b = (collapse(root, { threshold: 3 }).children[0] as CollapsedGroup).groupId;
    expect(a).toBe(b);
  });
});
