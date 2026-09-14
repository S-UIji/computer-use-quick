import { describe, it, expect } from "vitest";
import { render } from "../../src/perception/render.js";
import type { PrunedNode, CollapsedGroup } from "../../src/types.js";

describe("render", () => {
  it("给可交互节点分配 ref 并渲染成缩进文本", () => {
    const root: PrunedNode = {
      role: "RootWebArea", name: "登录页", props: {}, children: [
        { role: "heading", name: "欢迎登录", props: {}, children: [] },
        { role: "textbox", name: "用户名", props: { value: "" }, backendNodeId: 11, children: [] },
        { role: "button", name: "登录", props: {}, backendNodeId: 12, children: [] }
      ]
    };
    const { text, refs } = render(root);
    expect(text).toContain('heading "欢迎登录"');
    expect(text).toMatch(/\[e\d+\] textbox "用户名"/);
    expect(text).toMatch(/\[e\d+\] button "登录"/);
    expect(refs.size).toBe(2);
    expect([...refs.values()]).toContain(12);
  });

  it("不给无 backendNodeId 的节点分配 ref", () => {
    const root: PrunedNode = {
      role: "RootWebArea", name: "", props: {}, children: [
        { role: "heading", name: "标题", props: {}, children: [] }
      ]
    };
    const { text, refs } = render(root);
    expect(refs.size).toBe(0);
    expect(text).not.toContain("[e");
  });

  it("把 props 渲染成 key=value 后缀", () => {
    const root: PrunedNode = {
      role: "RootWebArea", name: "", props: {}, children: [
        { role: "checkbox", name: "包含体系外", props: { checked: "true" }, backendNodeId: 3, children: [] }
      ]
    };
    expect(render(root).text).toContain('checkbox "包含体系外" checked=true');
  });

  it("按层级缩进", () => {
    const root: PrunedNode = {
      role: "RootWebArea", name: "", props: {}, children: [
        { role: "navigation", name: "全局导航", props: {}, children: [
          { role: "link", name: "首页", props: {}, backendNodeId: 5, children: [] }
        ]}
      ]
    };
    const lines = render(root).text.split("\n");
    const navLine = lines.find((l) => l.includes("全局导航"))!;
    const linkLine = lines.find((l) => l.includes("首页"))!;
    expect(linkLine.match(/^\s*/)![0].length).toBeGreaterThan(navLine.match(/^\s*/)![0].length);
  });

  it("折叠组渲染成带项目摘要的紧凑块", () => {
    const group: CollapsedGroup = {
      kind: "collapsed-group", count: 3, groupId: "gabc",
      fields: ["查看在岗干部明细", "负责人治理"],
      items: ["教育事业群 · 5081", "技术平台中心 · 0", "人力资源中心 · 0"]
    };
    const root: PrunedNode = { role: "RootWebArea", name: "", props: {}, children: [group] };
    const { text } = render(root);
    expect(text).toContain("[3 项结构相同");
    expect(text).toContain("gabc");
    expect(text).toContain("教育事业群 · 5081");
  });
});
