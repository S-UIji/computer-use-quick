import { describe, it, expect } from "vitest";
import { prune } from "../../src/perception/prune.js";
import type { RawAxNode, PrunedNode } from "../../src/types.js";

function node(p: Partial<RawAxNode> & { nodeId: string }): RawAxNode {
  return { ignored: false, ...p } as RawAxNode;
}

const tree: RawAxNode[] = [
  node({ nodeId: "1", role: { value: "RootWebArea" }, name: { value: "页面" }, childIds: ["2", "3", "4", "5"] }),
  node({ nodeId: "2", role: { value: "heading" }, name: { value: "标题" } }),
  node({ nodeId: "3", role: { value: "button" }, name: { value: "登录" }, backendDOMNodeId: 11 }),
  node({ nodeId: "4", role: { value: "generic" }, name: { value: "" } }),
  node({ nodeId: "5", role: { value: "button" }, name: { value: "隐藏按钮" }, ignored: true })
];

describe("prune", () => {
  it("保留可交互节点", () => {
    const out = prune(tree, "1")!;
    expect(out.children.some((c) => c.role === "button" && c.name === "登录")).toBe(true);
  });

  it("保留语义文本节点 heading", () => {
    const out = prune(tree, "1")!;
    expect(out.children.some((c) => c.role === "heading")).toBe(true);
  });

  it("丢弃无 name 的 generic 容器", () => {
    const out = prune(tree, "1")!;
    expect(out.children.some((c) => c.role === "generic")).toBe(false);
  });

  it("丢弃 ignored 节点", () => {
    const out = prune(tree, "1")!;
    expect(out.children.some((c) => (c as PrunedNode).name === "隐藏按钮")).toBe(false);
  });

  it("ignored 的包装节点不切断子树，后代要提升上来", () => {
    // 真实 AX 树里 RootWebArea 与内容之间夹着 <html>/<body> 对应的
    // ignored=true 的 role=none 节点。ignored 说的是「这个节点」不暴露，
    // 不是「这棵子树」不暴露。
    const wrapped: RawAxNode[] = [
      node({ nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] }),
      node({ nodeId: "2", role: { value: "none" }, ignored: true, childIds: ["3"] }),
      node({ nodeId: "3", role: { value: "none" }, ignored: true, childIds: ["4"] }),
      node({ nodeId: "4", role: { value: "main" }, childIds: ["5"] }),
      node({ nodeId: "5", role: { value: "button" }, name: { value: "登录" }, backendDOMNodeId: 7 })
    ];
    const out = prune(wrapped, "1")!;
    const btn = out.children.find((c) => (c as PrunedNode).name === "登录") as PrunedNode | undefined;
    expect(btn).toBeDefined();
    expect(btn!.role).toBe("button");
    expect(btn!.backendNodeId).toBe(7);
  });

  it("保留 backendNodeId 供后续定位", () => {
    const out = prune(tree, "1")!;
    expect(out.children.find((c) => c.name === "登录")!.backendNodeId).toBe(11);
  });

  it("超长 name 截断到 80 字符并加省略号", () => {
    const long = [
      node({ nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] }),
      node({ nodeId: "2", role: { value: "button" }, name: { value: "啊".repeat(200) } })
    ];
    const out = prune(long, "1")!;
    expect(out.children[0].name).toHaveLength(81); // 80 + "…"
    expect(out.children[0].name.endsWith("…")).toBe(true);
  });

  it("把 checked/pressed/disabled 收进 props", () => {
    const withProps = [
      node({ nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] }),
      node({
        nodeId: "2", role: { value: "checkbox" }, name: { value: "包含体系外" },
        properties: [{ name: "checked", value: { value: true } }]
      })
    ];
    const out = prune(withProps, "1")!;
    expect(out.children[0].props.checked).toBe("true");
  });

  it("丢弃与父节点 name 重复的文本节点（button 里的 StaticText/InlineTextBox）", () => {
    const redundant: RawAxNode[] = [
      node({ nodeId: "1", role: { value: "RootWebArea" }, name: { value: "页" }, childIds: ["2"] }),
      node({ nodeId: "2", role: { value: "button" }, name: { value: "查看详情" }, backendDOMNodeId: 9, childIds: ["3"] }),
      node({ nodeId: "3", role: { value: "StaticText" }, name: { value: "查看详情" }, childIds: ["4"] }),
      node({ nodeId: "4", role: { value: "InlineTextBox" }, name: { value: "查看详情" } })
    ];
    const out = prune(redundant, "1")!;
    expect(out.children).toHaveLength(1);
    expect((out.children[0] as PrunedNode).children).toHaveLength(0);
  });

  it("保留没有祖先承载的独立文本（列表里的 <span>员工1</span>）", () => {
    const standalone: RawAxNode[] = [
      node({ nodeId: "1", role: { value: "RootWebArea" }, name: { value: "同构列表" }, childIds: ["2"] }),
      node({ nodeId: "2", role: { value: "StaticText" }, name: { value: "员工1" }, childIds: ["3"] }),
      node({ nodeId: "3", role: { value: "InlineTextBox" }, name: { value: "员工1" } })
    ];
    const out = prune(standalone, "1")!;
    expect(out.children).toHaveLength(1);
    const st = out.children[0] as PrunedNode;
    expect(st.name).toBe("员工1");
    // 它自己的 InlineTextBox 副本仍应被丢掉
    expect(st.children).toHaveLength(0);
  });

  it("保留有 name 的容器节点，即使它本身不可交互", () => {
    const withNamed = [
      node({ nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] }),
      node({ nodeId: "2", role: { value: "navigation" }, name: { value: "全局导航" }, childIds: ["3"] }),
      node({ nodeId: "3", role: { value: "link" }, name: { value: "首页" } })
    ];
    const out = prune(withNamed, "1")!;
    expect(out.children[0].role).toBe("navigation");
    expect(out.children[0].children[0].name).toBe("首页");
  });
});
