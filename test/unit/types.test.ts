import { describe, it, expect } from "vitest";
import { isInteractiveRole, INTERACTIVE_ROLES } from "../../src/types.js";

describe("types", () => {
  it("把 button/link/textbox 认作可交互 role", () => {
    expect(isInteractiveRole("button")).toBe(true);
    expect(isInteractiveRole("link")).toBe(true);
    expect(isInteractiveRole("textbox")).toBe(true);
  });

  it("把 generic/StaticText 认作非交互 role", () => {
    expect(isInteractiveRole("generic")).toBe(false);
    expect(isInteractiveRole("StaticText")).toBe(false);
  });

  it("可交互 role 白名单覆盖常见表单控件", () => {
    for (const r of ["checkbox", "radio", "combobox", "menuitem", "tab", "switch"]) {
      expect(INTERACTIVE_ROLES.has(r)).toBe(true);
    }
  });
});
