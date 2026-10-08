import { describe, expect, it } from "vitest";
import { displayPageUrl, pageChangeNotice } from "../../src/session/pageUrl.js";

describe("URL 变化提示", () => {
  it("初次观察或 URL 未变化不提示", () => {
    expect(pageChangeNotice(undefined, "https://app.test/")).toBe("");
    expect(pageChangeNotice("https://app.test/", "https://app.test/")).toBe("");
  });
  it("变化时展示前后地址并指引刷新快照", () => {
    const note = pageChangeNotice("https://app.test/app", "https://app.test/login");
    expect(note).toContain("页面自上次快照或批次结束后已变化");
    expect(note).toContain("https://app.test/app → https://app.test/login");
    expect(note).toContain("ref 可能已失效");
    expect(note).toContain("snapshot");
  });
  it.each([
    ["https://app.test/?page=1", "https://app.test/?page=2"],
    ["https://app.test/#home", "https://app.test/#login"],
    ["https://app.test/?token=old-sensitive", "https://app.test/?token=new-sensitive"]
  ])("完整原始 URL 变化均可发现：%s", (before, after) => {
    const note = pageChangeNotice(before, after);
    expect(note).toContain("已变化");
    expect(note).not.toContain("old-sensitive");
    expect(note).not.toContain("new-sensitive");
  });
});

describe("诊断 URL 展示", () => {
  it("普通路径、query 和路由 hash 保留", () => {
    const raw = "https://app.test/orders?sort=name#/list?page=2";
    expect(displayPageUrl(raw)).toBe(raw);
    expect(displayPageUrl("https://app.test/#/token-settings")).toBe("https://app.test/#/token-settings");
  });
  it("隐藏 userinfo 和重复、大小写不同的凭证参数，保留普通参数", () => {
    const raw = "https://person:pass-value@app.test/app?access_token=tok-one&TOKEN=tok-two&token=tok-three&token=tok-four&page=3";
    const text = displayPageUrl(raw);
    for (const value of ["person", "pass-value", "tok-one", "tok-two", "tok-three", "tok-four"]) {
      expect(text).not.toContain(value);
    }
    expect(text).toContain("page=3");
    expect(text).toContain("redacted");
  });
  it.each([
    "https://app.test/#access_token=hash-secret&state=keep",
    "https://app.test/#/login?password=hash-secret&tab=keep",
    "https://app.test/?api_key=hash-secret&tab=keep",
    "https://app.test/?authorization=hash-secret&tab=keep"
  ])("凭证参数及片段隐藏：%s", (raw) => {
    const text = displayPageUrl(raw);
    expect(text).not.toContain("hash-secret");
    expect(text).toContain("keep");
  });
  it("data 正文不进入报告；非法地址不泄露原文", () => {
    expect(displayPageUrl("data:text/html,<p>private-content</p>")).not.toContain("private-content");
    expect(displayPageUrl("malformed private-content")).not.toContain("private-content");
    expect(displayPageUrl("about:blank")).toBe("about:blank");
  });
});
