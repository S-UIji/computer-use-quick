# computer-use-quick 一期（Web）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个 MCP Server，把 Web 端到端冒烟测试从「每步一次 agent turn」改为「batch 压缩 + 零模型回放」。

**Architecture:** 单进程 Node MCP Server，经 CDP 连接已运行的 Chrome。三层：感知层把 a11y 树裁剪折叠成精简文本快照；定位层生成多策略 descriptor（容器锚定走 DOM）并解析；执行层用 `batch` 一次执行多步、`replay` 零模型回放已固化 trace。

**Tech Stack:** TypeScript (ESM) · Node 20+ · `@modelcontextprotocol/sdk` · `puppeteer-core`（仅作 CDP 连接层）· `zod` · `vitest`

**Spec:** `docs/superpowers/specs/2026-09-11-computer-use-quick-design.md`

## Global Constraints

- **语言/运行时**：TypeScript 5.6+，Node 20+，`"type": "module"`（纯 ESM）。
- **模块解析**：`tsconfig` 用 `module: Node16` / `moduleResolution: Node16`。**所有相对 import 必须带 `.js` 后缀**（即使源文件是 `.ts`）。这是 ESM + Node16 的硬要求，写错会在运行时报 `ERR_MODULE_NOT_FOUND`。
- **生产依赖只有三个**：`@modelcontextprotocol/sdk`、`puppeteer-core`、`zod`。`puppeteer`（完整版，带 Chromium 下载）只能进 `devDependencies`，仅供测试起浏览器。
- **不使用 puppeteer 的高层 API**（`page.click`、`page.waitForSelector` 等）。只用它拿 `CDPSession`，所有浏览器操作走原始 CDP 命令。理由见 spec §10——保留批量定位的底层优化空间。
- **不提供单步 MCP 工具**。一期只注册 5 个工具：`snapshot`、`batch`、`save_trace`、`replay`、`inspect`。
- **凭证绝不写入 trace 文件**。trace 里只能出现 `${VAR}` 占位符。
- **测试命令**：单元 `npx vitest run test/unit`，集成 `npx vitest run test/integration`，全量 `npx vitest run`。
- **提交信息前缀**：`feat:` / `test:` / `chore:` / `fix:`。
- 所有面向模型的输出文本（快照、失败上下文）用中文标点与半角数字混排，与被测系统语言一致。

---

## 里程碑

| 里程碑 | 任务 | 交付 |
|---|---|---|
| **M1 感知** | 1-7 | MCP Server 可启动，`snapshot` 工具可用，token 相对截图下降可量测 |
| **M2 执行** | 8-15 | `batch` + `inspect` 可用，一条登录流程一次调用完成 |
| **M3 回放** | 16-20 | `save_trace` + `replay` 可用，iframe 可穿透，benchmark 产出真实提速数字 |

---

## 文件结构

```
package.json                        依赖与脚本
tsconfig.json                       TS 配置
vitest.config.ts                    测试配置
src/
  index.ts                          可执行入口（shebang），启动 stdio server
  server.ts                         MCP server 装配 + 5 个工具注册
  types.ts                          跨模块共享类型（唯一类型来源）
  session/
    browser.ts                      连接 Chrome、页面与 CDPSession 管理
  perception/
    axtree.ts                       CDP 拉 AX 树 → RawAxNode[]
    prune.ts                        裁剪规则（纯函数）
    collapse.ts                     同构模式折叠（纯函数）
    render.ts                       → 缩进文本（纯函数）
    snapshot.ts                     编排 + ref 表维护
  locator/
    container.ts                    DOM 容器锚点求解（浏览器侧 JS）
    descriptor.ts                   descriptor 懒生成
    resolve.ts                      多策略解析 + 漂移判定
  executor/
    variables.ts                    ${VAR} 插值 + extract 变量表
    actions.ts                      单个 action 实现
    batch.ts                        batch 编排 + fail-fast + 失败上下文
  waiter/
    stability.ts                    隐式稳定性等待
    explicit.ts                     显式等待条件
  assertion/
    assert.ts                       断言
  diagnostics/
    collector.ts                    console / 网络失败采集（batch 失败上下文与 inspect 共用）
  trace/
    store.ts                        trace 读写
    replay.ts                       回放引擎
  report/
    runRecord.ts                    run-record 生成
test/
  unit/                             纯函数单测
  fixtures/
    server.ts                       静态 HTTP 服务
    pages/*.html                    7 个 fixture 页面
  integration/                      需真实浏览器的测试
  bench/
    run.ts                          A/B/C 基准脚本
```

**边界说明**：`perception/` 的 4 个文件中 3 个是纯函数（`prune`/`collapse`/`render`），只有 `axtree.ts` 碰 CDP——这样折叠和裁剪逻辑可以毫秒级单测，不需要浏览器。`locator/` 与 `perception/` 之间的接口是 `PrunedNode[] → Descriptor`，这是 spec §3 说的三期桌面后端接入点。

---

# M1 · 感知

### Task 1: 项目骨架与核心类型

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/types.ts`
- Test: `test/unit/types.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: `src/types.ts` 导出全部跨模块类型 —— `RawAxNode`、`PrunedNode`、`CollapsedGroup`、`SnapshotResult`、`Strategy`、`Descriptor`、`Step`、`Trace`、`StepResult`、`RunRecord`、`FailureContext`。后续所有任务从这里 import 类型，不各自重复定义。

- [ ] **Step 1: 创建 `package.json`**

```json
{
  "name": "computer-use-quick",
  "version": "0.1.0",
  "type": "module",
  "bin": { "computer-use-quick": "./dist/index.js" },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:unit": "vitest run test/unit",
    "test:integration": "vitest run test/integration"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "puppeteer-core": "^24.0.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.7.0",
    "puppeteer": "^24.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: 创建 `tsconfig.json`、`vitest.config.ts`、`.gitignore`**

`tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src"]
}
```

`vitest.config.ts`：

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false
  }
});
```

> `fileParallelism: false` 是刻意的——集成测试共享一个浏览器实例，并行会互相踩。

`.gitignore`：

```
node_modules/
dist/
*.log
test/bench/out/
```

- [ ] **Step 3: 写失败的类型测试**

创建 `test/unit/types.test.ts`：

```ts
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
```

- [ ] **Step 4: 运行测试确认失败**

Run: `npx vitest run test/unit/types.test.ts`
Expected: FAIL —— `Failed to resolve import "../../src/types.js"`

- [ ] **Step 5: 实现 `src/types.ts`**

```ts
/** CDP Accessibility.getFullAXTree 返回的原始节点（只保留我们用得到的字段） */
export interface RawAxNode {
  nodeId: string;
  ignored: boolean;
  role?: { value?: string };
  name?: { value?: string };
  description?: { value?: string };
  value?: { value?: string | number };
  properties?: Array<{ name: string; value: { value?: unknown } }>;
  childIds?: string[];
  backendDOMNodeId?: number;
}

/** 裁剪后的节点，树形结构 */
export interface PrunedNode {
  role: string;
  name: string;
  /** 附加语义：value / checked / pressed / expanded / disabled / description */
  props: Record<string, string>;
  backendNodeId?: number;
  children: PrunedNode[];
}

/** 同构折叠后，快照树里的一个折叠组 */
export interface CollapsedGroup {
  kind: "collapsed-group";
  /** 组内项数 */
  count: number;
  /** 结构签名里出现的字段名，用于给模型解释折叠了什么 */
  fields: string[];
  /** 每一项的区别性摘要（不折叠掉，spec §5.2 缓解 2） */
  items: string[];
  /** 展开用的组 id，供 snapshot 的 expand 参数引用 */
  groupId: string;
}

export type SnapshotNode = PrunedNode | CollapsedGroup;

export interface SnapshotResult {
  /** 渲染好的缩进文本，直接给模型 */
  text: string;
  /** ref → backendNodeId 映射，仅本次快照有效 */
  refs: Map<string, number>;
  /** 统计，用于 benchmark */
  stats: { rawNodes: number; prunedNodes: number; collapsedGroups: number };
}

// ---------- 定位 ----------

export type Strategy =
  | { kind: "test-id"; value: string }
  | { kind: "container-role-name"; containerText: string; role: string; name: string; nth?: number }
  | { kind: "row-role-name"; rowText: string; role: string; name: string; nth?: number }
  | { kind: "role-name"; role: string; name: string; nth?: number }
  | { kind: "text"; tag: string; text: string; nth?: number }
  | { kind: "css"; value: string }
  | { kind: "xpath"; value: string };

export interface Descriptor {
  /** 按优先级排列，解析时依次尝试 */
  strategies: Strategy[];
  /** frame 路径，空数组表示主 frame */
  framePath: string[];
  /** 容器内区别性内容，用于同名元素兜底消歧（spec §6.4） */
  distinguishers?: string[];
}

export interface ResolveResult {
  backendNodeId: number;
  /** 命中的是第几条策略（0-based），用于漂移告警 */
  strategyIndex: number;
  strategyKind: Strategy["kind"];
}

// ---------- 执行 ----------

export type Step =
  | { action: "navigate"; url: string }
  | { action: "click"; target: TargetRef }
  | { action: "fill"; target: TargetRef; value: string }
  | { action: "select"; target: TargetRef; value: string }
  | { action: "press"; key: string }
  | { action: "hover"; target: TargetRef }
  | { action: "scroll"; target?: TargetRef; direction?: "up" | "down"; amount?: number }
  | { action: "wait"; until: WaitCondition; timeout?: number }
  | { action: "sleep"; ms: number }
  | { action: "assert"; type: AssertType; target?: TargetRef; expected?: string }
  | { action: "extract"; target: TargetRef; as: string; from?: "text" | "value" };

/** batch 里用 ref（本次快照的短期句柄）；trace 里用 descriptor（长期） */
export type TargetRef = { ref: string } | { descriptor: Descriptor };

export type WaitCondition =
  | { type: "visible"; target: TargetRef }
  | { type: "hidden"; target: TargetRef }
  | { type: "url-contains"; value: string }
  | { type: "response"; urlPattern: string };

export type AssertType = "visible" | "hidden" | "text-equals" | "text-contains" | "url-contains";

export interface StepResult {
  index: number;
  action: Step["action"];
  ok: boolean;
  durationMs: number;
  /** 命中的策略序号，仅 replay 时有值 */
  strategyIndex?: number;
  /** 漂移告警：命中的不是第一条策略 */
  drift?: { expected: Strategy["kind"]; actual: Strategy["kind"] };
  error?: string;
}

export type FailureKind = "target-not-found" | "ambiguous" | "timeout" | "assert-failed" | "navigation-failed";

export interface FailureContext {
  failedIndex: number;
  failedStep: Step;
  kind: FailureKind;
  message: string;
  snapshot: string;
  candidates?: string[];
  consoleErrors: string[];
  failedRequests: string[];
}

// ---------- 轨迹 ----------

export interface Trace {
  name: string;
  baseUrl: string;
  createdAt: string;
  steps: Step[];
}

export interface RunRecord {
  traceName: string;
  startedAt: string;
  durationMs: number;
  ok: boolean;
  steps: StepResult[];
  drifts: Array<{ index: number; expected: string; actual: string }>;
  failure?: FailureContext;
  healRequired: boolean;
}

// ---------- role 白名单 ----------

export const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio",
  "combobox", "listbox", "option", "menuitem", "menuitemcheckbox",
  "menuitemradio", "tab", "switch", "slider", "spinbutton", "treeitem"
]);

export const SEMANTIC_TEXT_ROLES = new Set([
  "heading", "status", "alert", "alertdialog", "dialog", "tooltip"
]);

export function isInteractiveRole(role: string): boolean {
  return INTERACTIVE_ROLES.has(role);
}
```

- [ ] **Step 6: 安装依赖并运行测试确认通过**

Run: `npm install && npx vitest run test/unit/types.test.ts`
Expected: PASS，3 个用例全绿

- [ ] **Step 7: 提交**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore src/types.ts test/unit/types.test.ts
git commit -m "feat: 项目骨架与核心类型定义"
```

---

### Task 2: 浏览器会话层

**Files:**
- Create: `src/session/browser.ts`
- Test: `test/integration/browser.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `class BrowserSession`
  - `static async connect(browserURL: string): Promise<BrowserSession>`
  - `listPages(): Promise<Array<{ pageId: string; title: string; url: string }>>`
  - `getPage(pageId?: string): Promise<PageHandle>` —— 省略 pageId 时返回当前选中页
  - `selectPage(pageId: string): void`
  - `close(): Promise<void>`
  - `interface PageHandle { pageId: string; page: Page; cdp: CDPSession }`

后续所有需要浏览器的模块都通过 `PageHandle.cdp` 发 CDP 命令，**不碰 `PageHandle.page` 的高层方法**。

- [ ] **Step 1: 写失败的集成测试**

创建 `test/integration/browser.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import puppeteer, { type Browser } from "puppeteer";
import { BrowserSession } from "../../src/session/browser.js";

let chrome: Browser;
let session: BrowserSession;

beforeAll(async () => {
  chrome = await puppeteer.launch({
    headless: true,
    args: ["--remote-debugging-port=9333", "--no-sandbox"]
  });
  session = await BrowserSession.connect("http://127.0.0.1:9333");
});

afterAll(async () => {
  await session?.close();
  await chrome?.close();
});

describe("BrowserSession", () => {
  it("能列出至少一个页面", async () => {
    const pages = await session.listPages();
    expect(pages.length).toBeGreaterThan(0);
    expect(pages[0]).toHaveProperty("pageId");
    expect(pages[0]).toHaveProperty("url");
  });

  it("getPage 返回可用的 CDPSession", async () => {
    const handle = await session.getPage();
    const { result } = await handle.cdp.send("Runtime.evaluate", {
      expression: "1 + 1",
      returnByValue: true
    });
    expect(result.value).toBe(2);
  });

  it("同一 pageId 重复 getPage 复用同一个 CDPSession", async () => {
    const pages = await session.listPages();
    const a = await session.getPage(pages[0].pageId);
    const b = await session.getPage(pages[0].pageId);
    expect(a.cdp).toBe(b.cdp);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/integration/browser.test.ts`
Expected: FAIL —— `Failed to resolve import "../../src/session/browser.js"`

- [ ] **Step 3: 实现 `src/session/browser.ts`**

```ts
import puppeteer, { type Browser, type Page, type CDPSession } from "puppeteer-core";

export interface PageHandle {
  pageId: string;
  page: Page;
  cdp: CDPSession;
}

export class BrowserSession {
  private handles = new Map<string, PageHandle>();
  private selected?: string;

  private constructor(private browser: Browser) {}

  static async connect(browserURL: string): Promise<BrowserSession> {
    const browser = await puppeteer.connect({ browserURL, defaultViewport: null });
    return new BrowserSession(browser);
  }

  async listPages(): Promise<Array<{ pageId: string; title: string; url: string }>> {
    const pages = await this.browser.pages();
    const out: Array<{ pageId: string; title: string; url: string }> = [];
    for (const page of pages) {
      const pageId = page.target()._targetId ?? page.url();
      out.push({ pageId, title: await page.title(), url: page.url() });
    }
    return out;
  }

  selectPage(pageId: string): void {
    this.selected = pageId;
  }

  async getPage(pageId?: string): Promise<PageHandle> {
    const id = pageId ?? this.selected;
    const pages = await this.browser.pages();

    let page: Page | undefined;
    if (id) {
      page = pages.find((p) => (p.target()._targetId ?? p.url()) === id);
    }
    page ??= pages[0];
    if (!page) throw new Error("浏览器中没有可用页面");

    const key = page.target()._targetId ?? page.url();
    const cached = this.handles.get(key);
    if (cached) return cached;

    const cdp = await page.createCDPSession();
    await cdp.send("Accessibility.enable");
    await cdp.send("DOM.enable");
    await cdp.send("Runtime.enable");

    const handle: PageHandle = { pageId: key, page, cdp };
    this.handles.set(key, handle);
    this.selected ??= key;
    return handle;
  }

  async close(): Promise<void> {
    for (const h of this.handles.values()) {
      await h.cdp.detach().catch(() => {});
    }
    this.handles.clear();
    this.browser.disconnect();
  }
}
```

> `page.target()._targetId` 访问的是内部字段，TS 会报错。在文件顶部加一行类型放宽：
> ```ts
> declare module "puppeteer-core" {
>   interface Target { _targetId?: string }
> }
> ```
> 放在 import 之后、`export interface PageHandle` 之前。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/integration/browser.test.ts`
Expected: PASS，3 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add src/session/browser.ts test/integration/browser.test.ts
git commit -m "feat: 浏览器会话层，经 CDP 连接已运行的 Chrome"
```

---

### Task 3: fixture 静态站点

**Files:**
- Create: `test/fixtures/server.ts`
- Create: `test/fixtures/pages/form.html`
- Create: `test/fixtures/pages/async-list.html`
- Create: `test/fixtures/pages/table-dup.html`
- Create: `test/fixtures/pages/cards-no-container.html`
- Create: `test/fixtures/pages/modal-iframe.html`
- Create: `test/fixtures/pages/iframe-inner.html`
- Create: `test/fixtures/pages/homo-list.html`
- Test: `test/integration/fixtures.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `startFixtureServer(port?: number): Promise<{ url: string; close: () => Promise<void> }>` —— 后续所有集成测试用它起被测站点。默认端口 0（系统分配），返回实际 url。

**为什么现在做**：M1/M2/M3 的每个集成测试都依赖它。`cards-no-container.html` 专门复刻靶场的真实形态（spec §6.3 —— a11y 树里没有卡片容器）。

- [ ] **Step 1: 写失败的测试**

创建 `test/integration/fixtures.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startFixtureServer } from "../fixtures/server.js";

let server: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => { server = await startFixtureServer(); });
afterAll(async () => { await server.close(); });

describe("fixture server", () => {
  it("返回可访问的 url", () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("能取到七个 fixture 页面", async () => {
    const pages = [
      "form", "async-list", "table-dup",
      "cards-no-container", "modal-iframe", "iframe-inner", "homo-list"
    ];
    for (const p of pages) {
      const res = await fetch(`${server.url}/${p}.html`);
      expect(res.status, `${p}.html 应可访问`).toBe(200);
      expect(await res.text()).toContain("<html");
    }
  });

  it("未知路径返回 404", async () => {
    const res = await fetch(`${server.url}/nope.html`);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/integration/fixtures.test.ts`
Expected: FAIL —— 无法解析 `../fixtures/server.js`

- [ ] **Step 3: 实现 `test/fixtures/server.ts`**

```ts
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pagesDir = join(here, "pages");

export async function startFixtureServer(port = 0) {
  const server = createServer(async (req, res) => {
    const name = normalize(decodeURIComponent((req.url ?? "/").split("?")[0])).replace(/^([/\\])+/, "");
    if (!name.endsWith(".html") || name.includes("..")) {
      res.writeHead(404).end("not found");
      return;
    }
    try {
      const body = await readFile(join(pagesDir, name), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;

  return {
    url: `http://127.0.0.1:${actualPort}`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    )
  };
}
```

- [ ] **Step 4: 创建 `form.html`（基础控件）**

```html
<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>表单</title></head>
<body>
  <main>
    <h1>用户登录</h1>
    <form id="login-form">
      <label for="user">用户名</label>
      <input id="user" name="user" type="text">
      <label for="pwd">密码</label>
      <input id="pwd" name="pwd" type="password">
      <label for="region">地区</label>
      <select id="region">
        <option value="bj">北京</option>
        <option value="hf">合肥</option>
      </select>
      <label><input id="remember" type="checkbox"> 记住我</label>
      <button type="button" id="submit">登录</button>
    </form>
    <p id="result"></p>
  </main>
  <script>
    document.getElementById("submit").addEventListener("click", () => {
      const u = document.getElementById("user").value;
      document.getElementById("result").textContent = u ? `欢迎 ${u}` : "请输入用户名";
    });
  </script>
</body></html>
```

- [ ] **Step 5: 创建 `async-list.html`（异步加载，验隐式等待）**

```html
<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>异步列表</title></head>
<body>
  <main>
    <h1>订单列表</h1>
    <button type="button" id="load">加载数据</button>
    <ul id="list"><li>尚未加载</li></ul>
  </main>
  <script>
    document.getElementById("load").addEventListener("click", () => {
      const list = document.getElementById("list");
      list.innerHTML = "<li>加载中…</li>";
      // 800ms 后才出结果：固定 sleep 300ms 会漏，隐式等待应该等到
      setTimeout(() => {
        list.innerHTML = "<li>ORD20260911</li><li>ORD20260912</li>";
      }, 800);
    });
  </script>
</body></html>
```

- [ ] **Step 6: 创建 `table-dup.html`（同名按钮，验行锚定）**

```html
<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>同名按钮表格</title></head>
<body>
  <main>
    <h1>订单管理</h1>
    <table>
      <thead><tr><th>单号</th><th>金额</th><th>操作</th></tr></thead>
      <tbody>
        <tr><td>ORD20260911</td><td>100</td><td><button type="button">删除</button></td></tr>
        <tr><td>ORD20260912</td><td>200</td><td><button type="button">删除</button></td></tr>
        <tr><td>ORD20260913</td><td>300</td><td><button type="button">删除</button></td></tr>
      </tbody>
    </table>
    <p id="deleted">未删除</p>
  </main>
  <script>
    document.querySelectorAll("tbody button").forEach((b) => {
      b.addEventListener("click", (e) => {
        const id = e.target.closest("tr").querySelector("td").textContent;
        document.getElementById("deleted").textContent = `已删除 ${id}`;
      });
    });
  </script>
</body></html>
```

- [ ] **Step 7: 创建 `cards-no-container.html`（复刻靶场形态：a11y 无容器）**

关键：卡片用 `<div>` 且**不加任何 role**，所以 AX 树里不会出现容器节点——这正是 spec §6.3 描述的真实情况。

```html
<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>部门卡片墙</title></head>
<body>
  <main>
    <h1>组织一览</h1>
    <div id="wall">
      <div class="card">
        <div class="title">教育事业群</div>
        <button type="button">查看在岗干部明细</button>
        <button type="button">负责人治理</button>
        <span>总人数 5081 人</span>
      </div>
      <div class="card">
        <div class="title">技术平台中心</div>
        <button type="button">查看在岗干部明细</button>
        <button type="button">负责人治理</button>
        <span>总人数 0 人</span>
      </div>
      <div class="card">
        <div class="title">人力资源中心</div>
        <button type="button">查看在岗干部明细</button>
        <button type="button">负责人治理</button>
        <span>总人数 0 人</span>
      </div>
    </div>
    <p id="clicked">未点击</p>
  </main>
  <script>
    document.querySelectorAll(".card button").forEach((b) => {
      b.addEventListener("click", (e) => {
        const card = e.target.closest(".card");
        const name = card.querySelector(".title").textContent;
        document.getElementById("clicked").textContent = `${name} · ${e.target.textContent}`;
      });
    });
  </script>
</body></html>
```

- [ ] **Step 8: 创建 `modal-iframe.html` 与 `iframe-inner.html`**

`modal-iframe.html`：

```html
<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>弹窗与 iframe</title></head>
<body>
  <main>
    <h1>设置</h1>
    <button type="button" id="open">打开弹窗</button>
    <div id="modal" role="dialog" aria-label="新增订单" hidden>
      <label for="cust">客户名称</label>
      <input id="cust" type="text">
      <button type="button" id="save">保存</button>
    </div>
    <iframe id="inner" src="/iframe-inner.html" title="内嵌表单" width="400" height="200"></iframe>
  </main>
  <script>
    document.getElementById("open").addEventListener("click", () => {
      document.getElementById("modal").hidden = false;
    });
  </script>
</body></html>
```

`iframe-inner.html`：

```html
<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>内嵌</title></head>
<body>
  <label for="note">备注</label>
  <input id="note" type="text">
  <button type="button" id="inner-ok">确认</button>
</body></html>
```

- [ ] **Step 9: 创建 `homo-list.html`（20 项同构，验折叠）**

```html
<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>同构列表</title></head>
<body>
  <main>
    <h1>人员列表</h1>
    <div id="rows"></div>
  </main>
  <script>
    const rows = document.getElementById("rows");
    for (let i = 1; i <= 20; i++) {
      const d = document.createElement("div");
      d.innerHTML =
        `<span class="nm">员工${i}</span>` +
        `<button type="button">查看详情</button>` +
        `<button type="button">编辑</button>`;
      rows.appendChild(d);
    }
  </script>
</body></html>
```

- [ ] **Step 10: 运行测试确认通过**

Run: `npx vitest run test/integration/fixtures.test.ts`
Expected: PASS，3 个用例全绿

- [ ] **Step 11: 提交**

```bash
git add test/fixtures test/integration/fixtures.test.ts
git commit -m "test: fixture 静态站点与七个被测页面"
```

---

### Task 4: AX 树抓取

**Files:**
- Create: `src/perception/axtree.ts`
- Test: `test/integration/axtree.test.ts`

**Interfaces:**
- Consumes: `PageHandle`（Task 2）、`RawAxNode`（Task 1）
- Produces:
  - `async function fetchAxTree(cdp: CDPSession): Promise<RawAxNode[]>` —— 返回扁平数组
  - `function buildTree(nodes: RawAxNode[]): RawAxNode | undefined` —— 找出根节点（无父引用者）
  - `function indexById(nodes: RawAxNode[]): Map<string, RawAxNode>`

- [ ] **Step 1: 写失败的集成测试**

创建 `test/integration/axtree.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import puppeteer, { type Browser } from "puppeteer";
import { BrowserSession } from "../../src/session/browser.js";
import { startFixtureServer } from "../fixtures/server.js";
import { fetchAxTree, indexById, buildTree } from "../../src/perception/axtree.js";

let chrome: Browser, session: BrowserSession, fx: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  fx = await startFixtureServer();
  chrome = await puppeteer.launch({ headless: true, args: ["--remote-debugging-port=9334", "--no-sandbox"] });
  session = await BrowserSession.connect("http://127.0.0.1:9334");
  const h = await session.getPage();
  await h.cdp.send("Page.enable");
  await h.page.goto(`${fx.url}/form.html`, { waitUntil: "load" });
});

afterAll(async () => { await session?.close(); await chrome?.close(); await fx?.close(); });

describe("fetchAxTree", () => {
  it("抓到的节点数大于 10", async () => {
    const h = await session.getPage();
    const nodes = await fetchAxTree(h.cdp);
    expect(nodes.length).toBeGreaterThan(10);
  });

  it("包含登录按钮，且带 backendDOMNodeId", async () => {
    const h = await session.getPage();
    const nodes = await fetchAxTree(h.cdp);
    const btn = nodes.find((n) => n.role?.value === "button" && n.name?.value === "登录");
    expect(btn).toBeDefined();
    expect(btn!.backendDOMNodeId).toBeGreaterThan(0);
  });

  it("buildTree 能找到 RootWebArea 根节点", async () => {
    const h = await session.getPage();
    const nodes = await fetchAxTree(h.cdp);
    const root = buildTree(nodes);
    expect(root?.role?.value).toBe("RootWebArea");
  });

  it("indexById 建出与节点数等长的索引", async () => {
    const h = await session.getPage();
    const nodes = await fetchAxTree(h.cdp);
    expect(indexById(nodes).size).toBe(nodes.length);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/integration/axtree.test.ts`
Expected: FAIL —— 无法解析 `src/perception/axtree.js`

- [ ] **Step 3: 实现 `src/perception/axtree.ts`**

```ts
import type { CDPSession } from "puppeteer-core";
import type { RawAxNode } from "../types.js";

export async function fetchAxTree(cdp: CDPSession): Promise<RawAxNode[]> {
  const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as { nodes: RawAxNode[] };
  return nodes;
}

export function indexById(nodes: RawAxNode[]): Map<string, RawAxNode> {
  const map = new Map<string, RawAxNode>();
  for (const n of nodes) map.set(n.nodeId, n);
  return map;
}

export function buildTree(nodes: RawAxNode[]): RawAxNode | undefined {
  const childIds = new Set<string>();
  for (const n of nodes) for (const c of n.childIds ?? []) childIds.add(c);
  return nodes.find((n) => !childIds.has(n.nodeId));
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/integration/axtree.test.ts`
Expected: PASS，4 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add src/perception/axtree.ts test/integration/axtree.test.ts
git commit -m "feat: CDP a11y 树抓取与索引"
```

---

### Task 5: 裁剪规则

**Files:**
- Create: `src/perception/prune.ts`
- Test: `test/unit/prune.test.ts`

**Interfaces:**
- Consumes: `RawAxNode`、`PrunedNode`、`INTERACTIVE_ROLES`、`SEMANTIC_TEXT_ROLES`（Task 1）；`indexById`（Task 4）
- Produces: `function prune(nodes: RawAxNode[], rootId: string, opts?: PruneOptions): PrunedNode | undefined`，`interface PruneOptions { maxNameLength?: number }`（默认 80）

纯函数，单测不需要浏览器。

- [ ] **Step 1: 写失败的单测**

创建 `test/unit/prune.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { prune } from "../../src/perception/prune.js";
import type { RawAxNode } from "../../src/types.js";

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
    expect(out.children.some((c) => c.name === "隐藏按钮")).toBe(false);
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/unit/prune.test.ts`
Expected: FAIL —— 无法解析 `src/perception/prune.js`

- [ ] **Step 3: 实现 `src/perception/prune.ts`**

```ts
import type { RawAxNode, PrunedNode } from "../types.js";
import { INTERACTIVE_ROLES, SEMANTIC_TEXT_ROLES } from "../types.js";
import { indexById } from "./axtree.js";

export interface PruneOptions { maxNameLength?: number }

const KEEP_PROPS = new Set(["checked", "pressed", "expanded", "disabled", "selected", "level"]);

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function collectProps(n: RawAxNode): Record<string, string> {
  const props: Record<string, string> = {};
  for (const p of n.properties ?? []) {
    if (!KEEP_PROPS.has(p.name)) continue;
    const v = p.value?.value;
    if (v === undefined || v === null || v === false || v === "false") continue;
    props[p.name] = String(v);
  }
  const val = n.value?.value;
  if (val !== undefined && val !== null && val !== "") props.value = String(val);
  const desc = n.description?.value;
  if (desc) props.description = desc;
  return props;
}

/** 一个节点是否值得单独出现在快照里（不考虑其子孙） */
function isKeepable(role: string, name: string): boolean {
  if (INTERACTIVE_ROLES.has(role)) return true;
  if (SEMANTIC_TEXT_ROLES.has(role)) return true;
  // 有可及名称的容器（navigation "全局导航" 这类）保留，作为容器锚点参照
  if (name.length > 0 && role !== "generic" && role !== "StaticText") return true;
  return false;
}

export function prune(
  nodes: RawAxNode[],
  rootId: string,
  opts: PruneOptions = {}
): PrunedNode | undefined {
  const maxName = opts.maxNameLength ?? 80;
  const index = indexById(nodes);

  function walk(id: string): PrunedNode[] {
    const n = index.get(id);
    if (!n || n.ignored) return [];

    const role = n.role?.value ?? "";
    const name = truncate((n.name?.value ?? "").trim(), maxName);
    const children = (n.childIds ?? []).flatMap(walk);

    if (!isKeepable(role, name)) {
      // 自己不值得保留，但子孙可能值得：把子孙提升到父级
      return children;
    }
    return [{ role, name, props: collectProps(n), backendNodeId: n.backendDOMNodeId, children }];
  }

  const root = index.get(rootId);
  if (!root) return undefined;
  return {
    role: root.role?.value ?? "RootWebArea",
    name: truncate((root.name?.value ?? "").trim(), maxName),
    props: {},
    backendNodeId: root.backendDOMNodeId,
    children: (root.childIds ?? []).flatMap(walk)
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/unit/prune.test.ts`
Expected: PASS，8 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add src/perception/prune.ts test/unit/prune.test.ts
git commit -m "feat: a11y 快照裁剪规则"
```

---

### Task 6: 同构模式折叠

**Files:**
- Create: `src/perception/collapse.ts`
- Test: `test/unit/collapse.test.ts`

**Interfaces:**
- Consumes: `PrunedNode`、`CollapsedGroup`、`SnapshotNode`（Task 1）
- Produces:
  - `function signature(node: PrunedNode, depth?: number): string`（默认 depth 2）
  - `function collapse(root: PrunedNode, opts?: CollapseOptions): PrunedNode`
  - `interface CollapseOptions { threshold?: number; expand?: string[] }`（threshold 默认 3）
  - 折叠后的组以 `CollapsedGroup` 形态挂在父节点的 `children` 里（类型上用 `SnapshotNode`）

> 实现要点：`PrunedNode.children` 声明为 `PrunedNode[]`，要容纳 `CollapsedGroup` 需要在 Task 1 的类型上做一处扩展。本任务 Step 3 会改 `types.ts` 把 `children` 改成 `SnapshotNode[]`，并在 `prune.ts` 里补类型收窄。

- [ ] **Step 1: 写失败的单测**

创建 `test/unit/collapse.test.ts`：

```ts
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

  it("同一输入两次折叠产生相同的 groupId（可稳定引用）", () => {
    const root: PrunedNode = { role: "main", name: "", props: {}, children: [
      card("甲", "1"), card("乙", "2"), card("丙", "3")
    ]};
    const a = (collapse(root, { threshold: 3 }).children[0] as CollapsedGroup).groupId;
    const b = (collapse(root, { threshold: 3 }).children[0] as CollapsedGroup).groupId;
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/unit/collapse.test.ts`
Expected: FAIL —— 无法解析 `src/perception/collapse.js`

- [ ] **Step 3: 调整 `src/types.ts` 让 children 容纳折叠组**

把 `PrunedNode.children` 的类型从 `PrunedNode[]` 改为 `SnapshotNode[]`，并加一个类型守卫：

```ts
export interface PrunedNode {
  role: string;
  name: string;
  props: Record<string, string>;
  backendNodeId?: number;
  children: SnapshotNode[];
}

export function isCollapsedGroup(n: SnapshotNode): n is CollapsedGroup {
  return (n as CollapsedGroup).kind === "collapsed-group";
}
```

`SnapshotNode` 与 `CollapsedGroup` 的定义保持 Task 1 原样。`prune.ts` 无需改动（它只产出 `PrunedNode`，赋给 `SnapshotNode[]` 是合法的）。

- [ ] **Step 4: 实现 `src/perception/collapse.ts`**

```ts
import type { PrunedNode, SnapshotNode, CollapsedGroup } from "../types.js";
import { isCollapsedGroup } from "../types.js";

export interface CollapseOptions {
  threshold?: number;
  expand?: string[];
}

/** 结构签名：role 序列递归到指定深度，不含 name（name 是区别性内容，不进签名） */
export function signature(node: SnapshotNode, depth = 2): string {
  if (isCollapsedGroup(node)) return `group(${node.count})`;
  if (depth === 0) return node.role;
  return `${node.role}(${node.children.map((c) => signature(c, depth - 1)).join(",")})`;
}

/** 稳定 hash：同样的输入必然得到同样的 groupId */
function stableId(sig: string, path: string): string {
  let h = 0;
  const s = `${path}|${sig}`;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return `g${(h >>> 0).toString(36)}`;
}

/** 取一个节点的区别性摘要：自身 name + 所有后代里的非空文本，去重后拼接 */
function summarize(node: PrunedNode): string {
  const parts: string[] = [];
  if (node.name) parts.push(node.name);
  const walk = (n: SnapshotNode) => {
    if (isCollapsedGroup(n)) return;
    if (n.name && !parts.includes(n.name)) parts.push(n.name);
    for (const c of n.children) walk(c);
  };
  for (const c of node.children) walk(c);
  return parts.join(" · ");
}

/** 取组内成员共有的字段名（用第一项的后代 role 列表代表结构） */
function fieldsOf(node: PrunedNode): string[] {
  const out: string[] = [];
  const walk = (n: SnapshotNode) => {
    if (isCollapsedGroup(n)) return;
    out.push(n.name || n.role);
    for (const c of n.children) walk(c);
  };
  for (const c of node.children) walk(c);
  return out;
}

export function collapse(root: PrunedNode, opts: CollapseOptions = {}): PrunedNode {
  const threshold = opts.threshold ?? 3;
  const expand = new Set(opts.expand ?? []);

  function walk(node: PrunedNode, path: string): PrunedNode {
    const kids = node.children.map((c, i) =>
      isCollapsedGroup(c) ? c : walk(c, `${path}/${c.role}[${i}]`)
    );

    const out: SnapshotNode[] = [];
    let i = 0;
    while (i < kids.length) {
      const cur = kids[i];
      if (isCollapsedGroup(cur)) { out.push(cur); i++; continue; }

      const sig = signature(cur);
      let j = i + 1;
      while (j < kids.length) {
        const next = kids[j];
        if (isCollapsedGroup(next) || signature(next) !== sig) break;
        j++;
      }
      const run = kids.slice(i, j) as PrunedNode[];

      if (run.length >= threshold) {
        const groupId = stableId(sig, `${path}#${i}`);
        if (expand.has(groupId)) {
          out.push(...run);
        } else {
          out.push({
            kind: "collapsed-group",
            count: run.length,
            fields: fieldsOf(run[0]),
            items: run.map(summarize),
            groupId
          } satisfies CollapsedGroup);
        }
      } else {
        out.push(...run);
      }
      i = j;
    }

    return { ...node, children: out };
  }

  return walk(root, "");
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run test/unit/collapse.test.ts && npx vitest run test/unit/prune.test.ts`
Expected: 两个文件全绿（collapse 6 个 + prune 8 个）

- [ ] **Step 6: 提交**

```bash
git add src/types.ts src/perception/collapse.ts test/unit/collapse.test.ts
git commit -m "feat: 同构模式折叠，带稳定 groupId 与 expand 展开"
```

---

### Task 7: 快照渲染、编排与 `snapshot` 工具

**Files:**
- Create: `src/perception/render.ts`
- Create: `src/perception/snapshot.ts`
- Create: `src/server.ts`
- Create: `src/index.ts`
- Test: `test/unit/render.test.ts`
- Test: `test/integration/snapshot.test.ts`

**Interfaces:**
- Consumes: `fetchAxTree`/`buildTree`（Task 4）、`prune`（Task 5）、`collapse`（Task 6）、`PageHandle`（Task 2）
- Produces:
  - `function render(root: PrunedNode): { text: string; refs: Map<string, number> }`
  - `async function takeSnapshot(handle: PageHandle, opts?: { expand?: string[]; threshold?: number }): Promise<SnapshotResult>`
  - `function createServer(session: BrowserSession): McpServer` —— 注册全部工具；本任务只注册 `snapshot`，后续任务往里加
  - `src/index.ts` 是可执行入口，读环境变量 `CUQ_BROWSER_URL`（默认 `http://127.0.0.1:9222`）

**M1 里程碑在此达成**：server 可启动，`snapshot` 可用。

- [ ] **Step 1: 写失败的渲染单测**

创建 `test/unit/render.test.ts`：

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/unit/render.test.ts`
Expected: FAIL —— 无法解析 `src/perception/render.js`

- [ ] **Step 3: 实现 `src/perception/render.ts`**

```ts
import type { PrunedNode, SnapshotNode } from "../types.js";
import { isCollapsedGroup } from "../types.js";

export function render(root: PrunedNode): { text: string; refs: Map<string, number> } {
  const refs = new Map<string, number>();
  const lines: string[] = [];
  let counter = 0;

  function propsSuffix(props: Record<string, string>): string {
    const entries = Object.entries(props);
    return entries.length ? " " + entries.map(([k, v]) => `${k}=${v}`).join(" ") : "";
  }

  function emit(node: SnapshotNode, depth: number): void {
    const pad = "  ".repeat(depth);

    if (isCollapsedGroup(node)) {
      lines.push(`${pad}[${node.count} 项结构相同，展开用 expand=["${node.groupId}"]，字段：${node.fields.join("/")}]`);
      node.items.forEach((it, i) => lines.push(`${pad}  ${i + 1}. ${it}`));
      return;
    }

    let prefix = "";
    if (node.backendNodeId !== undefined) {
      const ref = `e${++counter}`;
      refs.set(ref, node.backendNodeId);
      prefix = `[${ref}] `;
    }
    lines.push(`${pad}${prefix}${node.role}${node.name ? ` "${node.name}"` : ""}${propsSuffix(node.props)}`);
    for (const c of node.children) emit(c, depth + 1);
  }

  // 根节点自身不渲染成一行，直接渲染其子树
  for (const c of root.children) emit(c, 0);

  return { text: lines.join("\n"), refs };
}
```

- [ ] **Step 4: 运行渲染测试确认通过**

Run: `npx vitest run test/unit/render.test.ts`
Expected: PASS，5 个用例全绿

- [ ] **Step 5: 实现 `src/perception/snapshot.ts`**

```ts
import type { PageHandle } from "../session/browser.js";
import type { SnapshotResult } from "../types.js";
import { fetchAxTree, buildTree } from "./axtree.js";
import { prune } from "./prune.js";
import { collapse } from "./collapse.js";
import { render } from "./render.js";

export interface SnapshotOptions {
  expand?: string[];
  threshold?: number;
}

export async function takeSnapshot(
  handle: PageHandle,
  opts: SnapshotOptions = {}
): Promise<SnapshotResult> {
  const raw = await fetchAxTree(handle.cdp);
  const root = buildTree(raw);
  if (!root) throw new Error("a11y 树为空，页面可能尚未加载");

  const pruned = prune(raw, root.nodeId);
  if (!pruned) throw new Error("裁剪后无可用节点");

  const collapsed = collapse(pruned, { threshold: opts.threshold, expand: opts.expand });
  const { text, refs } = render(collapsed);

  let prunedCount = 0;
  let groupCount = 0;
  const count = (n: unknown): void => {
    const node = n as { kind?: string; children?: unknown[] };
    if (node.kind === "collapsed-group") { groupCount++; return; }
    prunedCount++;
    for (const c of node.children ?? []) count(c);
  };
  for (const c of collapsed.children) count(c);

  return { text, refs, stats: { rawNodes: raw.length, prunedNodes: prunedCount, collapsedGroups: groupCount } };
}
```

- [ ] **Step 6: 实现 `src/server.ts` 与 `src/index.ts`**

`src/server.ts`：

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrowserSession } from "./session/browser.js";
import { takeSnapshot } from "./perception/snapshot.js";

/** 最近一次 snapshot 的 ref 表，按 pageId 保存，供 batch 用 ref 指代元素 */
export const refTables = new Map<string, Map<string, number>>();

export function createServer(session: BrowserSession): McpServer {
  const server = new McpServer({ name: "computer-use-quick", version: "0.1.0" });

  server.registerTool(
    "snapshot",
    {
      description:
        "返回当前页面的精简可交互元素快照（替代截图）。结构相同的兄弟节点会被折叠，" +
        "用 expand 传入折叠组 id 可展开查看完整细节。",
      inputSchema: {
        pageId: z.string().optional().describe("目标页面 id，省略则用当前选中页"),
        expand: z.array(z.string()).optional().describe("要展开的折叠组 id 列表"),
        threshold: z.number().int().min(2).optional().describe("折叠阈值，默认 3")
      }
    },
    async ({ pageId, expand, threshold }) => {
      const handle = await session.getPage(pageId);
      const snap = await takeSnapshot(handle, { expand, threshold });
      refTables.set(handle.pageId, snap.refs);
      return {
        content: [{
          type: "text" as const,
          text: `# 页面快照 (${handle.pageId})\n` +
                `节点 ${snap.stats.rawNodes} → ${snap.stats.prunedNodes}，折叠组 ${snap.stats.collapsedGroups}\n\n` +
                snap.text
        }]
      };
    }
  );

  return server;
}
```

`src/index.ts`：

```ts
#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BrowserSession } from "./session/browser.js";
import { createServer } from "./server.js";

const browserURL = process.env.CUQ_BROWSER_URL ?? "http://127.0.0.1:9222";

const session = await BrowserSession.connect(browserURL);
const server = createServer(session);
await server.connect(new StdioServerTransport());

process.on("SIGINT", async () => { await session.close(); process.exit(0); });
```

- [ ] **Step 7: 写 snapshot 集成测试**

创建 `test/integration/snapshot.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import puppeteer, { type Browser } from "puppeteer";
import { BrowserSession } from "../../src/session/browser.js";
import { startFixtureServer } from "../fixtures/server.js";
import { takeSnapshot } from "../../src/perception/snapshot.js";

let chrome: Browser, session: BrowserSession, fx: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  fx = await startFixtureServer();
  chrome = await puppeteer.launch({ headless: true, args: ["--remote-debugging-port=9335", "--no-sandbox"] });
  session = await BrowserSession.connect("http://127.0.0.1:9335");
});
afterAll(async () => { await session?.close(); await chrome?.close(); await fx?.close(); });

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
```

- [ ] **Step 8: 运行全部测试确认通过**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 单测与集成测试全绿，TS 无类型错误

- [ ] **Step 9: 提交（M1 达成）**

```bash
git add src/perception/render.ts src/perception/snapshot.ts src/server.ts src/index.ts \
        test/unit/render.test.ts test/integration/snapshot.test.ts
git commit -m "feat: 快照渲染与 snapshot 工具，M1 感知层达成"
```

---

# M2 · 执行

### Task 8: DOM 容器锚点求解

**Files:**
- Create: `src/locator/container.ts`
- Test: `test/integration/container.test.ts`

**Interfaces:**
- Consumes: `PageHandle`（Task 2）
- Produces:
  - `async function findAnchor(handle: PageHandle, backendNodeId: number): Promise<AnchorInfo | null>`
  - `interface AnchorInfo { kind: "row" | "container"; anchorText: string; distinguishers: string[] }`
  - `async function markAncestors(handle: PageHandle, anchorText: string): Promise<number>` —— 给锚文本元素的祖先链打 `data-cuq-anchor="N"` 临时属性，返回层数
  - `async function clearMarks(handle: PageHandle): Promise<void>` —— 清理临时属性

**这是 spec §6.3 的核心实现。** 靶场的 a11y 树里没有卡片容器，所以容器边界必须从 DOM 求：从目标元素向上找最近的、包含全页唯一文本的祖先。

> **临时属性必须清理。** `data-cuq-anchor` 残留会污染页面、影响后续快照与断言。所有使用 `markAncestors` 的代码路径必须在 `finally` 里调 `clearMarks`。

- [ ] **Step 1: 写失败的集成测试**

创建 `test/integration/container.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import puppeteer, { type Browser } from "puppeteer";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { startFixtureServer } from "../fixtures/server.js";
import { takeSnapshot } from "../../src/perception/snapshot.js";
import { findAnchor, markAncestors, clearMarks } from "../../src/locator/container.js";

let chrome: Browser, session: BrowserSession, fx: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  fx = await startFixtureServer();
  chrome = await puppeteer.launch({ headless: true, args: ["--remote-debugging-port=9336", "--no-sandbox"] });
  session = await BrowserSession.connect("http://127.0.0.1:9336");
});
afterAll(async () => { await session?.close(); await chrome?.close(); await fx?.close(); });

async function open(path: string): Promise<PageHandle> {
  const h = await session.getPage();
  await h.page.goto(`${fx.url}/${path}`, { waitUntil: "load" });
  return h;
}

/** 从快照里按 ref 顺序取第 n 个匹配 name 的元素的 backendNodeId */
async function nodeIdOf(h: PageHandle, name: string, nth = 0): Promise<number> {
  const snap = await takeSnapshot(h, { threshold: 99 });
  const lines = snap.text.split("\n").filter((l) => l.includes(`"${name}"`));
  const ref = lines[nth].match(/\[(e\d+)\]/)![1];
  return snap.refs.get(ref)!;
}

describe("findAnchor", () => {
  it("卡片墙里的同名按钮，能找到所属卡片的唯一锚文本", async () => {
    const h = await open("cards-no-container.html");
    const first = await findAnchor(h, await nodeIdOf(h, "查看在岗干部明细", 0));
    const second = await findAnchor(h, await nodeIdOf(h, "查看在岗干部明细", 1));
    expect(first?.anchorText).toBe("教育事业群");
    expect(second?.anchorText).toBe("技术平台中心");
    expect(first?.kind).toBe("container");
  });

  it("表格里的同名按钮，锚点识别为 row 且锚文本是单号", async () => {
    const h = await open("table-dup.html");
    const a = await findAnchor(h, await nodeIdOf(h, "删除", 1));
    expect(a?.kind).toBe("row");
    expect(a?.anchorText).toBe("ORD20260912");
  });

  it("收集容器内的区别性内容", async () => {
    const h = await open("cards-no-container.html");
    const a = await findAnchor(h, await nodeIdOf(h, "查看在岗干部明细", 0));
    expect(a?.distinguishers.join(" ")).toContain("5081");
  });

  it("全页唯一的元素（表单提交按钮）返回 null，无需容器锚定", async () => {
    const h = await open("form.html");
    expect(await findAnchor(h, await nodeIdOf(h, "登录"))).toBeNull();
  });

  it("markAncestors 打标记，clearMarks 清干净", async () => {
    const h = await open("cards-no-container.html");
    const levels = await markAncestors(h, "教育事业群");
    expect(levels).toBeGreaterThan(0);

    const marked = await h.cdp.send("Runtime.evaluate", {
      expression: `document.querySelectorAll('[data-cuq-anchor]').length`,
      returnByValue: true
    });
    expect((marked.result as { value: number }).value).toBe(levels);

    await clearMarks(h);
    const after = await h.cdp.send("Runtime.evaluate", {
      expression: `document.querySelectorAll('[data-cuq-anchor]').length`,
      returnByValue: true
    });
    expect((after.result as { value: number }).value).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/integration/container.test.ts`
Expected: FAIL —— 无法解析 `src/locator/container.js`

- [ ] **Step 3: 实现 `src/locator/container.ts`**

```ts
import type { PageHandle } from "../session/browser.js";

export interface AnchorInfo {
  kind: "row" | "container";
  anchorText: string;
  distinguishers: string[];
}

/** 在浏览器里对目标元素求锚点。函数体以 this === 目标元素 的方式调用。 */
const FIND_ANCHOR_FN = `function () {
  var el = this;
  var bodyText = document.body.innerText || "";
  function countOf(s) {
    var n = 0, i = 0;
    while ((i = bodyText.indexOf(s, i)) !== -1) { n++; i += s.length; }
    return n;
  }
  function leafTexts(root) {
    var out = [];
    var all = root.querySelectorAll("*");
    for (var k = 0; k < all.length; k++) {
      var e = all[k];
      if (e.children.length !== 0) continue;
      var t = (e.textContent || "").trim();
      if (t.length >= 2 && t.length <= 60) out.push(t);
    }
    return out;
  }
  var cur = el.parentElement, depth = 0;
  while (cur && cur !== document.body && depth < 12) {
    var texts = leafTexts(cur);
    var unique = null;
    for (var i = 0; i < texts.length; i++) {
      if (countOf(texts[i]) === 1) { unique = texts[i]; break; }
    }
    if (unique) {
      return {
        kind: cur.tagName === "TR" ? "row" : "container",
        anchorText: unique,
        distinguishers: texts.filter(function (t) { return t !== unique; }).slice(0, 5)
      };
    }
    cur = cur.parentElement;
    depth++;
  }
  return null;
}`;

async function objectIdOf(handle: PageHandle, backendNodeId: number): Promise<string> {
  const { object } = (await handle.cdp.send("DOM.resolveNode", { backendNodeId })) as {
    object: { objectId: string };
  };
  return object.objectId;
}

export async function findAnchor(
  handle: PageHandle,
  backendNodeId: number
): Promise<AnchorInfo | null> {
  const objectId = await objectIdOf(handle, backendNodeId);
  const { result } = (await handle.cdp.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: FIND_ANCHOR_FN,
    returnByValue: true
  })) as { result: { value: AnchorInfo | null } };
  await handle.cdp.send("Runtime.releaseObject", { objectId }).catch(() => {});
  return result.value;
}

export async function markAncestors(handle: PageHandle, anchorText: string): Promise<number> {
  const expression = `(function (anchorText) {
    var all = document.querySelectorAll("*"), leaf = null;
    for (var i = 0; i < all.length; i++) {
      if (all[i].children.length === 0 && (all[i].textContent || "").trim() === anchorText) {
        leaf = all[i]; break;
      }
    }
    if (!leaf) return 0;
    var cur = leaf.parentElement, n = 0;
    while (cur && cur !== document.body && n < 10) {
      cur.setAttribute("data-cuq-anchor", String(n));
      cur = cur.parentElement; n++;
    }
    return n;
  })(${JSON.stringify(anchorText)})`;

  const { result } = (await handle.cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true
  })) as { result: { value: number } };
  return result.value;
}

export async function clearMarks(handle: PageHandle): Promise<void> {
  await handle.cdp.send("Runtime.evaluate", {
    expression: `document.querySelectorAll('[data-cuq-anchor]')
      .forEach(function (e) { e.removeAttribute('data-cuq-anchor'); })`,
    returnByValue: true
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/integration/container.test.ts`
Expected: PASS，5 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add src/locator/container.ts test/integration/container.test.ts
git commit -m "feat: DOM 容器锚点求解，支持无 a11y 容器的卡片墙与表格行"
```

---

### Task 9: descriptor 生成

**Files:**
- Create: `src/locator/descriptor.ts`
- Test: `test/integration/descriptor.test.ts`

**Interfaces:**
- Consumes: `findAnchor`（Task 8）、`Descriptor`/`Strategy`（Task 1）
- Produces: `async function buildDescriptor(handle: PageHandle, backendNodeId: number): Promise<Descriptor>`

**懒计算（spec §6.5）**：只在元素被操作时调用，不在快照时给全页元素批量算。

- [ ] **Step 1: 写失败的集成测试**

创建 `test/integration/descriptor.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import puppeteer, { type Browser } from "puppeteer";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { startFixtureServer } from "../fixtures/server.js";
import { takeSnapshot } from "../../src/perception/snapshot.js";
import { buildDescriptor } from "../../src/locator/descriptor.js";

let chrome: Browser, session: BrowserSession, fx: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  fx = await startFixtureServer();
  chrome = await puppeteer.launch({ headless: true, args: ["--remote-debugging-port=9337", "--no-sandbox"] });
  session = await BrowserSession.connect("http://127.0.0.1:9337");
});
afterAll(async () => { await session?.close(); await chrome?.close(); await fx?.close(); });

async function open(path: string): Promise<PageHandle> {
  const h = await session.getPage();
  await h.page.goto(`${fx.url}/${path}`, { waitUntil: "load" });
  return h;
}

async function nodeIdOf(h: PageHandle, name: string, nth = 0): Promise<number> {
  const snap = await takeSnapshot(h, { threshold: 99 });
  const lines = snap.text.split("\n").filter((l) => l.includes(`"${name}"`));
  const ref = lines[nth].match(/\[(e\d+)\]/)![1];
  return snap.refs.get(ref)!;
}

describe("buildDescriptor", () => {
  it("全页唯一元素：第一条策略是 role-name", async () => {
    const h = await open("form.html");
    const d = await buildDescriptor(h, await nodeIdOf(h, "登录"));
    expect(d.strategies[0].kind).toBe("role-name");
    expect(d.strategies[0]).toMatchObject({ role: "button", name: "登录" });
  });

  it("卡片墙同名按钮：第一条策略是 container-role-name，带正确锚文本", async () => {
    const h = await open("cards-no-container.html");
    const d = await buildDescriptor(h, await nodeIdOf(h, "查看在岗干部明细", 1));
    expect(d.strategies[0].kind).toBe("container-role-name");
    expect(d.strategies[0]).toMatchObject({ containerText: "技术平台中心" });
  });

  it("表格同名按钮：第一条策略是 row-role-name", async () => {
    const h = await open("table-dup.html");
    const d = await buildDescriptor(h, await nodeIdOf(h, "删除", 2));
    expect(d.strategies[0].kind).toBe("row-role-name");
    expect(d.strategies[0]).toMatchObject({ rowText: "ORD20260913" });
  });

  it("策略链总是以 css 和 xpath 兜底收尾", async () => {
    const h = await open("form.html");
    const kinds = (await buildDescriptor(h, await nodeIdOf(h, "登录"))).strategies.map((s) => s.kind);
    expect(kinds).toContain("css");
    expect(kinds[kinds.length - 1]).toBe("xpath");
  });

  it("有 id 的元素，css 策略用 #id", async () => {
    const h = await open("form.html");
    const d = await buildDescriptor(h, await nodeIdOf(h, "登录"));
    const css = d.strategies.find((s) => s.kind === "css") as { value: string };
    expect(css.value).toBe("#submit");
  });

  it("记录 distinguishers 供同名兜底消歧", async () => {
    const h = await open("cards-no-container.html");
    const d = await buildDescriptor(h, await nodeIdOf(h, "查看在岗干部明细", 0));
    expect(d.distinguishers!.join(" ")).toContain("5081");
  });

  it("生成的 descriptor 不含任何临时标记属性残留", async () => {
    const h = await open("cards-no-container.html");
    await buildDescriptor(h, await nodeIdOf(h, "查看在岗干部明细", 0));
    const { result } = await h.cdp.send("Runtime.evaluate", {
      expression: `document.querySelectorAll('[data-cuq-anchor]').length`,
      returnByValue: true
    });
    expect((result as { value: number }).value).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/integration/descriptor.test.ts`
Expected: FAIL —— 无法解析 `src/locator/descriptor.js`

- [ ] **Step 3: 实现 `src/locator/descriptor.ts`**

```ts
import type { PageHandle } from "../session/browser.js";
import type { Descriptor, Strategy } from "../types.js";
import { findAnchor } from "./container.js";

interface DomInfo {
  tag: string;
  id: string;
  testId: string;
  classes: string[];
  text: string;
  xpath: string;
}

const DOM_INFO_FN = `function () {
  var el = this;
  function isStableClass(c) {
    // 过滤掉 CSS-in-JS / 构建期生成的随机类名（含连续数字或看起来像 hash）
    return c.length > 1 && !/\\d{3,}/.test(c) && !/^[a-z]+-[a-z0-9]{5,}$/i.test(c);
  }
  function xpathOf(node) {
    if (node.id) return '//*[@id="' + node.id + '"]';
    var parts = [], cur = node;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      var i = 1, sib = cur.previousElementSibling;
      while (sib) { if (sib.tagName === cur.tagName) i++; sib = sib.previousElementSibling; }
      parts.unshift(cur.tagName.toLowerCase() + "[" + i + "]");
      cur = cur.parentElement;
    }
    return "/html/" + parts.join("/");
  }
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || "",
    testId: el.getAttribute("data-testid") || el.getAttribute("data-test")
         || el.getAttribute("data-qa") || "",
    classes: Array.prototype.slice.call(el.classList).filter(isStableClass),
    text: (el.textContent || "").trim().slice(0, 60),
    xpath: xpathOf(el)
  };
}`;

async function domInfo(handle: PageHandle, backendNodeId: number): Promise<DomInfo> {
  const { object } = (await handle.cdp.send("DOM.resolveNode", { backendNodeId })) as {
    object: { objectId: string };
  };
  const { result } = (await handle.cdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: DOM_INFO_FN,
    returnByValue: true
  })) as { result: { value: DomInfo } };
  await handle.cdp.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
  return result.value;
}

/** 用 CDP 取元素的 a11y role 与 name */
async function axOf(
  handle: PageHandle,
  backendNodeId: number
): Promise<{ role: string; name: string }> {
  const { nodes } = (await handle.cdp.send("Accessibility.getPartialAXTree", {
    backendNodeId,
    fetchRelatives: false
  })) as { nodes: Array<{ role?: { value?: string }; name?: { value?: string } }> };
  const n = nodes[0];
  return { role: n?.role?.value ?? "", name: (n?.name?.value ?? "").trim() };
}

function cssOf(info: DomInfo): string {
  if (info.id) return `#${info.id}`;
  if (info.classes.length) return `${info.tag}.${info.classes.join(".")}`;
  return info.tag;
}

export async function buildDescriptor(
  handle: PageHandle,
  backendNodeId: number
): Promise<Descriptor> {
  const [info, ax, anchor] = await Promise.all([
    domInfo(handle, backendNodeId),
    axOf(handle, backendNodeId),
    findAnchor(handle, backendNodeId)
  ]);

  const strategies: Strategy[] = [];

  if (info.testId) strategies.push({ kind: "test-id", value: info.testId });

  if (anchor && ax.role && ax.name) {
    strategies.push(
      anchor.kind === "row"
        ? { kind: "row-role-name", rowText: anchor.anchorText, role: ax.role, name: ax.name }
        : { kind: "container-role-name", containerText: anchor.anchorText, role: ax.role, name: ax.name }
    );
  }

  if (ax.role && ax.name) strategies.push({ kind: "role-name", role: ax.role, name: ax.name });
  if (info.text) strategies.push({ kind: "text", tag: info.tag, text: info.text });
  strategies.push({ kind: "css", value: cssOf(info) });
  strategies.push({ kind: "xpath", value: info.xpath });

  return { strategies, framePath: [], distinguishers: anchor?.distinguishers };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/integration/descriptor.test.ts`
Expected: PASS，7 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add src/locator/descriptor.ts test/integration/descriptor.test.ts
git commit -m "feat: descriptor 懒生成，容器/行锚定优先于全页 role+name"
```

---

### Task 10: 多策略解析与漂移判定

**Files:**
- Create: `src/locator/resolve.ts`
- Test: `test/integration/resolve.test.ts`

**Interfaces:**
- Consumes: `markAncestors`/`clearMarks`（Task 8）、`Descriptor`/`ResolveResult`（Task 1）
- Produces:
  - `async function resolve(handle: PageHandle, d: Descriptor): Promise<ResolveResult>` —— 全策略失败时 throw `LocatorError`
  - `class LocatorError extends Error { kind: "target-not-found" | "ambiguous"; candidates: string[] }`
  - `async function resolveTarget(handle: PageHandle, target: TargetRef, refs: Map<string, number>): Promise<ResolveResult>` —— `{ref}` 直接查表；`{descriptor}` 走 `resolve`

- [ ] **Step 1: 写失败的集成测试**

创建 `test/integration/resolve.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import puppeteer, { type Browser } from "puppeteer";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { startFixtureServer } from "../fixtures/server.js";
import { takeSnapshot } from "../../src/perception/snapshot.js";
import { buildDescriptor } from "../../src/locator/descriptor.js";
import { resolve, LocatorError } from "../../src/locator/resolve.js";

let chrome: Browser, session: BrowserSession, fx: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  fx = await startFixtureServer();
  chrome = await puppeteer.launch({ headless: true, args: ["--remote-debugging-port=9338", "--no-sandbox"] });
  session = await BrowserSession.connect("http://127.0.0.1:9338");
});
afterAll(async () => { await session?.close(); await chrome?.close(); await fx?.close(); });

async function open(path: string): Promise<PageHandle> {
  const h = await session.getPage();
  await h.page.goto(`${fx.url}/${path}`, { waitUntil: "load" });
  return h;
}

async function nodeIdOf(h: PageHandle, name: string, nth = 0): Promise<number> {
  const snap = await takeSnapshot(h, { threshold: 99 });
  const lines = snap.text.split("\n").filter((l) => l.includes(`"${name}"`));
  const ref = lines[nth].match(/\[(e\d+)\]/)![1];
  return snap.refs.get(ref)!;
}

describe("resolve", () => {
  it("往返一致：build 出的 descriptor 能解析回同一个节点", async () => {
    const h = await open("form.html");
    const original = await nodeIdOf(h, "登录");
    const r = await resolve(h, await buildDescriptor(h, original));
    expect(r.backendNodeId).toBe(original);
    expect(r.strategyIndex).toBe(0);
  });

  it("卡片墙第 2 个同名按钮能被容器锚定精确解析", async () => {
    const h = await open("cards-no-container.html");
    const original = await nodeIdOf(h, "查看在岗干部明细", 1);
    const r = await resolve(h, await buildDescriptor(h, original));
    expect(r.backendNodeId).toBe(original);
    expect(r.strategyKind).toBe("container-role-name");
  });

  it("表格第 3 行的删除按钮能被行锚定精确解析", async () => {
    const h = await open("table-dup.html");
    const original = await nodeIdOf(h, "删除", 2);
    const r = await resolve(h, await buildDescriptor(h, original));
    expect(r.backendNodeId).toBe(original);
    expect(r.strategyKind).toBe("row-role-name");
  });

  it("首选策略失效时回退到后续策略，strategyIndex 反映漂移", async () => {
    const h = await open("form.html");
    const d = await buildDescriptor(h, await nodeIdOf(h, "登录"));
    // 人为把第一条策略改成永远找不到的
    d.strategies.unshift({ kind: "role-name", role: "button", name: "并不存在的按钮" });
    const r = await resolve(h, d);
    expect(r.strategyIndex).toBeGreaterThan(0);
  });

  it("全部策略失效时抛 LocatorError(target-not-found)", async () => {
    const h = await open("form.html");
    await expect(
      resolve(h, { strategies: [{ kind: "css", value: "#nope-nope" }], framePath: [] })
    ).rejects.toMatchObject({ kind: "target-not-found" });
  });

  it("策略命中多个时跳到下一策略而非报错", async () => {
    const h = await open("cards-no-container.html");
    const d = {
      strategies: [
        { kind: "role-name", role: "button", name: "查看在岗干部明细" } as const, // 命中 3 个
        { kind: "css", value: "#clicked" } as const                                // 唯一
      ],
      framePath: []
    };
    const r = await resolve(h, d);
    expect(r.strategyIndex).toBe(1);
  });

  it("解析后页面上不残留临时标记属性", async () => {
    const h = await open("cards-no-container.html");
    await resolve(h, await buildDescriptor(h, await nodeIdOf(h, "查看在岗干部明细", 0)));
    const { result } = await h.cdp.send("Runtime.evaluate", {
      expression: `document.querySelectorAll('[data-cuq-anchor]').length`,
      returnByValue: true
    });
    expect((result as { value: number }).value).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/integration/resolve.test.ts`
Expected: FAIL —— 无法解析 `src/locator/resolve.js`

- [ ] **Step 3: 实现 `src/locator/resolve.ts`**

```ts
import type { PageHandle } from "../session/browser.js";
import type { Descriptor, ResolveResult, Strategy, TargetRef } from "../types.js";
import { markAncestors, clearMarks } from "./container.js";

export class LocatorError extends Error {
  constructor(
    message: string,
    public kind: "target-not-found" | "ambiguous",
    public candidates: string[] = []
  ) {
    super(message);
    this.name = "LocatorError";
  }
}

async function documentNodeId(handle: PageHandle): Promise<number> {
  const { root } = (await handle.cdp.send("DOM.getDocument", { depth: 0 })) as {
    root: { nodeId: number };
  };
  return root.nodeId;
}

async function backendIdOfNodeId(handle: PageHandle, nodeId: number): Promise<number> {
  const { node } = (await handle.cdp.send("DOM.describeNode", { nodeId })) as {
    node: { backendNodeId: number };
  };
  return node.backendNodeId;
}

/** 用 CSS 选择器找唯一元素，返回 backendNodeId；找不到或非唯一返回 null */
async function bySelector(handle: PageHandle, selector: string): Promise<number | null> {
  const doc = await documentNodeId(handle);
  const { nodeIds } = (await handle.cdp.send("DOM.querySelectorAll", {
    nodeId: doc,
    selector
  })) as { nodeIds: number[] };
  if (nodeIds.length !== 1) return null;
  return backendIdOfNodeId(handle, nodeIds[0]);
}

/** 在指定子树内按 role + accessibleName 查询，返回唯一命中的 backendNodeId */
async function byAx(
  handle: PageHandle,
  scopeNodeId: number,
  role: string,
  name: string
): Promise<{ id: number | null; count: number }> {
  const { nodes } = (await handle.cdp.send("Accessibility.queryAXTree", {
    nodeId: scopeNodeId,
    accessibleName: name,
    role
  })) as { nodes: Array<{ backendDOMNodeId?: number; ignored?: boolean }> };
  const hits = nodes.filter((n) => !n.ignored && n.backendDOMNodeId !== undefined);
  return { id: hits.length === 1 ? hits[0].backendDOMNodeId! : null, count: hits.length };
}

/** 锚定策略：给锚文本祖先链打标记，由内向外逐层用 AX 查询，第一个唯一命中的层胜出 */
async function byAnchor(
  handle: PageHandle,
  anchorText: string,
  role: string,
  name: string
): Promise<number | null> {
  const levels = await markAncestors(handle, anchorText);
  try {
    const doc = await documentNodeId(handle);
    for (let i = 0; i < levels; i++) {
      const { nodeIds } = (await handle.cdp.send("DOM.querySelectorAll", {
        nodeId: doc,
        selector: `[data-cuq-anchor="${i}"]`
      })) as { nodeIds: number[] };
      if (nodeIds.length !== 1) continue;
      const hit = await byAx(handle, nodeIds[0], role, name);
      if (hit.id !== null) return hit.id;
    }
    return null;
  } finally {
    await clearMarks(handle);
  }
}

async function tryStrategy(handle: PageHandle, s: Strategy): Promise<number | null> {
  switch (s.kind) {
    case "test-id":
      return bySelector(handle, `[data-testid="${s.value}"],[data-test="${s.value}"],[data-qa="${s.value}"]`);
    case "container-role-name":
      return byAnchor(handle, s.containerText, s.role, s.name);
    case "row-role-name":
      return byAnchor(handle, s.rowText, s.role, s.name);
    case "role-name": {
      const doc = await documentNodeId(handle);
      return (await byAx(handle, doc, s.role, s.name)).id;
    }
    case "text": {
      const doc = await documentNodeId(handle);
      const { nodeIds } = (await handle.cdp.send("DOM.querySelectorAll", {
        nodeId: doc,
        selector: s.tag
      })) as { nodeIds: number[] };
      const matches: number[] = [];
      for (const nodeId of nodeIds) {
        const { object } = (await handle.cdp.send("DOM.resolveNode", { nodeId })) as {
          object: { objectId: string };
        };
        const { result } = (await handle.cdp.send("Runtime.callFunctionOn", {
          objectId: object.objectId,
          functionDeclaration: `function () { return (this.textContent || "").trim(); }`,
          returnByValue: true
        })) as { result: { value: string } };
        await handle.cdp.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
        if (result.value === s.text) matches.push(nodeId);
      }
      return matches.length === 1 ? backendIdOfNodeId(handle, matches[0]) : null;
    }
    case "css":
      return bySelector(handle, s.value);
    case "xpath": {
      // performSearch 需要文档已完整加载到 DOM 域
      await handle.cdp.send("DOM.getDocument", { depth: -1 });
      const { searchId, resultCount } = (await handle.cdp.send("DOM.performSearch", {
        query: s.value
      })) as { searchId: string; resultCount: number };
      if (resultCount !== 1) {
        await handle.cdp.send("DOM.discardSearchResults", { searchId }).catch(() => {});
        return null;
      }
      const { nodeIds } = (await handle.cdp.send("DOM.getSearchResults", {
        searchId, fromIndex: 0, toIndex: 1
      })) as { nodeIds: number[] };
      await handle.cdp.send("DOM.discardSearchResults", { searchId }).catch(() => {});
      return nodeIds.length === 1 ? backendIdOfNodeId(handle, nodeIds[0]) : null;
    }
  }
}

export async function resolve(handle: PageHandle, d: Descriptor): Promise<ResolveResult> {
  const tried: string[] = [];
  for (let i = 0; i < d.strategies.length; i++) {
    const s = d.strategies[i];
    let id: number | null = null;
    try {
      id = await tryStrategy(handle, s);
    } catch {
      id = null;
    }
    if (id !== null) return { backendNodeId: id, strategyIndex: i, strategyKind: s.kind };
    tried.push(s.kind);
  }
  throw new LocatorError(`全部 ${d.strategies.length} 条策略均未唯一命中：${tried.join(" → ")}`, "target-not-found", d.distinguishers ?? []);
}

export async function resolveTarget(
  handle: PageHandle,
  target: TargetRef,
  refs: Map<string, number>
): Promise<ResolveResult> {
  if ("ref" in target) {
    const id = refs.get(target.ref);
    if (id === undefined) {
      throw new LocatorError(`ref ${target.ref} 不在当前快照中，请重新 snapshot`, "target-not-found");
    }
    return { backendNodeId: id, strategyIndex: -1, strategyKind: "css" };
  }
  return resolve(handle, target.descriptor);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/integration/resolve.test.ts`
Expected: PASS，7 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add src/locator/resolve.ts test/integration/resolve.test.ts
git commit -m "feat: 多策略解析与漂移判定，锚定策略由内向外逐层收敛"
```

---

### Task 11: 诊断采集器与 `inspect` 工具

**Files:**
- Create: `src/diagnostics/collector.ts`
- Modify: `src/server.ts`（注册 `inspect` 工具）
- Test: `test/integration/diagnostics.test.ts`

**Interfaces:**
- Consumes: `PageHandle`（Task 2）
- Produces:
  - `class DiagnosticsCollector`
  - `static async attach(handle: PageHandle): Promise<DiagnosticsCollector>`
  - `consoleErrors(): string[]` / `failedRequests(): string[]` —— 各返回最近 20 条
  - `async screenshot(): Promise<string>` —— base64 png
  - `clear(): void`

**为什么与 `inspect` 同一个任务**：batch 的失败上下文（spec §7.4）和 `inspect` 工具采集的是同一份数据，共用一个采集器。分成两个任务会让同一份代码被写两次。

- [ ] **Step 1: 写失败的集成测试**

创建 `test/integration/diagnostics.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import puppeteer, { type Browser } from "puppeteer";
import { BrowserSession } from "../../src/session/browser.js";
import { startFixtureServer } from "../fixtures/server.js";
import { DiagnosticsCollector } from "../../src/diagnostics/collector.js";

let chrome: Browser, session: BrowserSession, fx: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  fx = await startFixtureServer();
  chrome = await puppeteer.launch({ headless: true, args: ["--remote-debugging-port=9339", "--no-sandbox"] });
  session = await BrowserSession.connect("http://127.0.0.1:9339");
});
afterAll(async () => { await session?.close(); await chrome?.close(); await fx?.close(); });

describe("DiagnosticsCollector", () => {
  it("采集 console.error", async () => {
    const h = await session.getPage();
    const c = await DiagnosticsCollector.attach(h);
    await h.page.goto(`${fx.url}/form.html`, { waitUntil: "load" });
    await h.cdp.send("Runtime.evaluate", { expression: `console.error("测试用报错")` });
    await new Promise((r) => setTimeout(r, 300));
    expect(c.consoleErrors().join("\n")).toContain("测试用报错");
  });

  it("采集 4xx 请求", async () => {
    const h = await session.getPage();
    const c = await DiagnosticsCollector.attach(h);
    await h.page.goto(`${fx.url}/form.html`, { waitUntil: "load" });
    await h.cdp.send("Runtime.evaluate", {
      expression: `fetch("${fx.url}/nope.html").catch(function () {})`,
      awaitPromise: false
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(c.failedRequests().join("\n")).toContain("nope.html");
  });

  it("只保留最近 20 条", async () => {
    const h = await session.getPage();
    const c = await DiagnosticsCollector.attach(h);
    await h.page.goto(`${fx.url}/form.html`, { waitUntil: "load" });
    await h.cdp.send("Runtime.evaluate", {
      expression: `for (var i = 0; i < 30; i++) console.error("err" + i)`
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(c.consoleErrors().length).toBe(20);
    expect(c.consoleErrors().join("\n")).toContain("err29");
  });

  it("截图返回非空 base64", async () => {
    const h = await session.getPage();
    const c = await DiagnosticsCollector.attach(h);
    await h.page.goto(`${fx.url}/form.html`, { waitUntil: "load" });
    expect((await c.screenshot()).length).toBeGreaterThan(1000);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/integration/diagnostics.test.ts`
Expected: FAIL —— 无法解析 `src/diagnostics/collector.js`

- [ ] **Step 3: 实现 `src/diagnostics/collector.ts`**

```ts
import type { PageHandle } from "../session/browser.js";

const MAX = 20;

function push(buf: string[], item: string): void {
  buf.push(item);
  if (buf.length > MAX) buf.shift();
}

export class DiagnosticsCollector {
  private consoleBuf: string[] = [];
  private networkBuf: string[] = [];

  private constructor(private handle: PageHandle) {}

  static async attach(handle: PageHandle): Promise<DiagnosticsCollector> {
    const c = new DiagnosticsCollector(handle);
    await handle.cdp.send("Network.enable");
    await handle.cdp.send("Log.enable");

    handle.cdp.on("Runtime.consoleAPICalled", (e: {
      type: string;
      args: Array<{ value?: unknown; description?: string }>;
    }) => {
      if (e.type !== "error" && e.type !== "assert") return;
      const text = e.args.map((a) => String(a.value ?? a.description ?? "")).join(" ");
      push(c.consoleBuf, text);
    });

    handle.cdp.on("Log.entryAdded", (e: { entry: { level: string; text: string } }) => {
      if (e.entry.level === "error") push(c.consoleBuf, e.entry.text);
    });

    handle.cdp.on("Network.responseReceived", (e: {
      response: { status: number; url: string };
    }) => {
      if (e.response.status >= 400) push(c.networkBuf, `${e.response.status} ${e.response.url}`);
    });

    handle.cdp.on("Network.loadingFailed", (e: { errorText: string; requestId: string }) => {
      push(c.networkBuf, `FAILED ${e.errorText} (req ${e.requestId})`);
    });

    return c;
  }

  consoleErrors(): string[] { return [...this.consoleBuf]; }
  failedRequests(): string[] { return [...this.networkBuf]; }
  clear(): void { this.consoleBuf = []; this.networkBuf = []; }

  async screenshot(): Promise<string> {
    const { data } = (await this.handle.cdp.send("Page.captureScreenshot", {
      format: "png"
    })) as { data: string };
    return data;
  }
}
```

> `Network.loadingFailed` 事件不带 url，只带 requestId。一期接受这个精度损失——`responseReceived` 已覆盖绝大多数失败场景（4xx/5xx）；`loadingFailed` 主要是网络层中断，有 requestId 足够定位。

- [ ] **Step 4: 在 `src/server.ts` 注册 `inspect` 工具**

在 `createServer` 里、`return server` 之前加：

```ts
  server.registerTool(
    "inspect",
    {
      description: "取当前页面的诊断信息：截图、console 报错、失败网络请求。只在排查失败时调用。",
      inputSchema: {
        pageId: z.string().optional(),
        withScreenshot: z.boolean().optional().describe("是否附带截图，默认 true")
      }
    },
    async ({ pageId, withScreenshot = true }) => {
      const handle = await session.getPage(pageId);
      const c = collectorFor(handle.pageId) ?? (await attachCollector(handle));
      const parts: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
        { type: "text", text:
          `## console 报错（最近 ${c.consoleErrors().length} 条）\n${c.consoleErrors().join("\n") || "（无）"}\n\n` +
          `## 失败请求（最近 ${c.failedRequests().length} 条）\n${c.failedRequests().join("\n") || "（无）"}` }
      ];
      if (withScreenshot) {
        parts.push({ type: "image", data: await c.screenshot(), mimeType: "image/png" });
      }
      return { content: parts };
    }
  );
```

并在 `src/server.ts` 顶部加采集器注册表（放在 `refTables` 旁边）：

```ts
import { DiagnosticsCollector } from "./diagnostics/collector.js";
import type { PageHandle } from "./session/browser.js";

const collectors = new Map<string, DiagnosticsCollector>();

export function collectorFor(pageId: string): DiagnosticsCollector | undefined {
  return collectors.get(pageId);
}

export async function attachCollector(handle: PageHandle): Promise<DiagnosticsCollector> {
  const existing = collectors.get(handle.pageId);
  if (existing) return existing;
  const c = await DiagnosticsCollector.attach(handle);
  collectors.set(handle.pageId, c);
  return c;
}
```

同时在 `snapshot` 工具的处理函数开头补一行 `await attachCollector(handle);`，保证采集器尽早挂上——否则第一次失败时拿不到之前的 console 报错。

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run test/integration/diagnostics.test.ts && npx tsc --noEmit`
Expected: PASS，4 个用例全绿，无类型错误

- [ ] **Step 6: 提交**

```bash
git add src/diagnostics/collector.ts src/server.ts test/integration/diagnostics.test.ts
git commit -m "feat: 诊断采集器与 inspect 工具，供失败上下文与排查共用"
```

---

### Task 12: 等待器

**Files:**
- Create: `src/waiter/stability.ts`
- Create: `src/waiter/explicit.ts`
- Test: `test/integration/waiter.test.ts`

**Interfaces:**
- Consumes: `PageHandle`（Task 2）、`resolveTarget`（Task 10）、`WaitCondition`（Task 1）
- Produces:
  - `class NetworkTracker { static async attach(handle): Promise<NetworkTracker>; inFlight(): number; lastChangeAt(): number }`
  - `async function waitStable(handle: PageHandle, tracker: NetworkTracker, opts?: StabilityOptions): Promise<void>`
  - `interface StabilityOptions { domQuietMs?: number; networkQuietMs?: number; timeoutMs?: number }`（默认 150 / 500 / 5000，对应 spec §7.2）
  - `async function waitFor(handle, tracker, cond: WaitCondition, refs, timeoutMs?): Promise<void>`

- [ ] **Step 1: 写失败的集成测试**

创建 `test/integration/waiter.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import puppeteer, { type Browser } from "puppeteer";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { startFixtureServer } from "../fixtures/server.js";
import { NetworkTracker, waitStable } from "../../src/waiter/stability.js";
import { waitFor } from "../../src/waiter/explicit.js";

let chrome: Browser, session: BrowserSession, fx: Awaited<ReturnType<typeof startFixtureServer>>;
let tracker: NetworkTracker;

beforeAll(async () => {
  fx = await startFixtureServer();
  chrome = await puppeteer.launch({ headless: true, args: ["--remote-debugging-port=9340", "--no-sandbox"] });
  session = await BrowserSession.connect("http://127.0.0.1:9340");
  tracker = await NetworkTracker.attach(await session.getPage());
});
afterAll(async () => { await session?.close(); await chrome?.close(); await fx?.close(); });

async function open(path: string): Promise<PageHandle> {
  const h = await session.getPage();
  await h.page.goto(`${fx.url}/${path}`, { waitUntil: "load" });
  return h;
}

describe("waitStable", () => {
  it("静止页面上快速返回（< 1s）", async () => {
    const h = await open("form.html");
    const t0 = Date.now();
    await waitStable(h, tracker);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("等到 800ms 后的异步 DOM 更新完成才返回", async () => {
    const h = await open("async-list.html");
    await h.cdp.send("Runtime.evaluate", { expression: `document.getElementById("load").click()` });
    await waitStable(h, tracker);
    const { result } = await h.cdp.send("Runtime.evaluate", {
      expression: `document.getElementById("list").textContent`,
      returnByValue: true
    });
    expect((result as { value: string }).value).toContain("ORD20260911");
  });

  it("超时上限生效：页面持续变更时不会永远挂着", async () => {
    const h = await open("form.html");
    await h.cdp.send("Runtime.evaluate", {
      expression: `window.__spin = setInterval(function () {
        document.body.appendChild(document.createElement("span"));
      }, 30)`
    });
    const t0 = Date.now();
    await waitStable(h, tracker, { timeoutMs: 1200 });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(1100);
    expect(elapsed).toBeLessThan(2500);
    await h.cdp.send("Runtime.evaluate", { expression: `clearInterval(window.__spin)` });
  });
});

describe("waitFor", () => {
  it("visible：等到弹窗出现", async () => {
    const h = await open("modal-iframe.html");
    await h.cdp.send("Runtime.evaluate", {
      expression: `setTimeout(function () { document.getElementById("open").click(); }, 400)`
    });
    await waitFor(h, tracker, {
      type: "visible",
      target: { descriptor: { strategies: [{ kind: "css", value: "#cust" }], framePath: [] } }
    }, new Map());
    const { result } = await h.cdp.send("Runtime.evaluate", {
      expression: `!document.getElementById("modal").hidden`,
      returnByValue: true
    });
    expect((result as { value: boolean }).value).toBe(true);
  });

  it("url-contains：命中当前 url 时立即返回", async () => {
    const h = await open("form.html");
    await waitFor(h, tracker, { type: "url-contains", value: "form.html" }, new Map());
  });

  it("条件永不满足时抛超时错误", async () => {
    const h = await open("form.html");
    await expect(
      waitFor(h, tracker, { type: "url-contains", value: "永不出现" }, new Map(), 800)
    ).rejects.toThrow(/超时/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/integration/waiter.test.ts`
Expected: FAIL —— 无法解析 `src/waiter/stability.js`

- [ ] **Step 3: 实现 `src/waiter/stability.ts`**

```ts
import type { PageHandle } from "../session/browser.js";

export interface StabilityOptions {
  domQuietMs?: number;
  networkQuietMs?: number;
  timeoutMs?: number;
}

export class NetworkTracker {
  private pending = new Set<string>();
  private changedAt = Date.now();

  private constructor() {}

  static async attach(handle: PageHandle): Promise<NetworkTracker> {
    const t = new NetworkTracker();
    await handle.cdp.send("Network.enable");
    handle.cdp.on("Network.requestWillBeSent", (e: { requestId: string }) => {
      t.pending.add(e.requestId);
      t.changedAt = Date.now();
    });
    const done = (e: { requestId: string }) => {
      t.pending.delete(e.requestId);
      t.changedAt = Date.now();
    };
    handle.cdp.on("Network.loadingFinished", done);
    handle.cdp.on("Network.loadingFailed", done);
    return t;
  }

  inFlight(): number { return this.pending.size; }
  lastChangeAt(): number { return this.changedAt; }
}

const OBSERVER_SCRIPT = `(function () {
  if (window.__cuqObserver) return;
  window.__cuqLastMutation = Date.now();
  window.__cuqObserver = new MutationObserver(function () {
    window.__cuqLastMutation = Date.now();
  });
  window.__cuqObserver.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, characterData: true
  });
})()`;

async function lastMutationAt(handle: PageHandle): Promise<number> {
  // 逗号表达式：先（幂等地）装上 observer，再读出最后一次变更时间
  const { result } = (await handle.cdp.send("Runtime.evaluate", {
    expression: `(${OBSERVER_SCRIPT}, window.__cuqLastMutation || 0)`,
    returnByValue: true
  })) as { result: { value: number } };
  return result.value;
}

/**
 * 隐式稳定性等待（spec §7.2）。
 * DOM 静默 ≥ domQuietMs 且 无 in-flight 请求 ≥ networkQuietMs 即返回；
 * 超过 timeoutMs 无条件返回（不抛错——超时只意味着页面仍在动，动作照样该执行）。
 */
export async function waitStable(
  handle: PageHandle,
  tracker: NetworkTracker,
  opts: StabilityOptions = {}
): Promise<void> {
  const domQuiet = opts.domQuietMs ?? 150;
  const netQuiet = opts.networkQuietMs ?? 500;
  const timeout = opts.timeoutMs ?? 5000;
  const deadline = Date.now() + timeout;

  for (;;) {
    const now = Date.now();
    if (now >= deadline) return;

    const domOk = now - (await lastMutationAt(handle)) >= domQuiet;
    const netOk = tracker.inFlight() === 0 && now - tracker.lastChangeAt() >= netQuiet;
    if (domOk && netOk) return;

    await new Promise((r) => setTimeout(r, 50));
  }
}
```

> `lastMutationAt` 每次都重新注入 observer 脚本，因为页面导航后 `window` 会重置。脚本自身有 `if (window.__cuqObserver) return` 幂等保护。

- [ ] **Step 4: 实现 `src/waiter/explicit.ts`**

```ts
import type { PageHandle } from "../session/browser.js";
import type { WaitCondition } from "../types.js";
import { resolveTarget } from "../locator/resolve.js";
import type { NetworkTracker } from "./stability.js";

async function isVisible(handle: PageHandle, backendNodeId: number): Promise<boolean> {
  try {
    const { model } = (await handle.cdp.send("DOM.getBoxModel", { backendNodeId })) as {
      model?: { width: number; height: number };
    };
    return !!model && model.width > 0 && model.height > 0;
  } catch {
    return false;
  }
}

async function currentUrl(handle: PageHandle): Promise<string> {
  const { result } = (await handle.cdp.send("Runtime.evaluate", {
    expression: "location.href",
    returnByValue: true
  })) as { result: { value: string } };
  return result.value;
}

export async function waitFor(
  handle: PageHandle,
  tracker: NetworkTracker,
  cond: WaitCondition,
  refs: Map<string, number>,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  const satisfied = async (): Promise<boolean> => {
    switch (cond.type) {
      case "visible": {
        try {
          const r = await resolveTarget(handle, cond.target, refs);
          return isVisible(handle, r.backendNodeId);
        } catch { return false; }
      }
      case "hidden": {
        try {
          const r = await resolveTarget(handle, cond.target, refs);
          return !(await isVisible(handle, r.backendNodeId));
        } catch { return true; }
      }
      case "url-contains":
        return (await currentUrl(handle)).includes(cond.value);
      case "response":
        return tracker.inFlight() === 0 && Date.now() - tracker.lastChangeAt() >= 300;
    }
  };

  for (;;) {
    if (await satisfied()) return;
    if (Date.now() >= deadline) {
      throw new Error(`等待条件 ${cond.type} 超时（${timeoutMs}ms）`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
```

> `response` 条件一期用「网络静默」近似，不做 urlPattern 精确匹配——精确匹配需要维护每个请求的 url 表，收益不抵复杂度。`WaitCondition` 的 `urlPattern` 字段保留，二期再实现。

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run test/integration/waiter.test.ts`
Expected: PASS，6 个用例全绿

- [ ] **Step 6: 提交**

```bash
git add src/waiter test/integration/waiter.test.ts
git commit -m "feat: 隐式稳定性等待与显式等待条件，替代固定 sleep"
```

---

### Task 13: 变量插值与 action 实现

**Files:**
- Create: `src/executor/variables.ts`
- Create: `src/executor/actions.ts`
- Test: `test/unit/variables.test.ts`
- Test: `test/integration/actions.test.ts`

**Interfaces:**
- Consumes: `resolveTarget`（Task 10）、`waitStable`（Task 12）、`Step`（Task 1）
- Produces:
  - `function interpolate(text: string, vars: Record<string, string>): string`
  - `function interpolateStep(step: Step, vars: Record<string, string>): Step`
  - `async function runAction(ctx: ActionContext, step: Step): Promise<void>`
  - `interface ActionContext { handle: PageHandle; tracker: NetworkTracker; refs: Map<string, number>; vars: Record<string, string> }`

- [ ] **Step 1: 写失败的变量单测**

创建 `test/unit/variables.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { interpolate, interpolateStep } from "../../src/executor/variables.js";
import type { Step } from "../../src/types.js";

describe("interpolate", () => {
  it("替换已知变量", () => {
    expect(interpolate("你好 ${NAME}", { NAME: "世界" })).toBe("你好 世界");
  });

  it("替换同一变量的多次出现", () => {
    expect(interpolate("${A}-${A}", { A: "x" })).toBe("x-x");
  });

  it("未知变量抛错而非静默留占位符", () => {
    expect(() => interpolate("${MISSING}", {})).toThrow(/MISSING/);
  });

  it("无变量的文本原样返回", () => {
    expect(interpolate("纯文本", {})).toBe("纯文本");
  });
});

describe("interpolateStep", () => {
  it("替换 fill 的 value", () => {
    const s: Step = { action: "fill", target: { ref: "e1" }, value: "${USER}" };
    expect(interpolateStep(s, { USER: "admin" })).toMatchObject({ value: "admin" });
  });

  it("替换 navigate 的 url", () => {
    const s: Step = { action: "navigate", url: "${BASE}/login" };
    expect(interpolateStep(s, { BASE: "http://x" })).toMatchObject({ url: "http://x/login" });
  });

  it("替换 assert 的 expected", () => {
    const s: Step = { action: "assert", type: "text-contains", expected: "欢迎 ${USER}" };
    expect(interpolateStep(s, { USER: "admin" })).toMatchObject({ expected: "欢迎 admin" });
  });

  it("不含变量的 step 原样返回（引用可以不同，内容必须相等）", () => {
    const s: Step = { action: "press", key: "Enter" };
    expect(interpolateStep(s, {})).toEqual(s);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/unit/variables.test.ts`
Expected: FAIL —— 无法解析 `src/executor/variables.js`

- [ ] **Step 3: 实现 `src/executor/variables.ts`**

```ts
import type { Step } from "../types.js";

export function interpolate(text: string, vars: Record<string, string>): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    if (!(name in vars)) {
      throw new Error(`未定义的变量 \${${name}}，请在配置或环境变量中提供，或先用 extract 步骤生成`);
    }
    return vars[name];
  });
}

export function interpolateStep(step: Step, vars: Record<string, string>): Step {
  const s = { ...step } as Record<string, unknown>;
  for (const key of ["value", "url", "expected", "key"]) {
    if (typeof s[key] === "string") s[key] = interpolate(s[key] as string, vars);
  }
  return s as Step;
}
```

- [ ] **Step 4: 运行变量单测确认通过**

Run: `npx vitest run test/unit/variables.test.ts`
Expected: PASS，8 个用例全绿

- [ ] **Step 5: 写失败的 action 集成测试**

创建 `test/integration/actions.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import puppeteer, { type Browser } from "puppeteer";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { startFixtureServer } from "../fixtures/server.js";
import { NetworkTracker } from "../../src/waiter/stability.js";
import { runAction, type ActionContext } from "../../src/executor/actions.js";
import type { Descriptor } from "../../src/types.js";

let chrome: Browser, session: BrowserSession, fx: Awaited<ReturnType<typeof startFixtureServer>>;
let tracker: NetworkTracker;

beforeAll(async () => {
  fx = await startFixtureServer();
  chrome = await puppeteer.launch({ headless: true, args: ["--remote-debugging-port=9341", "--no-sandbox"] });
  session = await BrowserSession.connect("http://127.0.0.1:9341");
  tracker = await NetworkTracker.attach(await session.getPage());
});
afterAll(async () => { await session?.close(); await chrome?.close(); await fx?.close(); });

const css = (value: string): { descriptor: Descriptor } => ({
  descriptor: { strategies: [{ kind: "css", value }], framePath: [] }
});

async function ctxFor(path: string): Promise<ActionContext> {
  const h: PageHandle = await session.getPage();
  await h.page.goto(`${fx.url}/${path}`, { waitUntil: "load" });
  return { handle: h, tracker, refs: new Map(), vars: {} };
}

async function textOf(ctx: ActionContext, selector: string): Promise<string> {
  const { result } = await ctx.handle.cdp.send("Runtime.evaluate", {
    expression: `document.querySelector(${JSON.stringify(selector)}).textContent`,
    returnByValue: true
  });
  return (result as { value: string }).value;
}

describe("runAction", () => {
  it("fill 写入真实值并触发 input 事件", async () => {
    const ctx = await ctxFor("form.html");
    await runAction(ctx, { action: "fill", target: css("#user"), value: "admin" });
    const { result } = await ctx.handle.cdp.send("Runtime.evaluate", {
      expression: `document.getElementById("user").value`, returnByValue: true
    });
    expect((result as { value: string }).value).toBe("admin");
  });

  it("click 触发页面的 click 监听器", async () => {
    const ctx = await ctxFor("form.html");
    await runAction(ctx, { action: "fill", target: css("#user"), value: "admin" });
    await runAction(ctx, { action: "click", target: css("#submit") });
    expect(await textOf(ctx, "#result")).toBe("欢迎 admin");
  });

  it("click 后自动隐式等待，异步内容已就绪", async () => {
    const ctx = await ctxFor("async-list.html");
    await runAction(ctx, { action: "click", target: css("#load") });
    expect(await textOf(ctx, "#list")).toContain("ORD20260911");
  });

  it("select 选中选项并触发 change", async () => {
    const ctx = await ctxFor("form.html");
    await runAction(ctx, { action: "select", target: css("#region"), value: "hf" });
    const { result } = await ctx.handle.cdp.send("Runtime.evaluate", {
      expression: `document.getElementById("region").value`, returnByValue: true
    });
    expect((result as { value: string }).value).toBe("hf");
  });

  it("navigate 跳转到新页面", async () => {
    const ctx = await ctxFor("form.html");
    await runAction(ctx, { action: "navigate", url: `${fx.url}/table-dup.html` });
    const { result } = await ctx.handle.cdp.send("Runtime.evaluate", {
      expression: "location.pathname", returnByValue: true
    });
    expect((result as { value: string }).value).toBe("/table-dup.html");
  });

  it("extract 把页面文本存进变量表", async () => {
    const ctx = await ctxFor("form.html");
    await runAction(ctx, { action: "fill", target: css("#user"), value: "admin" });
    await runAction(ctx, { action: "click", target: css("#submit") });
    await runAction(ctx, { action: "extract", target: css("#result"), as: "GREETING" });
    expect(ctx.vars.GREETING).toBe("欢迎 admin");
  });

  it("extract from=value 取输入框的值", async () => {
    const ctx = await ctxFor("form.html");
    await runAction(ctx, { action: "fill", target: css("#user"), value: "zhangsan" });
    await runAction(ctx, { action: "extract", target: css("#user"), as: "U", from: "value" });
    expect(ctx.vars.U).toBe("zhangsan");
  });

  it("fill 会先清空原有内容", async () => {
    const ctx = await ctxFor("form.html");
    await runAction(ctx, { action: "fill", target: css("#user"), value: "first" });
    await runAction(ctx, { action: "fill", target: css("#user"), value: "second" });
    const { result } = await ctx.handle.cdp.send("Runtime.evaluate", {
      expression: `document.getElementById("user").value`, returnByValue: true
    });
    expect((result as { value: string }).value).toBe("second");
  });
});
```

- [ ] **Step 6: 运行测试确认失败**

Run: `npx vitest run test/integration/actions.test.ts`
Expected: FAIL —— 无法解析 `src/executor/actions.js`

- [ ] **Step 7: 实现 `src/executor/actions.ts`**

```ts
import type { PageHandle } from "../session/browser.js";
import type { Step, TargetRef } from "../types.js";
import { resolveTarget } from "../locator/resolve.js";
import { NetworkTracker, waitStable } from "../waiter/stability.js";
import { waitFor } from "../waiter/explicit.js";

export interface ActionContext {
  handle: PageHandle;
  tracker: NetworkTracker;
  refs: Map<string, number>;
  vars: Record<string, string>;
}

async function centerOf(
  handle: PageHandle,
  backendNodeId: number
): Promise<{ x: number; y: number }> {
  await handle.cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
  const { model } = (await handle.cdp.send("DOM.getBoxModel", { backendNodeId })) as {
    model: { content: number[] };
  };
  const [x1, y1, , , x3, y3] = model.content;
  return { x: (x1 + x3) / 2, y: (y1 + y3) / 2 };
}

async function nodeIdFor(ctx: ActionContext, target: TargetRef): Promise<number> {
  return (await resolveTarget(ctx.handle, target, ctx.refs)).backendNodeId;
}

/** 经 CDP Input 域派发真实鼠标事件（spec §2.1：保留真实事件序列，不做轨迹动画） */
async function realClick(handle: PageHandle, backendNodeId: number): Promise<void> {
  const { x, y } = await centerOf(handle, backendNodeId);
  await handle.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await handle.cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", clickCount: 1
  });
  await handle.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", clickCount: 1
  });
}

async function readProperty(
  handle: PageHandle,
  backendNodeId: number,
  fn: string
): Promise<string> {
  const { object } = (await handle.cdp.send("DOM.resolveNode", { backendNodeId })) as {
    object: { objectId: string };
  };
  const { result } = (await handle.cdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: fn,
    returnByValue: true
  })) as { result: { value: string } };
  await handle.cdp.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
  return result.value;
}

export async function runAction(ctx: ActionContext, step: Step): Promise<void> {
  const { handle, tracker } = ctx;

  switch (step.action) {
    case "navigate": {
      await handle.cdp.send("Page.enable");
      await handle.cdp.send("Page.navigate", { url: step.url });
      await new Promise((r) => setTimeout(r, 100));
      break;
    }

    case "click": {
      await realClick(handle, await nodeIdFor(ctx, step.target));
      break;
    }

    case "fill": {
      const id = await nodeIdFor(ctx, step.target);
      await handle.cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: id });
      await handle.cdp.send("DOM.focus", { backendNodeId: id });
      // 全选后插入：走真实输入路径，会正常触发 input/change
      await handle.cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65
      });
      await handle.cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65
      });
      await handle.cdp.send("Input.insertText", { text: step.value });
      break;
    }

    case "select": {
      // 原生 <select> 的下拉是 OS 级控件，CDP 点不开。
      // 这是唯一一处刻意走 JS 赋值的 action，并显式补发 change 事件。
      const id = await nodeIdFor(ctx, step.target);
      const { object } = (await handle.cdp.send("DOM.resolveNode", { backendNodeId: id })) as {
        object: { objectId: string };
      };
      await handle.cdp.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: `function (v) {
          this.value = v;
          this.dispatchEvent(new Event("input", { bubbles: true }));
          this.dispatchEvent(new Event("change", { bubbles: true }));
        }`,
        arguments: [{ value: step.value }],
        returnByValue: true
      });
      await handle.cdp.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
      break;
    }

    case "press": {
      await handle.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: step.key });
      await handle.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: step.key });
      break;
    }

    case "hover": {
      const { x, y } = await centerOf(handle, await nodeIdFor(ctx, step.target));
      await handle.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      break;
    }

    case "scroll": {
      if (step.target) {
        await handle.cdp.send("DOM.scrollIntoViewIfNeeded", {
          backendNodeId: await nodeIdFor(ctx, step.target)
        });
      } else {
        const delta = (step.amount ?? 400) * (step.direction === "up" ? -1 : 1);
        await handle.cdp.send("Input.dispatchMouseEvent", {
          type: "mouseWheel", x: 10, y: 10, deltaX: 0, deltaY: delta
        });
      }
      break;
    }

    case "wait": {
      await waitFor(handle, tracker, step.until, ctx.refs, step.timeout);
      return; // 显式等待自带条件，不再叠加隐式等待
    }

    case "sleep": {
      await new Promise((r) => setTimeout(r, step.ms));
      return;
    }

    case "extract": {
      const id = await nodeIdFor(ctx, step.target);
      const fn = step.from === "value"
        ? `function () { return String(this.value == null ? "" : this.value); }`
        : `function () { return (this.textContent || "").trim(); }`;
      ctx.vars[step.as] = await readProperty(handle, id, fn);
      return;
    }

    case "assert":
      throw new Error("assert 由 runAssert 处理，不应进入 runAction");
  }

  // 除 wait/sleep/extract 外，每个动作后自动隐式等待（spec §7.2）
  await waitStable(handle, tracker);
}
```

- [ ] **Step 8: 运行测试确认通过**

Run: `npx vitest run test/integration/actions.test.ts`
Expected: PASS，8 个用例全绿

- [ ] **Step 9: 提交**

```bash
git add src/executor/variables.ts src/executor/actions.ts \
        test/unit/variables.test.ts test/integration/actions.test.ts
git commit -m "feat: 变量插值与 action 实现，经 CDP Input 派发真实事件"
```

---

### Task 14: 断言

**Files:**
- Create: `src/assertion/assert.ts`
- Test: `test/integration/assert.test.ts`

**Interfaces:**
- Consumes: `ActionContext`（Task 13）、`AssertType`（Task 1）
- Produces:
  - `async function runAssert(ctx: ActionContext, step: Extract<Step, { action: "assert" }>): Promise<void>` —— 不满足时 throw `AssertionFailure`
  - `class AssertionFailure extends Error { actual: string; expected: string }`

- [ ] **Step 1: 写失败的集成测试**

创建 `test/integration/assert.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import puppeteer, { type Browser } from "puppeteer";
import { BrowserSession } from "../../src/session/browser.js";
import { startFixtureServer } from "../fixtures/server.js";
import { NetworkTracker } from "../../src/waiter/stability.js";
import { runAction, type ActionContext } from "../../src/executor/actions.js";
import { runAssert, AssertionFailure } from "../../src/assertion/assert.js";
import type { Descriptor } from "../../src/types.js";

let chrome: Browser, session: BrowserSession, fx: Awaited<ReturnType<typeof startFixtureServer>>;
let tracker: NetworkTracker;

beforeAll(async () => {
  fx = await startFixtureServer();
  chrome = await puppeteer.launch({ headless: true, args: ["--remote-debugging-port=9342", "--no-sandbox"] });
  session = await BrowserSession.connect("http://127.0.0.1:9342");
  tracker = await NetworkTracker.attach(await session.getPage());
});
afterAll(async () => { await session?.close(); await chrome?.close(); await fx?.close(); });

const css = (value: string): { descriptor: Descriptor } => ({
  descriptor: { strategies: [{ kind: "css", value }], framePath: [] }
});

async function ctxFor(path: string): Promise<ActionContext> {
  const h = await session.getPage();
  await h.page.goto(`${fx.url}/${path}`, { waitUntil: "load" });
  return { handle: h, tracker, refs: new Map(), vars: {} };
}

describe("runAssert", () => {
  it("visible 对存在的元素通过", async () => {
    const ctx = await ctxFor("form.html");
    await runAssert(ctx, { action: "assert", type: "visible", target: css("#submit") });
  });

  it("visible 对隐藏元素抛 AssertionFailure", async () => {
    const ctx = await ctxFor("modal-iframe.html");
    await expect(
      runAssert(ctx, { action: "assert", type: "visible", target: css("#cust") })
    ).rejects.toBeInstanceOf(AssertionFailure);
  });

  it("hidden 对隐藏元素通过", async () => {
    const ctx = await ctxFor("modal-iframe.html");
    await runAssert(ctx, { action: "assert", type: "hidden", target: css("#cust") });
  });

  it("text-equals 严格匹配", async () => {
    const ctx = await ctxFor("form.html");
    await runAction(ctx, { action: "fill", target: css("#user"), value: "admin" });
    await runAction(ctx, { action: "click", target: css("#submit") });
    await runAssert(ctx, {
      action: "assert", type: "text-equals", target: css("#result"), expected: "欢迎 admin"
    });
  });

  it("text-contains 部分匹配", async () => {
    const ctx = await ctxFor("form.html");
    await runAction(ctx, { action: "fill", target: css("#user"), value: "admin" });
    await runAction(ctx, { action: "click", target: css("#submit") });
    await runAssert(ctx, {
      action: "assert", type: "text-contains", target: css("#result"), expected: "admin"
    });
  });

  it("text-equals 不匹配时错误信息含实际值与期望值", async () => {
    const ctx = await ctxFor("form.html");
    try {
      await runAssert(ctx, {
        action: "assert", type: "text-equals", target: css("#result"), expected: "不可能的值"
      });
      expect.unreachable("应该抛错");
    } catch (e) {
      expect(e).toBeInstanceOf(AssertionFailure);
      expect((e as AssertionFailure).expected).toBe("不可能的值");
      expect((e as Error).message).toContain("不可能的值");
    }
  });

  it("url-contains 命中当前地址", async () => {
    const ctx = await ctxFor("form.html");
    await runAssert(ctx, { action: "assert", type: "url-contains", expected: "form.html" });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/integration/assert.test.ts`
Expected: FAIL —— 无法解析 `src/assertion/assert.js`

- [ ] **Step 3: 实现 `src/assertion/assert.ts`**

```ts
import type { Step } from "../types.js";
import type { ActionContext } from "../executor/actions.js";
import { resolveTarget } from "../locator/resolve.js";

export class AssertionFailure extends Error {
  constructor(message: string, public actual: string, public expected: string) {
    super(message);
    this.name = "AssertionFailure";
  }
}

type AssertStep = Extract<Step, { action: "assert" }>;

export async function runAssert(ctx: ActionContext, step: AssertStep): Promise<void> {
  const { handle } = ctx;

  if (step.type === "url-contains") {
    const { result } = (await handle.cdp.send("Runtime.evaluate", {
      expression: "location.href",
      returnByValue: true
    })) as { result: { value: string } };
    if (!result.value.includes(step.expected ?? "")) {
      throw new AssertionFailure(
        `期望 url 包含「${step.expected}」，实际为「${result.value}」`,
        result.value,
        step.expected ?? ""
      );
    }
    return;
  }

  if (!step.target) throw new Error(`assert ${step.type} 缺少 target`);

  let backendNodeId: number | null = null;
  try {
    backendNodeId = (await resolveTarget(handle, step.target, ctx.refs)).backendNodeId;
  } catch {
    backendNodeId = null;
  }

  const visible = await (async () => {
    if (backendNodeId === null) return false;
    try {
      const { model } = (await handle.cdp.send("DOM.getBoxModel", { backendNodeId })) as {
        model?: { width: number; height: number };
      };
      return !!model && model.width > 0 && model.height > 0;
    } catch { return false; }
  })();

  if (step.type === "visible") {
    if (!visible) throw new AssertionFailure("期望元素可见，实际不可见或不存在", "hidden", "visible");
    return;
  }
  if (step.type === "hidden") {
    if (visible) throw new AssertionFailure("期望元素不可见，实际可见", "visible", "hidden");
    return;
  }

  if (backendNodeId === null) {
    throw new AssertionFailure("断言目标元素不存在", "(不存在)", step.expected ?? "");
  }

  const { object } = (await handle.cdp.send("DOM.resolveNode", { backendNodeId })) as {
    object: { objectId: string };
  };
  const { result } = (await handle.cdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: `function () { return (this.textContent || "").trim(); }`,
    returnByValue: true
  })) as { result: { value: string } };
  await handle.cdp.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});

  const actual = result.value;
  const expected = step.expected ?? "";
  const ok = step.type === "text-equals" ? actual === expected : actual.includes(expected);
  if (!ok) {
    throw new AssertionFailure(
      `期望文本${step.type === "text-equals" ? "等于" : "包含"}「${expected}」，实际为「${actual}」`,
      actual,
      expected
    );
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/integration/assert.test.ts`
Expected: PASS，7 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add src/assertion/assert.ts test/integration/assert.test.ts
git commit -m "feat: 断言实现，失败信息含实际值与期望值"
```

---

### Task 15: batch 编排与 `batch` 工具

**Files:**
- Create: `src/executor/batch.ts`
- Modify: `src/server.ts`（注册 `batch` 工具）
- Test: `test/integration/batch.test.ts`

**Interfaces:**
- Consumes: `runAction`（Task 13）、`runAssert`（Task 14）、`DiagnosticsCollector`（Task 11）、`takeSnapshot`（Task 7）、`LocatorError`（Task 10）、`AssertionFailure`（Task 14）
- Produces:
  - `async function runBatch(opts: BatchOptions): Promise<BatchResult>`
  - `interface BatchOptions { handle; tracker; collector; refs; vars; steps: Step[] }`
  - `interface BatchResult { ok: boolean; results: StepResult[]; vars: Record<string,string>; snapshot: string; failure?: FailureContext }`

**M2 里程碑在此达成**：一条登录流程可以一次 `batch` 调用完成。

- [ ] **Step 1: 写失败的集成测试**

创建 `test/integration/batch.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import puppeteer, { type Browser } from "puppeteer";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { startFixtureServer } from "../fixtures/server.js";
import { NetworkTracker } from "../../src/waiter/stability.js";
import { DiagnosticsCollector } from "../../src/diagnostics/collector.js";
import { runBatch } from "../../src/executor/batch.js";
import type { Descriptor, Step } from "../../src/types.js";

let chrome: Browser, session: BrowserSession, fx: Awaited<ReturnType<typeof startFixtureServer>>;
let tracker: NetworkTracker, collector: DiagnosticsCollector;

beforeAll(async () => {
  fx = await startFixtureServer();
  chrome = await puppeteer.launch({ headless: true, args: ["--remote-debugging-port=9343", "--no-sandbox"] });
  session = await BrowserSession.connect("http://127.0.0.1:9343");
  const h = await session.getPage();
  tracker = await NetworkTracker.attach(h);
  collector = await DiagnosticsCollector.attach(h);
});
afterAll(async () => { await session?.close(); await chrome?.close(); await fx?.close(); });

const css = (value: string): { descriptor: Descriptor } => ({
  descriptor: { strategies: [{ kind: "css", value }], framePath: [] }
});

async function run(steps: Step[], vars: Record<string, string> = {}) {
  const handle: PageHandle = await session.getPage();
  return runBatch({ handle, tracker, collector, refs: new Map(), vars, steps });
}

describe("runBatch", () => {
  it("一次调用完成完整登录流程", async () => {
    const r = await run([
      { action: "navigate", url: `${fx.url}/form.html` },
      { action: "fill", target: css("#user"), value: "${USER}" },
      { action: "fill", target: css("#pwd"), value: "${PWD}" },
      { action: "click", target: css("#submit") },
      { action: "assert", type: "text-contains", target: css("#result"), expected: "欢迎 ${USER}" }
    ], { USER: "admin", PWD: "secret" });

    expect(r.ok).toBe(true);
    expect(r.results).toHaveLength(5);
    expect(r.results.every((s) => s.ok)).toBe(true);
  });

  it("fail-fast：失败步之后的步骤不执行", async () => {
    const r = await run([
      { action: "navigate", url: `${fx.url}/form.html` },
      { action: "click", target: css("#nonexistent") },
      { action: "click", target: css("#submit") }
    ]);

    expect(r.ok).toBe(false);
    expect(r.results).toHaveLength(2);
    expect(r.failure?.failedIndex).toBe(1);
  });

  it("失败上下文一次给全：类型、快照、console、网络", async () => {
    const r = await run([
      { action: "navigate", url: `${fx.url}/form.html` },
      { action: "click", target: css("#nonexistent") }
    ]);

    expect(r.failure?.kind).toBe("target-not-found");
    expect(r.failure?.snapshot).toContain("登录");
    expect(r.failure).toHaveProperty("consoleErrors");
    expect(r.failure).toHaveProperty("failedRequests");
  });

  it("断言失败时 kind 是 assert-failed", async () => {
    const r = await run([
      { action: "navigate", url: `${fx.url}/form.html` },
      { action: "assert", type: "text-equals", target: css("#result"), expected: "不可能" }
    ]);
    expect(r.failure?.kind).toBe("assert-failed");
    expect(r.failure?.message).toContain("不可能");
  });

  it("extract 产生的变量可被后续步骤引用", async () => {
    const r = await run([
      { action: "navigate", url: `${fx.url}/form.html` },
      { action: "fill", target: css("#user"), value: "zhangsan" },
      { action: "click", target: css("#submit") },
      { action: "extract", target: css("#result"), as: "GREET" },
      { action: "assert", type: "text-contains", target: css("#result"), expected: "${GREET}" }
    ]);
    expect(r.ok).toBe(true);
    expect(r.vars.GREET).toBe("欢迎 zhangsan");
  });

  it("卡片墙：用容器锚定精确点到第二张卡的按钮", async () => {
    const r = await run([
      { action: "navigate", url: `${fx.url}/cards-no-container.html` },
      { action: "click", target: { descriptor: {
        strategies: [{
          kind: "container-role-name",
          containerText: "技术平台中心", role: "button", name: "查看在岗干部明细"
        }],
        framePath: []
      }}},
      { action: "assert", type: "text-equals", target: css("#clicked"),
        expected: "技术平台中心 · 查看在岗干部明细" }
    ]);
    expect(r.ok).toBe(true);
  });

  it("表格：用行锚定精确点到第三行的删除按钮", async () => {
    const r = await run([
      { action: "navigate", url: `${fx.url}/table-dup.html` },
      { action: "click", target: { descriptor: {
        strategies: [{ kind: "row-role-name", rowText: "ORD20260913", role: "button", name: "删除" }],
        framePath: []
      }}},
      { action: "assert", type: "text-equals", target: css("#deleted"), expected: "已删除 ORD20260913" }
    ]);
    expect(r.ok).toBe(true);
  });

  it("每步都记录耗时", async () => {
    const r = await run([{ action: "navigate", url: `${fx.url}/form.html` }]);
    expect(r.results[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("sleep 步骤在结果里被标记为需要关注", async () => {
    const r = await run([
      { action: "navigate", url: `${fx.url}/form.html` },
      { action: "sleep", ms: 50 }
    ]);
    expect(r.ok).toBe(true);
    expect(r.results[1].error).toContain("sleep");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/integration/batch.test.ts`
Expected: FAIL —— 无法解析 `src/executor/batch.js`

- [ ] **Step 3: 实现 `src/executor/batch.ts`**

```ts
import type { PageHandle } from "../session/browser.js";
import type { NetworkTracker } from "../waiter/stability.js";
import type { DiagnosticsCollector } from "../diagnostics/collector.js";
import type { FailureContext, FailureKind, Step, StepResult } from "../types.js";
import { runAction, type ActionContext } from "./actions.js";
import { runAssert, AssertionFailure } from "../assertion/assert.js";
import { interpolateStep } from "./variables.js";
import { LocatorError } from "../locator/resolve.js";
import { takeSnapshot } from "../perception/snapshot.js";

export interface BatchOptions {
  handle: PageHandle;
  tracker: NetworkTracker;
  collector: DiagnosticsCollector;
  refs: Map<string, number>;
  vars: Record<string, string>;
  steps: Step[];
}

export interface BatchResult {
  ok: boolean;
  results: StepResult[];
  vars: Record<string, string>;
  snapshot: string;
  failure?: FailureContext;
}

function classify(err: unknown): { kind: FailureKind; message: string; candidates?: string[] } {
  if (err instanceof LocatorError) {
    return { kind: err.kind, message: err.message, candidates: err.candidates };
  }
  if (err instanceof AssertionFailure) {
    return { kind: "assert-failed", message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/超时/.test(message)) return { kind: "timeout", message };
  if (/navigat/i.test(message)) return { kind: "navigation-failed", message };
  return { kind: "target-not-found", message };
}

export async function runBatch(opts: BatchOptions): Promise<BatchResult> {
  const ctx: ActionContext = {
    handle: opts.handle,
    tracker: opts.tracker,
    refs: opts.refs,
    vars: { ...opts.vars }
  };

  const results: StepResult[] = [];

  for (let i = 0; i < opts.steps.length; i++) {
    const raw = opts.steps[i];
    const t0 = Date.now();

    try {
      const step = interpolateStep(raw, ctx.vars);
      if (step.action === "assert") {
        await runAssert(ctx, step);
      } else {
        await runAction(ctx, step);
      }
      results.push({
        index: i,
        action: raw.action,
        ok: true,
        durationMs: Date.now() - t0,
        // sleep 是技术债信号，成功也要让它显形（spec §7.2）
        error: raw.action === "sleep"
          ? "使用了固定 sleep，建议改为显式 wait 条件"
          : undefined
      });
    } catch (err) {
      const { kind, message, candidates } = classify(err);
      results.push({ index: i, action: raw.action, ok: false, durationMs: Date.now() - t0, error: message });

      let snapshotText = "（快照获取失败）";
      try {
        snapshotText = (await takeSnapshot(opts.handle)).text;
      } catch { /* 快照失败不应掩盖原始错误 */ }

      return {
        ok: false,
        results,
        vars: ctx.vars,
        snapshot: snapshotText,
        failure: {
          failedIndex: i,
          failedStep: raw,
          kind,
          message,
          snapshot: snapshotText,
          candidates: candidates?.slice(0, 10),
          consoleErrors: opts.collector.consoleErrors(),
          failedRequests: opts.collector.failedRequests()
        }
      };
    }
  }

  const final = await takeSnapshot(opts.handle);
  opts.refs.clear();
  for (const [k, v] of final.refs) opts.refs.set(k, v);

  return { ok: true, results, vars: ctx.vars, snapshot: final.text };
}
```

- [ ] **Step 4: 在 `src/server.ts` 注册 `batch` 工具**

在 `createServer` 里加（需在顶部 import `runBatch`、`NetworkTracker`，并加一个 `trackers` 注册表，写法与 `collectors` 相同）：

```ts
  server.registerTool(
    "batch",
    {
      description:
        "一次执行多个步骤（navigate/click/fill/select/press/hover/scroll/wait/assert/extract）。" +
        "每个动作后自动做稳定性等待，无需写 sleep。fail-fast：任一步失败即停并返回完整失败上下文。" +
        "target 用 snapshot 返回的 ref（如 {\"ref\":\"e3\"}）或 descriptor。",
      inputSchema: {
        pageId: z.string().optional(),
        steps: z.array(z.any()).min(1).describe("步骤数组，见 description"),
        vars: z.record(z.string()).optional().describe("变量表，供 ${VAR} 插值；凭证从这里传")
      }
    },
    async ({ pageId, steps, vars }) => {
      const handle = await session.getPage(pageId);
      const collector = await attachCollector(handle);
      const tracker = await attachTracker(handle);
      const refs = refTables.get(handle.pageId) ?? new Map<string, number>();

      const r = await runBatch({
        handle, tracker, collector, refs,
        vars: { ...process.env, ...(vars ?? {}) } as Record<string, string>,
        steps: steps as Step[]
      });
      refTables.set(handle.pageId, refs);
      recordSteps(handle.pageId, steps as Step[], r.results);

      if (r.ok) {
        return { content: [{ type: "text" as const, text:
          `✅ ${r.results.length} 步全部成功（合计 ${r.results.reduce((a, s) => a + s.durationMs, 0)}ms）\n\n` +
          `## 执行后快照\n${r.snapshot}` }] };
      }

      const f = r.failure!;
      return { content: [{ type: "text" as const, text:
        `❌ 第 ${f.failedIndex + 1} 步失败：${f.kind}\n${f.message}\n\n` +
        `## 失败步骤\n${JSON.stringify(f.failedStep, null, 2)}\n\n` +
        (f.candidates?.length ? `## 候选元素\n${f.candidates.join("\n")}\n\n` : "") +
        `## 当前快照\n${f.snapshot}\n\n` +
        `## console 报错\n${f.consoleErrors.join("\n") || "（无）"}\n\n` +
        `## 失败请求\n${f.failedRequests.join("\n") || "（无）"}` }] };
    }
  );
```

配套在 `src/server.ts` 顶部加 tracker 注册表与步骤台账（`recordSteps` 供 Task 16 的 `save_trace` 消费）：

```ts
import { NetworkTracker } from "./waiter/stability.js";
import type { Step, StepResult } from "./types.js";

const trackers = new Map<string, NetworkTracker>();

export async function attachTracker(handle: PageHandle): Promise<NetworkTracker> {
  const existing = trackers.get(handle.pageId);
  if (existing) return existing;
  const t = await NetworkTracker.attach(handle);
  trackers.set(handle.pageId, t);
  return t;
}

/** 本 session 内每个页面成功执行过的步骤，供 save_trace 固化 */
export const sessionSteps = new Map<string, Step[]>();

export function recordSteps(pageId: string, steps: Step[], results: StepResult[]): void {
  const acc = sessionSteps.get(pageId) ?? [];
  for (const r of results) {
    if (r.ok && steps[r.index]) acc.push(steps[r.index]);
  }
  sessionSteps.set(pageId, acc);
}
```

- [ ] **Step 5: 运行全部测试确认通过（M2 达成）**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全绿，无类型错误

- [ ] **Step 6: 提交**

```bash
git add src/executor/batch.ts src/server.ts test/integration/batch.test.ts
git commit -m "feat: batch 编排与 batch 工具，M2 执行层达成"
```

---

# M3 · 回放

### Task 16: trace 存储、descriptor 固化与 `save_trace` 工具

**Files:**
- Create: `src/trace/store.ts`
- Modify: `src/executor/batch.ts`（成功步骤固化 descriptor）
- Modify: `src/executor/actions.ts`（把解析结果回传给 ctx）
- Modify: `src/server.ts`（注册 `save_trace` 工具）
- Test: `test/unit/store.test.ts`
- Test: `test/integration/save-trace.test.ts`

**Interfaces:**
- Consumes: `buildDescriptor`（Task 9）、`sessionSteps`/`recordSteps`（Task 15）、`Trace`（Task 1）
- Produces:
  - `async function saveTrace(dir: string, trace: Trace): Promise<string>` —— 返回写入路径
  - `async function loadTrace(path: string): Promise<Trace>`
  - `function assertNoSecrets(trace: Trace): void` —— 检出明文凭证时 throw
  - `ActionContext` 新增 `lastResolve?: ResolveResult`
  - `BatchOptions` 新增 `captureDescriptors?: boolean`（默认 `true`；replay 时传 `false`）

**为什么 descriptor 固化放在这个任务**：batch 里用的是 `{ref}`（短期句柄），trace 里必须是 `{descriptor}`（长期描述符）——这正是 spec §6.1 的核心区分。转换只在「要保存」时才有意义，所以和 `save_trace` 同一个任务落地。

- [ ] **Step 1: 写失败的 store 单测**

创建 `test/unit/store.test.ts`：

```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveTrace, loadTrace, assertNoSecrets } from "../../src/trace/store.js";
import type { Trace } from "../../src/types.js";

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "cuq-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const base: Trace = {
  name: "smoke-login",
  baseUrl: "http://localhost:3040",
  createdAt: "2026-09-11T00:00:00.000Z",
  steps: [{ action: "navigate", url: "/#/" }]
};

describe("saveTrace / loadTrace", () => {
  it("写入的文件名由 trace 名派生", async () => {
    const d = await tmp();
    expect(await saveTrace(d, base)).toBe(join(d, "smoke-login.json"));
  });

  it("往返一致：存进去再读出来内容相同", async () => {
    const d = await tmp();
    expect(await loadTrace(await saveTrace(d, base))).toEqual(base);
  });

  it("写出的是格式化 JSON，便于 git diff", async () => {
    const d = await tmp();
    expect(await readFile(await saveTrace(d, base), "utf8")).toContain("\n  ");
  });

  it("读到结构非法的文件时抛出明确错误", async () => {
    const d = await tmp();
    const p = join(d, "bad.json");
    await saveTrace(d, base);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(p, JSON.stringify({ name: "x" }), "utf8");
    await expect(loadTrace(p)).rejects.toThrow(/steps/);
  });
});

describe("assertNoSecrets", () => {
  it("密码字段是 ${VAR} 占位符时放行", () => {
    assertNoSecrets({ ...base, steps: [
      { action: "fill", target: { descriptor: { strategies: [{ kind: "css", value: "#pwd" }], framePath: [] } }, value: "${PWD}" }
    ]});
  });

  it("密码字段是明文时抛错", () => {
    expect(() => assertNoSecrets({ ...base, steps: [
      { action: "fill", target: { descriptor: { strategies: [{ kind: "css", value: "#password" }], framePath: [] } }, value: "hunter2" }
    ]})).toThrow(/明文/);
  });

  it("非敏感字段的明文值放行", () => {
    assertNoSecrets({ ...base, steps: [
      { action: "fill", target: { descriptor: { strategies: [{ kind: "css", value: "#user" }], framePath: [] } }, value: "admin" }
    ]});
  });

  it("trace 里仍残留 ref 句柄时抛错（ref 不可长期保存）", () => {
    expect(() => assertNoSecrets({ ...base, steps: [
      { action: "click", target: { ref: "e3" } }
    ]})).toThrow(/ref/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/unit/store.test.ts`
Expected: FAIL —— 无法解析 `src/trace/store.js`

- [ ] **Step 3: 实现 `src/trace/store.ts`**

```ts
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Trace, Step } from "../types.js";

const SECRET_HINT = /(password|passwd|pwd|secret|token|credential|apikey|api_key)/i;

function targetText(step: Step): string {
  const t = (step as { target?: unknown }).target;
  return t ? JSON.stringify(t) : "";
}

export function assertNoSecrets(trace: Trace): void {
  for (const [i, step] of trace.steps.entries()) {
    const t = (step as { target?: { ref?: string } }).target;
    if (t && "ref" in t) {
      throw new Error(
        `第 ${i + 1} 步仍在使用 ref「${t.ref}」。ref 只在单次快照内有效，不能写进 trace——` +
        `请在保存前把它固化为 descriptor。`
      );
    }
    if (step.action !== "fill") continue;
    const looksSecret = SECRET_HINT.test(targetText(step));
    const isPlaceholder = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(step.value);
    if (looksSecret && !isPlaceholder) {
      throw new Error(
        `第 ${i + 1} 步向疑似凭证字段写入了明文值。请改用 \${VAR} 占位符，` +
        `真实值通过 batch/replay 的 vars 或环境变量传入。`
      );
    }
  }
}

export async function saveTrace(dir: string, trace: Trace): Promise<string> {
  assertNoSecrets(trace);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${trace.name}.json`);
  await writeFile(path, JSON.stringify(trace, null, 2) + "\n", "utf8");
  return path;
}

export async function loadTrace(path: string): Promise<Trace> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<Trace>;
  if (!Array.isArray(parsed.steps)) {
    throw new Error(`${path} 不是合法 trace：缺少 steps 数组`);
  }
  if (typeof parsed.name !== "string" || typeof parsed.baseUrl !== "string") {
    throw new Error(`${path} 不是合法 trace：缺少 name 或 baseUrl`);
  }
  return {
    name: parsed.name,
    baseUrl: parsed.baseUrl,
    createdAt: parsed.createdAt ?? "",
    steps: parsed.steps
  };
}
```

- [ ] **Step 4: 运行 store 单测确认通过**

Run: `npx vitest run test/unit/store.test.ts`
Expected: PASS，8 个用例全绿

- [ ] **Step 5: 让 `actions.ts` 回传解析结果**

在 `src/executor/actions.ts` 的 `ActionContext` 接口加一个字段：

```ts
export interface ActionContext {
  handle: PageHandle;
  tracker: NetworkTracker;
  refs: Map<string, number>;
  vars: Record<string, string>;
  /** 最近一次 target 解析的结果，供 batch 记录 strategyIndex 与固化 descriptor */
  lastResolve?: ResolveResult;
}
```

顶部补 `import type { ResolveResult } from "../types.js";`，并把 `nodeIdFor` 改成记录解析结果：

```ts
async function nodeIdFor(ctx: ActionContext, target: TargetRef): Promise<number> {
  const r = await resolveTarget(ctx.handle, target, ctx.refs);
  ctx.lastResolve = r;
  return r.backendNodeId;
}
```

- [ ] **Step 6: 让 `batch.ts` 固化 descriptor 并记录 strategyIndex**

在 `src/executor/batch.ts` 顶部补 import：

```ts
import { buildDescriptor } from "../locator/descriptor.js";
import type { Step as StepType } from "../types.js";
```

`BatchOptions` 加字段：

```ts
  /** 成功执行后是否把 {ref} 固化成 {descriptor}，供 save_trace 使用。replay 时传 false。 */
  captureDescriptors?: boolean;
```

`BatchResult` 加字段：

```ts
  /** 固化后的步骤：所有 {ref} 已替换为 {descriptor} */
  capturedSteps: StepType[];
```

在循环里，把成功分支改成（替换原来的 `results.push({ index: i, ... })` 那一段）：

```ts
      let captured = step;
      if (opts.captureDescriptors !== false && ctx.lastResolve && "target" in step) {
        const target = (step as { target: unknown }).target;
        if (target && typeof target === "object" && "ref" in target) {
          const descriptor = await buildDescriptor(opts.handle, ctx.lastResolve.backendNodeId);
          captured = { ...step, target: { descriptor } } as StepType;
        }
      }
      capturedSteps.push(captured);

      results.push({
        index: i,
        action: raw.action,
        ok: true,
        durationMs: Date.now() - t0,
        strategyIndex: ctx.lastResolve?.strategyIndex,
        error: raw.action === "sleep"
          ? "使用了固定 sleep，建议改为显式 wait 条件"
          : undefined
      });
      ctx.lastResolve = undefined;
```

在循环前声明 `const capturedSteps: StepType[] = [];`，并在两个 `return` 里都带上 `capturedSteps`。

- [ ] **Step 7: 在 `src/server.ts` 注册 `save_trace` 工具**

把 `recordSteps` 的签名改为接收固化后的步骤，并注册工具：

```ts
export function recordSteps(pageId: string, capturedSteps: Step[]): void {
  const acc = sessionSteps.get(pageId) ?? [];
  acc.push(...capturedSteps);
  sessionSteps.set(pageId, acc);
}
```

`batch` 工具里的调用相应改为 `recordSteps(handle.pageId, r.capturedSteps);`。

新增工具：

```ts
  server.registerTool(
    "save_trace",
    {
      description:
        "把本次 session 中成功执行过的步骤固化成可回放的 trace 文件。" +
        "所有 ref 已自动转成稳定的 descriptor，凭证必须是 ${VAR} 占位符。",
      inputSchema: {
        name: z.string().describe("用例名，将作为文件名"),
        baseUrl: z.string().describe("被测系统根地址"),
        dir: z.string().optional().describe("保存目录，默认 ./traces"),
        pageId: z.string().optional()
      }
    },
    async ({ name, baseUrl, dir, pageId }) => {
      const handle = await session.getPage(pageId);
      const steps = sessionSteps.get(handle.pageId) ?? [];
      if (steps.length === 0) {
        return { content: [{ type: "text" as const, text: "本 session 尚无成功执行的步骤，无可保存内容。" }] };
      }
      const path = await saveTrace(dir ?? "./traces", {
        name, baseUrl, createdAt: new Date().toISOString(), steps
      });
      return { content: [{ type: "text" as const, text: `已保存 ${steps.length} 步到 ${path}` }] };
    }
  );
```

顶部补 `import { saveTrace } from "./trace/store.js";`。

- [ ] **Step 8: 写 save_trace 集成测试**

创建 `test/integration/save-trace.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import puppeteer, { type Browser } from "puppeteer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserSession } from "../../src/session/browser.js";
import { startFixtureServer } from "../fixtures/server.js";
import { NetworkTracker } from "../../src/waiter/stability.js";
import { DiagnosticsCollector } from "../../src/diagnostics/collector.js";
import { runBatch } from "../../src/executor/batch.js";
import { takeSnapshot } from "../../src/perception/snapshot.js";
import { saveTrace, loadTrace } from "../../src/trace/store.js";

let chrome: Browser, session: BrowserSession, fx: Awaited<ReturnType<typeof startFixtureServer>>;
let tracker: NetworkTracker, collector: DiagnosticsCollector, dir: string;

beforeAll(async () => {
  fx = await startFixtureServer();
  chrome = await puppeteer.launch({ headless: true, args: ["--remote-debugging-port=9344", "--no-sandbox"] });
  session = await BrowserSession.connect("http://127.0.0.1:9344");
  const h = await session.getPage();
  tracker = await NetworkTracker.attach(h);
  collector = await DiagnosticsCollector.attach(h);
  dir = await mkdtemp(join(tmpdir(), "cuq-trace-"));
});
afterAll(async () => {
  await session?.close(); await chrome?.close(); await fx?.close();
  await rm(dir, { recursive: true, force: true });
});

describe("descriptor 固化", () => {
  it("batch 里用的 ref 被固化成 descriptor，可存成 trace", async () => {
    const handle = await session.getPage();
    await handle.page.goto(`${fx.url}/cards-no-container.html`, { waitUntil: "load" });

    const snap = await takeSnapshot(handle, { threshold: 99 });
    const line = snap.text.split("\n").filter((l) => l.includes("查看在岗干部明细"))[1];
    const ref = line.match(/\[(e\d+)\]/)![1];

    const r = await runBatch({
      handle, tracker, collector, refs: snap.refs, vars: {},
      steps: [{ action: "click", target: { ref } }]
    });

    expect(r.ok).toBe(true);
    const captured = r.capturedSteps[0] as { target: { descriptor?: unknown } };
    expect(captured.target.descriptor).toBeDefined();

    const path = await saveTrace(dir, {
      name: "card-click", baseUrl: fx.url,
      createdAt: new Date().toISOString(), steps: r.capturedSteps
    });
    const loaded = await loadTrace(path);
    expect(JSON.stringify(loaded.steps)).not.toContain('"ref"');
    expect(JSON.stringify(loaded.steps)).toContain("技术平台中心");
  });

  it("replay 模式（captureDescriptors=false）不产生额外的 descriptor 计算", async () => {
    const handle = await session.getPage();
    await handle.page.goto(`${fx.url}/form.html`, { waitUntil: "load" });
    const snap = await takeSnapshot(handle);
    const ref = snap.text.split("\n").find((l) => l.includes('"登录"'))!.match(/\[(e\d+)\]/)![1];

    const r = await runBatch({
      handle, tracker, collector, refs: snap.refs, vars: {},
      captureDescriptors: false,
      steps: [{ action: "click", target: { ref } }]
    });
    const captured = r.capturedSteps[0] as { target: { ref?: string } };
    expect(captured.target.ref).toBe(ref);
  });
});
```

- [ ] **Step 9: 运行测试确认通过**

Run: `npx vitest run test/unit/store.test.ts test/integration/save-trace.test.ts && npx tsc --noEmit`
Expected: 全绿，无类型错误

- [ ] **Step 10: 提交**

```bash
git add src/trace/store.ts src/executor/batch.ts src/executor/actions.ts src/server.ts \
        test/unit/store.test.ts test/integration/save-trace.test.ts
git commit -m "feat: trace 存储与 descriptor 固化，ref 在保存时转为长期描述符"
```

---

### Task 17: replay 引擎、run-record 与 `replay` 工具

**Files:**
- Create: `src/trace/replay.ts`
- Create: `src/report/runRecord.ts`
- Modify: `src/server.ts`（注册 `replay` 工具）
- Test: `test/unit/runRecord.test.ts`
- Test: `test/integration/replay.test.ts`

**Interfaces:**
- Consumes: `runBatch`（Task 15/16）、`loadTrace`（Task 16）、`RunRecord`/`StepResult`（Task 1）
- Produces:
  - `async function replayTrace(opts: ReplayOptions): Promise<RunRecord>`
  - `interface ReplayOptions { handle; tracker; collector; trace: Trace; vars: Record<string,string>; slowMoMs?: number }`
  - `function renderRunRecord(rec: RunRecord): string` —— markdown 文本

`slowMoMs` 服务于「演示/现场验证」场景（spec §2 目标表）——回放时每步之间插入延迟，让人看得见在操作。默认 0。

**M3 里程碑在此达成**：一条用例一次 `replay` 调用跑完，全程不过模型。

- [ ] **Step 1: 写失败的 run-record 单测**

创建 `test/unit/runRecord.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { renderRunRecord } from "../../src/report/runRecord.js";
import type { RunRecord } from "../../src/types.js";

const base: RunRecord = {
  traceName: "smoke-login",
  startedAt: "2026-09-11T00:00:00.000Z",
  durationMs: 4200,
  ok: true,
  steps: [
    { index: 0, action: "navigate", ok: true, durationMs: 1200 },
    { index: 1, action: "click", ok: true, durationMs: 300, strategyIndex: 0 }
  ],
  drifts: [],
  healRequired: false
};

describe("renderRunRecord", () => {
  it("成功时标题带对勾和总耗时", () => {
    const md = renderRunRecord(base);
    expect(md).toContain("✅");
    expect(md).toContain("4200ms");
    expect(md).toContain("smoke-login");
  });

  it("逐步列出耗时", () => {
    const md = renderRunRecord(base);
    expect(md).toContain("navigate");
    expect(md).toContain("1200ms");
  });

  it("有漂移时单列一节告警，但不影响成功状态", () => {
    const md = renderRunRecord({
      ...base,
      drifts: [{ index: 1, expected: "test-id", actual: "container-role-name" }]
    });
    expect(md).toContain("漂移");
    expect(md).toContain("test-id");
    expect(md).toContain("container-role-name");
    expect(md).toContain("✅");
  });

  it("失败时标题带叉号并附失败上下文", () => {
    const md = renderRunRecord({
      ...base, ok: false, healRequired: true,
      failure: {
        failedIndex: 1,
        failedStep: { action: "click", target: { descriptor: { strategies: [], framePath: [] } } },
        kind: "target-not-found",
        message: "全部策略均未命中",
        snapshot: "button \"登录\"",
        consoleErrors: ["Uncaught TypeError"],
        failedRequests: ["500 /api/x"]
      }
    });
    expect(md).toContain("❌");
    expect(md).toContain("heal_required");
    expect(md).toContain("全部策略均未命中");
    expect(md).toContain("Uncaught TypeError");
    expect(md).toContain("500 /api/x");
  });

  it("无漂移时不输出漂移小节", () => {
    expect(renderRunRecord(base)).not.toContain("漂移");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/unit/runRecord.test.ts`
Expected: FAIL —— 无法解析 `src/report/runRecord.js`

- [ ] **Step 3: 实现 `src/report/runRecord.ts`**

```ts
import type { RunRecord } from "../types.js";

export function renderRunRecord(rec: RunRecord): string {
  const head = rec.ok
    ? `✅ ${rec.traceName} 回放成功 — ${rec.steps.length} 步，合计 ${rec.durationMs}ms`
    : `❌ ${rec.traceName} 回放失败 — 在第 ${(rec.failure?.failedIndex ?? 0) + 1} 步中断，已耗时 ${rec.durationMs}ms`;

  const lines = [`# ${head}`, "", "## 逐步耗时", ""];
  for (const s of rec.steps) {
    const mark = s.ok ? "·" : "✗";
    const strat = s.strategyIndex !== undefined && s.strategyIndex >= 0
      ? `（命中第 ${s.strategyIndex + 1} 条策略）` : "";
    lines.push(`${mark} ${s.index + 1}. ${s.action} — ${s.durationMs}ms ${strat}`);
  }

  if (rec.drifts.length > 0) {
    lines.push("", "## ⚠ 定位漂移告警", "");
    lines.push("以下步骤的首选定位策略已失效，回放仍成功但页面结构可能已改版：", "");
    for (const d of rec.drifts) {
      lines.push(`- 第 ${d.index + 1} 步：期望 ${d.expected}，实际回退到 ${d.actual}`);
    }
  }

  if (rec.failure) {
    const f = rec.failure;
    lines.push(
      "", `## 失败上下文（heal_required=${rec.healRequired}）`, "",
      `**类型**：${f.kind}`, `**信息**：${f.message}`, "",
      "**失败步骤**", "```json", JSON.stringify(f.failedStep, null, 2), "```", "",
      "**当前快照**", "```", f.snapshot, "```", "",
      `**console 报错**`, f.consoleErrors.join("\n") || "（无）", "",
      `**失败请求**`, f.failedRequests.join("\n") || "（无）"
    );
  }

  return lines.join("\n");
}
```

- [ ] **Step 4: 运行 run-record 单测确认通过**

Run: `npx vitest run test/unit/runRecord.test.ts`
Expected: PASS，5 个用例全绿

- [ ] **Step 5: 实现 `src/trace/replay.ts`**

```ts
import type { PageHandle } from "../session/browser.js";
import type { NetworkTracker } from "../waiter/stability.js";
import type { DiagnosticsCollector } from "../diagnostics/collector.js";
import type { RunRecord, Trace, Step, Descriptor } from "../types.js";
import { runBatch } from "../executor/batch.js";

export interface ReplayOptions {
  handle: PageHandle;
  tracker: NetworkTracker;
  collector: DiagnosticsCollector;
  trace: Trace;
  vars: Record<string, string>;
  /** 每步之间的额外延迟，用于演示场景让人看得见操作。默认 0。 */
  slowMoMs?: number;
}

/** 把 trace 里的相对 url 补全成绝对地址 */
function absolutize(step: Step, baseUrl: string): Step {
  if (step.action !== "navigate") return step;
  if (/^https?:\/\//i.test(step.url)) return step;
  return { ...step, url: baseUrl.replace(/\/$/, "") + (step.url.startsWith("/") ? step.url : `/${step.url}`) };
}

function firstStrategyKind(step: Step): string | undefined {
  const t = (step as { target?: { descriptor?: Descriptor } }).target;
  return t?.descriptor?.strategies[0]?.kind;
}

export async function replayTrace(opts: ReplayOptions): Promise<RunRecord> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const steps = opts.trace.steps.map((s) => absolutize(s, opts.trace.baseUrl));
  const slowMo = opts.slowMoMs ?? 0;

  const withSlowMo: Step[] = slowMo > 0
    ? steps.flatMap((s, i) => (i === 0 ? [s] : [{ action: "sleep", ms: slowMo } as Step, s]))
    : steps;

  const r = await runBatch({
    handle: opts.handle,
    tracker: opts.tracker,
    collector: opts.collector,
    refs: new Map(),
    vars: opts.vars,
    steps: withSlowMo,
    captureDescriptors: false
  });

  // slowMo 插入的 sleep 步骤不计入台账
  const realResults = slowMo > 0
    ? r.results.filter((s) => s.action !== "sleep").map((s, i) => ({ ...s, index: i }))
    : r.results;

  const drifts: RunRecord["drifts"] = [];
  for (const s of realResults) {
    if (s.strategyIndex === undefined || s.strategyIndex <= 0) continue;
    const step = steps[s.index];
    const expected = firstStrategyKind(step);
    const actual = (step as { target?: { descriptor?: Descriptor } })
      .target?.descriptor?.strategies[s.strategyIndex]?.kind;
    if (expected && actual) drifts.push({ index: s.index, expected, actual });
  }

  return {
    traceName: opts.trace.name,
    startedAt,
    durationMs: Date.now() - t0,
    ok: r.ok,
    steps: realResults,
    drifts,
    failure: r.failure,
    healRequired: !r.ok
  };
}
```

- [ ] **Step 6: 在 `src/server.ts` 注册 `replay` 工具**

```ts
  server.registerTool(
    "replay",
    {
      description:
        "回放一条已固化的 trace，一次调用跑完整条用例，全程不调用模型。" +
        "返回逐步耗时台账、定位漂移告警与失败上下文。CI 回归用这个。",
      inputSchema: {
        tracePath: z.string().describe("trace 文件路径"),
        vars: z.record(z.string()).optional().describe("变量表，凭证从这里传"),
        slowMoMs: z.number().int().min(0).optional().describe("每步延迟，演示场景用，默认 0"),
        pageId: z.string().optional()
      }
    },
    async ({ tracePath, vars, slowMoMs, pageId }) => {
      const handle = await session.getPage(pageId);
      const collector = await attachCollector(handle);
      const tracker = await attachTracker(handle);
      collector.clear();

      const trace = await loadTrace(tracePath);
      const rec = await replayTrace({
        handle, tracker, collector, trace, slowMoMs,
        vars: { ...process.env, ...(vars ?? {}) } as Record<string, string>
      });
      return { content: [{ type: "text" as const, text: renderRunRecord(rec) }] };
    }
  );
```

顶部补：

```ts
import { loadTrace } from "./trace/store.js";
import { replayTrace } from "./trace/replay.js";
import { renderRunRecord } from "./report/runRecord.js";
```

- [ ] **Step 7: 写 replay 集成测试**

创建 `test/integration/replay.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import puppeteer, { type Browser } from "puppeteer";
import { BrowserSession } from "../../src/session/browser.js";
import { startFixtureServer } from "../fixtures/server.js";
import { NetworkTracker } from "../../src/waiter/stability.js";
import { DiagnosticsCollector } from "../../src/diagnostics/collector.js";
import { replayTrace } from "../../src/trace/replay.js";
import type { Trace } from "../../src/types.js";

let chrome: Browser, session: BrowserSession, fx: Awaited<ReturnType<typeof startFixtureServer>>;
let tracker: NetworkTracker, collector: DiagnosticsCollector;

beforeAll(async () => {
  fx = await startFixtureServer();
  chrome = await puppeteer.launch({ headless: true, args: ["--remote-debugging-port=9345", "--no-sandbox"] });
  session = await BrowserSession.connect("http://127.0.0.1:9345");
  const h = await session.getPage();
  tracker = await NetworkTracker.attach(h);
  collector = await DiagnosticsCollector.attach(h);
});
afterAll(async () => { await session?.close(); await chrome?.close(); await fx?.close(); });

function loginTrace(baseUrl: string): Trace {
  const css = (value: string) => ({ descriptor: { strategies: [{ kind: "css" as const, value }], framePath: [] } });
  return {
    name: "smoke-login", baseUrl, createdAt: "2026-09-11T00:00:00.000Z",
    steps: [
      { action: "navigate", url: "/form.html" },
      { action: "fill", target: css("#user"), value: "${USER}" },
      { action: "fill", target: css("#pwd"), value: "${PWD}" },
      { action: "click", target: css("#submit") },
      { action: "assert", type: "text-contains", target: css("#result"), expected: "欢迎 ${USER}" }
    ]
  };
}

async function run(trace: Trace, vars: Record<string, string>, slowMoMs?: number) {
  return replayTrace({
    handle: await session.getPage(), tracker, collector, trace, vars, slowMoMs
  });
}

describe("replayTrace", () => {
  it("整条用例回放成功，逐步台账完整", async () => {
    const rec = await run(loginTrace(fx.url), { USER: "admin", PWD: "s3cret" });
    expect(rec.ok).toBe(true);
    expect(rec.healRequired).toBe(false);
    expect(rec.steps).toHaveLength(5);
    expect(rec.steps.every((s) => s.ok)).toBe(true);
  });

  it("相对 url 被 baseUrl 补全", async () => {
    const rec = await run(loginTrace(fx.url), { USER: "a", PWD: "b" });
    expect(rec.steps[0].ok).toBe(true);
  });

  it("凭证从 vars 注入，trace 里只有占位符", async () => {
    const t = loginTrace(fx.url);
    expect(JSON.stringify(t)).not.toContain("s3cret");
    expect((await run(t, { USER: "admin", PWD: "s3cret" })).ok).toBe(true);
  });

  it("缺变量时失败并给出明确信息", async () => {
    const rec = await run(loginTrace(fx.url), { USER: "admin" });
    expect(rec.ok).toBe(false);
    expect(rec.failure?.message).toContain("PWD");
  });

  it("定位失败时标 heal_required 并带完整失败上下文", async () => {
    const t = loginTrace(fx.url);
    t.steps[3] = { action: "click", target: { descriptor: { strategies: [{ kind: "css", value: "#gone" }], framePath: [] } } };
    const rec = await run(t, { USER: "a", PWD: "b" });
    expect(rec.ok).toBe(false);
    expect(rec.healRequired).toBe(true);
    expect(rec.failure?.kind).toBe("target-not-found");
    expect(rec.failure?.snapshot).toContain("登录");
  });

  it("slowMoMs 让总耗时明显变长，但台账里不含 sleep 步骤", async () => {
    const fast = await run(loginTrace(fx.url), { USER: "a", PWD: "b" });
    const slow = await run(loginTrace(fx.url), { USER: "a", PWD: "b" }, 200);
    expect(slow.durationMs).toBeGreaterThan(fast.durationMs + 500);
    expect(slow.steps).toHaveLength(5);
    expect(slow.steps.some((s) => s.action === "sleep")).toBe(false);
  });

  it("回放耗时远低于同等步数的逐步模型往返（记录基线数字）", async () => {
    const rec = await run(loginTrace(fx.url), { USER: "a", PWD: "b" });
    // 5 步若每步一次 agent turn，按每 turn 3s 计约需 15s
    expect(rec.durationMs).toBeLessThan(15_000);
    console.log(`[基线] 5 步 replay 实测 ${rec.durationMs}ms`);
  });
});
```

- [ ] **Step 8: 运行测试确认通过（M3 核心达成）**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全绿，无类型错误

- [ ] **Step 9: 提交**

```bash
git add src/trace/replay.ts src/report/runRecord.ts src/server.ts \
        test/unit/runRecord.test.ts test/integration/replay.test.ts
git commit -m "feat: replay 引擎与 run-record，M3 零模型回放达成"
```

---

### Task 18: 改版对 fixture 与漂移告警端到端验证

**Files:**
- Create: `test/fixtures/pages/cards-v1.html`
- Create: `test/fixtures/pages/cards-v2.html`
- Test: `test/integration/drift.test.ts`

**Interfaces:**
- Consumes: `buildDescriptor`（Task 9）、`resolve`（Task 10）、`replayTrace`（Task 17）
- Produces: 无新生产代码 —— 这是对 spec §12 风险 2（trace 漂移）的直接验证

**这个任务不写生产代码，但不能省。** 它验证整个方案的核心承诺：页面改版后 trace 仍能回放，且漂移被告警出来。如果这里挂了，说明策略链设计有问题，必须回到 Task 9/10 修。

v1 与 v2 的差异是刻意设计的：

| | v1 | v2 |
|---|---|---|
| `data-testid` | 有 | **移除** |
| class 名 | `card` / `title` | `dept-block` / `dept-name` |
| DOM 层级 | 卡片直接在 `#wall` 下 | 多包一层 `.row` |
| 文本内容 | 部门名、按钮文案 | **完全保留** |

预期结果：`test-id` 策略失效 → 回退到 `container-role-name` → 仍然命中 → **漂移告警触发**。

- [ ] **Step 1: 创建 `cards-v1.html`**

```html
<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>部门卡片 v1</title></head>
<body>
  <main>
    <h1>组织一览</h1>
    <div id="wall">
      <div class="card">
        <div class="title">教育事业群</div>
        <button type="button" data-testid="detail-edu">查看在岗干部明细</button>
        <span>总人数 5081 人</span>
      </div>
      <div class="card">
        <div class="title">技术平台中心</div>
        <button type="button" data-testid="detail-tech">查看在岗干部明细</button>
        <span>总人数 0 人</span>
      </div>
    </div>
    <p id="clicked">未点击</p>
  </main>
  <script>
    document.querySelectorAll(".card button").forEach(function (b) {
      b.addEventListener("click", function (e) {
        var name = e.target.closest(".card").querySelector(".title").textContent;
        document.getElementById("clicked").textContent = name + " · " + e.target.textContent;
      });
    });
  </script>
</body></html>
```

- [ ] **Step 2: 创建 `cards-v2.html`（同语义，改版）**

```html
<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>部门卡片 v2</title></head>
<body>
  <main>
    <h1>组织一览</h1>
    <div id="wall">
      <div class="row">
        <div class="dept-block">
          <div class="dept-name">教育事业群</div>
          <button type="button">查看在岗干部明细</button>
          <span>总人数 5081 人</span>
        </div>
      </div>
      <div class="row">
        <div class="dept-block">
          <div class="dept-name">技术平台中心</div>
          <button type="button">查看在岗干部明细</button>
          <span>总人数 0 人</span>
        </div>
      </div>
    </div>
    <p id="clicked">未点击</p>
  </main>
  <script>
    document.querySelectorAll(".dept-block button").forEach(function (b) {
      b.addEventListener("click", function (e) {
        var name = e.target.closest(".dept-block").querySelector(".dept-name").textContent;
        document.getElementById("clicked").textContent = name + " · " + e.target.textContent;
      });
    });
  </script>
</body></html>
```

- [ ] **Step 3: 写漂移测试**

创建 `test/integration/drift.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import puppeteer, { type Browser } from "puppeteer";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { startFixtureServer } from "../fixtures/server.js";
import { NetworkTracker } from "../../src/waiter/stability.js";
import { DiagnosticsCollector } from "../../src/diagnostics/collector.js";
import { takeSnapshot } from "../../src/perception/snapshot.js";
import { buildDescriptor } from "../../src/locator/descriptor.js";
import { resolve } from "../../src/locator/resolve.js";
import { replayTrace } from "../../src/trace/replay.js";
import type { Descriptor, Trace } from "../../src/types.js";

let chrome: Browser, session: BrowserSession, fx: Awaited<ReturnType<typeof startFixtureServer>>;
let tracker: NetworkTracker, collector: DiagnosticsCollector;

beforeAll(async () => {
  fx = await startFixtureServer();
  chrome = await puppeteer.launch({ headless: true, args: ["--remote-debugging-port=9346", "--no-sandbox"] });
  session = await BrowserSession.connect("http://127.0.0.1:9346");
  const h = await session.getPage();
  tracker = await NetworkTracker.attach(h);
  collector = await DiagnosticsCollector.attach(h);
});
afterAll(async () => { await session?.close(); await chrome?.close(); await fx?.close(); });

async function open(path: string): Promise<PageHandle> {
  const h = await session.getPage();
  await h.page.goto(`${fx.url}/${path}`, { waitUntil: "load" });
  return h;
}

/** 在 v1 上为第二张卡的按钮建 descriptor */
async function descriptorFromV1(): Promise<Descriptor> {
  const h = await open("cards-v1.html");
  const snap = await takeSnapshot(h, { threshold: 99 });
  const line = snap.text.split("\n").filter((l) => l.includes("查看在岗干部明细"))[1];
  const ref = line.match(/\[(e\d+)\]/)![1];
  return buildDescriptor(h, snap.refs.get(ref)!);
}

describe("改版漂移", () => {
  it("v1 上首选策略是 test-id", async () => {
    expect((await descriptorFromV1()).strategies[0].kind).toBe("test-id");
  });

  it("v1 的 descriptor 在 v2 上仍能命中，但回退到了容器锚定", async () => {
    const d = await descriptorFromV1();
    const h = await open("cards-v2.html");
    const r = await resolve(h, d);
    expect(r.strategyIndex).toBeGreaterThan(0);
    expect(r.strategyKind).toBe("container-role-name");
  });

  it("命中的确实是正确的那张卡的按钮", async () => {
    const d = await descriptorFromV1();
    const trace: Trace = {
      name: "drift-check", baseUrl: fx.url, createdAt: "2026-09-11T00:00:00.000Z",
      steps: [
        { action: "navigate", url: "/cards-v2.html" },
        { action: "click", target: { descriptor: d } },
        { action: "assert", type: "text-equals",
          target: { descriptor: { strategies: [{ kind: "css", value: "#clicked" }], framePath: [] } },
          expected: "技术平台中心 · 查看在岗干部明细" }
      ]
    };
    const rec = await replayTrace({
      handle: await session.getPage(), tracker, collector, trace, vars: {}
    });
    expect(rec.ok).toBe(true);
  });

  it("回放成功但 run-record 里有漂移告警", async () => {
    const d = await descriptorFromV1();
    const trace: Trace = {
      name: "drift-warn", baseUrl: fx.url, createdAt: "2026-09-11T00:00:00.000Z",
      steps: [
        { action: "navigate", url: "/cards-v2.html" },
        { action: "click", target: { descriptor: d } }
      ]
    };
    const rec = await replayTrace({
      handle: await session.getPage(), tracker, collector, trace, vars: {}
    });
    expect(rec.ok).toBe(true);
    expect(rec.drifts.length).toBeGreaterThan(0);
    expect(rec.drifts[0].expected).toBe("test-id");
    expect(rec.drifts[0].actual).toBe("container-role-name");
  });

  it("在原版 v1 上回放不产生漂移告警", async () => {
    const d = await descriptorFromV1();
    const trace: Trace = {
      name: "no-drift", baseUrl: fx.url, createdAt: "2026-09-11T00:00:00.000Z",
      steps: [
        { action: "navigate", url: "/cards-v1.html" },
        { action: "click", target: { descriptor: d } }
      ]
    };
    const rec = await replayTrace({
      handle: await session.getPage(), tracker, collector, trace, vars: {}
    });
    expect(rec.ok).toBe(true);
    expect(rec.drifts).toHaveLength(0);
  });
});
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/integration/drift.test.ts`
Expected: PASS，5 个用例全绿

> 如果第 2 个用例失败（v2 上没命中或命中了错误的卡），**不要改测试去迁就实现**——这说明 Task 9 的策略排序或 Task 10 的锚定收敛有 bug，回去修生产代码。这个测试是整个方案的核心承诺。

- [ ] **Step 5: 提交**

```bash
git add test/fixtures/pages/cards-v1.html test/fixtures/pages/cards-v2.html \
        test/integration/drift.test.ts
git commit -m "test: 改版对 fixture 与漂移告警端到端验证"
```

---

### Task 19: iframe 穿透（感知与定位）

**Files:**
- Create: `src/session/frames.ts`
- Modify: `src/perception/axtree.ts`（`fetchAxTree` 支持按 frame 抓取）
- Modify: `src/perception/snapshot.ts`（合并各 frame 的子树）
- Modify: `src/locator/descriptor.ts`（记录 `framePath`）
- Modify: `src/locator/resolve.ts`（按 `framePath` 确定查询 scope）
- Test: `test/integration/iframe.test.ts`

**Interfaces:**
- Consumes: `fetchAxTree`/`buildTree`（Task 4）、`prune`（Task 5）、`resolve`（Task 10）
- Produces:
  - `async function listFrames(handle: PageHandle): Promise<FrameInfo[]>`
  - `interface FrameInfo { frameId: string; key: string; url: string; documentNodeId: number }` —— `key` 取 url 最后一段路径，是 `framePath` 里使用的标识
  - `async function scopeNodeId(handle: PageHandle, framePath: string[]): Promise<number>` —— 空路径返回主文档 nodeId

**这是 spec §6.6 的实现。** `Descriptor.framePath` 字段从 Task 1 就存在，但在此之前所有代码路径都只传空数组——业务系统里嵌 iframe 很常见，不支持就等于这些页面整块不可测。

一期范围：完整支持同进程 iframe。跨进程 iframe（OOPIF）需要独立 CDP session，不在一期。

- [ ] **Step 1: 写失败的集成测试**

创建 `test/integration/iframe.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import puppeteer, { type Browser } from "puppeteer";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { startFixtureServer } from "../fixtures/server.js";
import { NetworkTracker } from "../../src/waiter/stability.js";
import { DiagnosticsCollector } from "../../src/diagnostics/collector.js";
import { listFrames, scopeNodeId } from "../../src/session/frames.js";
import { takeSnapshot } from "../../src/perception/snapshot.js";
import { buildDescriptor } from "../../src/locator/descriptor.js";
import { runBatch } from "../../src/executor/batch.js";

let chrome: Browser, session: BrowserSession, fx: Awaited<ReturnType<typeof startFixtureServer>>;
let tracker: NetworkTracker, collector: DiagnosticsCollector;

beforeAll(async () => {
  fx = await startFixtureServer();
  chrome = await puppeteer.launch({ headless: true, args: ["--remote-debugging-port=9348", "--no-sandbox"] });
  session = await BrowserSession.connect("http://127.0.0.1:9348");
  const h = await session.getPage();
  tracker = await NetworkTracker.attach(h);
  collector = await DiagnosticsCollector.attach(h);
});
afterAll(async () => { await session?.close(); await chrome?.close(); await fx?.close(); });

async function open(): Promise<PageHandle> {
  const h = await session.getPage();
  await h.page.goto(`${fx.url}/modal-iframe.html`, { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 300)); // 等 iframe 内文档就绪
  return h;
}

describe("listFrames", () => {
  it("列出主 frame 与内嵌 frame", async () => {
    const frames = await listFrames(await open());
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(frames.map((f) => f.key)).toContain("iframe-inner.html");
  });

  it("每个 frame 都带可用的 documentNodeId", async () => {
    const frames = await listFrames(await open());
    for (const f of frames) expect(f.documentNodeId).toBeGreaterThan(0);
  });
});

describe("scopeNodeId", () => {
  it("空 framePath 返回主文档", async () => {
    const h = await open();
    expect(await scopeNodeId(h, [])).toBeGreaterThan(0);
  });

  it("未知 frame key 抛出明确错误", async () => {
    const h = await open();
    await expect(scopeNodeId(h, ["不存在.html"])).rejects.toThrow(/不存在\.html/);
  });
});

describe("跨 frame 感知与操作", () => {
  it("快照包含 iframe 内的元素，并标出所属 frame", async () => {
    const snap = await takeSnapshot(await open());
    expect(snap.text).toContain("iframe-inner.html");
    expect(snap.text).toContain("备注");
    expect(snap.text).toContain("确认");
  });

  it("为 iframe 内元素生成的 descriptor 带 framePath", async () => {
    const h = await open();
    const snap = await takeSnapshot(h, { threshold: 99 });
    const ref = snap.text.split("\n").find((l) => l.includes('"确认"'))!.match(/\[(e\d+)\]/)![1];
    const d = await buildDescriptor(h, snap.refs.get(ref)!);
    expect(d.framePath).toEqual(["iframe-inner.html"]);
  });

  it("能 fill 并 click iframe 内的元素", async () => {
    const h = await open();
    const r = await runBatch({
      handle: h, tracker, collector, refs: new Map(), vars: {},
      steps: [
        { action: "fill", target: { descriptor: {
          strategies: [{ kind: "css", value: "#note" }], framePath: ["iframe-inner.html"]
        }}, value: "内嵌备注" },
        { action: "click", target: { descriptor: {
          strategies: [{ kind: "role-name", role: "button", name: "确认" }],
          framePath: ["iframe-inner.html"]
        }}}
      ]
    });
    expect(r.ok).toBe(true);

    const { result } = await h.cdp.send("Runtime.evaluate", {
      expression: `document.getElementById("inner").contentDocument.getElementById("note").value`,
      returnByValue: true
    });
    expect((result as { value: string }).value).toBe("内嵌备注");
  });

  it("主文档的同名查找不会误命中 iframe 内的元素", async () => {
    const h = await open();
    const r = await runBatch({
      handle: h, tracker, collector, refs: new Map(), vars: {},
      steps: [{ action: "click", target: { descriptor: {
        strategies: [{ kind: "role-name", role: "button", name: "确认" }], framePath: []
      }}}]
    });
    expect(r.ok).toBe(false);
    expect(r.failure?.kind).toBe("target-not-found");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/integration/iframe.test.ts`
Expected: FAIL —— 无法解析 `src/session/frames.js`

- [ ] **Step 3: 实现 `src/session/frames.ts`**

```ts
import type { PageHandle } from "./browser.js";

export interface FrameInfo {
  frameId: string;
  key: string;
  url: string;
  documentNodeId: number;
}

interface FrameTreeNode {
  frame: { id: string; url: string };
  childFrames?: FrameTreeNode[];
}

/** frame 标识：取 url 最后一段路径，业务上比 frameId 稳定（frameId 每次加载都变） */
export function frameKey(url: string): string {
  const path = url.split("?")[0].split("#")[0];
  const last = path.split("/").filter(Boolean).pop();
  return last ?? url;
}

export async function listFrames(handle: PageHandle): Promise<FrameInfo[]> {
  await handle.cdp.send("Page.enable");
  const { frameTree } = (await handle.cdp.send("Page.getFrameTree")) as {
    frameTree: FrameTreeNode;
  };

  const flat: Array<{ frameId: string; url: string }> = [];
  const walk = (n: FrameTreeNode): void => {
    flat.push({ frameId: n.frame.id, url: n.frame.url });
    for (const c of n.childFrames ?? []) walk(c);
  };
  walk(frameTree);

  // pierce 让 getDocument 把子 frame 的 contentDocument 一并带出来
  const { root } = (await handle.cdp.send("DOM.getDocument", { depth: -1, pierce: true })) as {
    root: { nodeId: number; frameId?: string; children?: unknown[] };
  };

  const docByFrame = new Map<string, number>();
  const collect = (node: unknown): void => {
    const n = node as {
      nodeId: number; nodeName?: string; frameId?: string;
      contentDocument?: { nodeId: number; frameId?: string };
      children?: unknown[];
    };
    if (n.nodeName === "#document" && n.frameId) docByFrame.set(n.frameId, n.nodeId);
    if (n.contentDocument?.frameId) {
      docByFrame.set(n.contentDocument.frameId, n.contentDocument.nodeId);
      collect(n.contentDocument);
    }
    for (const c of n.children ?? []) collect(c);
  };
  collect(root);
  if (root.frameId) docByFrame.set(root.frameId, root.nodeId);

  return flat
    .filter((f) => docByFrame.has(f.frameId))
    .map((f) => ({
      frameId: f.frameId,
      key: frameKey(f.url),
      url: f.url,
      documentNodeId: docByFrame.get(f.frameId)!
    }));
}

export async function scopeNodeId(handle: PageHandle, framePath: string[]): Promise<number> {
  const frames = await listFrames(handle);
  if (framePath.length === 0) {
    const main = frames[0];
    if (!main) throw new Error("找不到主文档 frame");
    return main.documentNodeId;
  }
  // 一期只支持一层嵌套：取路径最后一段做查找
  const key = framePath[framePath.length - 1];
  const hit = frames.find((f) => f.key === key);
  if (!hit) {
    throw new Error(
      `找不到 frame「${key}」。当前页面的 frame 有：${frames.map((f) => f.key).join("、")}`
    );
  }
  return hit.documentNodeId;
}

/** 反查某个元素属于哪个 frame，用于生成 descriptor 的 framePath */
export async function framePathOf(
  handle: PageHandle,
  backendNodeId: number
): Promise<string[]> {
  const { nodeIds } = (await handle.cdp.send("DOM.pushNodesByBackendIdsToFrontend", {
    backendNodeIds: [backendNodeId]
  })) as { nodeIds: number[] };
  if (!nodeIds[0]) return [];

  const { node } = (await handle.cdp.send("DOM.describeNode", { nodeId: nodeIds[0] })) as {
    node: { frameId?: string };
  };
  if (!node.frameId) return [];

  const frames = await listFrames(handle);
  if (frames[0]?.frameId === node.frameId) return [];
  const hit = frames.find((f) => f.frameId === node.frameId);
  return hit ? [hit.key] : [];
}
```

- [ ] **Step 4: 让 `fetchAxTree` 支持按 frame 抓取，并让 `snapshot.ts` 合并各 frame 的子树**

先改 `src/perception/axtree.ts`，让 CDP 调用仍然只有这一处：

```ts
export async function fetchAxTree(cdp: CDPSession, frameId?: string): Promise<RawAxNode[]> {
  const { nodes } = (await cdp.send(
    "Accessibility.getFullAXTree",
    frameId ? { frameId } : {}
  )) as { nodes: RawAxNode[] };
  return nodes;
}
```

Task 4 的现有测试不传 `frameId`，行为不变，应继续通过。

再在 `src/perception/snapshot.ts` 顶部补 `import { listFrames } from "../session/frames.js";`，把 `takeSnapshot` 改为遍历所有 frame：

```ts
export async function takeSnapshot(
  handle: PageHandle,
  opts: SnapshotOptions = {}
): Promise<SnapshotResult> {
  const frames = await listFrames(handle);
  const mainFrameId = frames[0]?.frameId;

  let rawTotal = 0;
  const merged: PrunedNode = {
    role: "RootWebArea", name: "", props: {}, children: []
  };

  for (const f of frames) {
    const raw = await fetchAxTree(handle.cdp, f.frameId);
    rawTotal += raw.length;

    const root = buildTree(raw);
    if (!root) continue;
    const pruned = prune(raw, root.nodeId);
    if (!pruned) continue;

    if (f.frameId === mainFrameId) {
      merged.children.push(...pruned.children);
    } else {
      // 子 frame 的内容包一层，让模型看得到归属
      merged.children.push({
        role: "iframe", name: f.key, props: { frame: f.key },
        children: pruned.children
      });
    }
  }

  const collapsed = collapse(merged, { threshold: opts.threshold, expand: opts.expand });
  const { text, refs } = render(collapsed);

  let prunedCount = 0;
  let groupCount = 0;
  const count = (n: unknown): void => {
    const node = n as { kind?: string; children?: unknown[] };
    if (node.kind === "collapsed-group") { groupCount++; return; }
    prunedCount++;
    for (const c of node.children ?? []) count(c);
  };
  for (const c of collapsed.children) count(c);

  return { text, refs, stats: { rawNodes: rawTotal, prunedNodes: prunedCount, collapsedGroups: groupCount } };
}
```

顶部相应补 `import type { PrunedNode, SnapshotResult } from "../types.js";`，`fetchAxTree` 与 `buildTree` 的 import 保持不变。

- [ ] **Step 5: 让 `descriptor.ts` 记录 framePath**

在 `src/locator/descriptor.ts` 顶部补 `import { framePathOf } from "../session/frames.js";`，把 `buildDescriptor` 的并行取值和返回改成：

```ts
  const [info, ax, anchor, framePath] = await Promise.all([
    domInfo(handle, backendNodeId),
    axOf(handle, backendNodeId),
    findAnchor(handle, backendNodeId),
    framePathOf(handle, backendNodeId)
  ]);
```

```ts
  return { strategies, framePath, distinguishers: anchor?.distinguishers };
```

- [ ] **Step 6: 让 `resolve.ts` 按 framePath 确定查询 scope**

在 `src/locator/resolve.ts` 顶部补 `import { scopeNodeId } from "../session/frames.js";`。

把 `documentNodeId` 的调用点全部换成按 framePath 取 scope——给 `tryStrategy` 加第三个参数：

```ts
async function tryStrategy(
  handle: PageHandle,
  s: Strategy,
  scope: number
): Promise<number | null> {
```

函数体内：`bySelector` 改为接收 scope；`case "role-name"` 用 `byAx(handle, scope, ...)` 取代 `documentNodeId`；`case "text"` 的 `DOM.querySelectorAll` 用 `nodeId: scope`；`byAnchor` 内部的 `documentNodeId(handle)` 也改成传入的 scope。

`bySelector` 签名改为：

```ts
async function bySelector(handle: PageHandle, scope: number, selector: string): Promise<number | null> {
  const { nodeIds } = (await handle.cdp.send("DOM.querySelectorAll", {
    nodeId: scope,
    selector
  })) as { nodeIds: number[] };
  if (nodeIds.length !== 1) return null;
  return backendIdOfNodeId(handle, nodeIds[0]);
}
```

`byAnchor` 签名加 scope 参数，内部 `const doc = await documentNodeId(handle);` 改为直接用传入的 `scope`。

`resolve` 顶部先算一次 scope：

```ts
export async function resolve(handle: PageHandle, d: Descriptor): Promise<ResolveResult> {
  const scope = await scopeNodeId(handle, d.framePath);
  const tried: string[] = [];
  for (let i = 0; i < d.strategies.length; i++) {
    const s = d.strategies[i];
    let id: number | null = null;
    try {
      id = await tryStrategy(handle, s, scope);
    } catch {
      id = null;
    }
    if (id !== null) return { backendNodeId: id, strategyIndex: i, strategyKind: s.kind };
    tried.push(s.kind);
  }
  throw new LocatorError(
    `全部 ${d.strategies.length} 条策略均未唯一命中：${tried.join(" → ")}`,
    "target-not-found",
    d.distinguishers ?? []
  );
}
```

`documentNodeId` 函数保留（`xpath` 分支的 `DOM.getDocument` 仍需要它触发文档加载），但不再被其他分支调用。

> `xpath` 策略的 `DOM.performSearch` 是全文档搜索，无法限定在 frame 内。这是一期的已知限制：**iframe 内元素的 xpath 兜底可能误命中主文档的同结构元素**。因为 xpath 是最后一条兜底策略、且前面 6 条在 frame 内已经限定正确，实际影响很小。README 的「已知边界」要记这一条。

- [ ] **Step 7: 运行全部测试确认通过**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全绿，无类型错误

> 若 `listFrames` 在 headless 下取不到 `contentDocument`，检查 `DOM.getDocument` 是否传了 `pierce: true`——不传 pierce 时子 frame 的文档节点不会出现在返回树里。

- [ ] **Step 8: 提交**

```bash
git add src/session/frames.ts src/perception/snapshot.ts src/locator/descriptor.ts \
        src/locator/resolve.ts test/integration/iframe.test.ts
git commit -m "feat: iframe 穿透，快照与定位支持 framePath"
```

---

### Task 20: MCP 接入文档与基准测试

**Files:**
- Create: `README.md`
- Create: `test/bench/run.ts`
- Modify: `package.json`（加 `bench` 脚本）
- Test: `test/integration/bench.test.ts`

**Interfaces:**
- Consumes: `replayTrace`（Task 17）、`takeSnapshot`（Task 7）、`runBatch`（Task 15）
- Produces:
  - `async function runBench(opts: BenchOptions): Promise<BenchReport>`
  - `interface BenchOptions { handle; tracker; collector; trace: Trace; vars: Record<string,string>; rounds?: number }`（rounds 默认 5）
  - `interface BenchReport { steps: number; turnsA: number; turnsB: number; turnsC: number; medianBMs: number; medianCMs: number; markdown: string }`
  - `npm run bench -- <tracePath>`

**基准口径（spec §11.3）**：

- **A 现状**：每步一次 agent turn → turn 数 = 步数。耗时**无法脚本测量**（需要真实模型往返），报告里留空栏由人工填入实测值。
- **B 探索模式**：`snapshot` + `batch` 交替 → turn 数按每批 5 步估算 = `ceil(steps/5) × 2`。
- **C 回放模式**：1 次 `replay` 调用 → turn 数 = 1。

脚本实测 B 和 C 的耗时，取 `rounds` 轮中位数。

- [ ] **Step 1: 写失败的 bench 测试**

创建 `test/integration/bench.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import puppeteer, { type Browser } from "puppeteer";
import { BrowserSession } from "../../src/session/browser.js";
import { startFixtureServer } from "../fixtures/server.js";
import { NetworkTracker } from "../../src/waiter/stability.js";
import { DiagnosticsCollector } from "../../src/diagnostics/collector.js";
import { runBench } from "../bench/run.js";
import type { Trace } from "../../src/types.js";

let chrome: Browser, session: BrowserSession, fx: Awaited<ReturnType<typeof startFixtureServer>>;
let tracker: NetworkTracker, collector: DiagnosticsCollector;

beforeAll(async () => {
  fx = await startFixtureServer();
  chrome = await puppeteer.launch({ headless: true, args: ["--remote-debugging-port=9347", "--no-sandbox"] });
  session = await BrowserSession.connect("http://127.0.0.1:9347");
  const h = await session.getPage();
  tracker = await NetworkTracker.attach(h);
  collector = await DiagnosticsCollector.attach(h);
});
afterAll(async () => { await session?.close(); await chrome?.close(); await fx?.close(); });

function trace(baseUrl: string): Trace {
  const css = (value: string) => ({ descriptor: { strategies: [{ kind: "css" as const, value }], framePath: [] } });
  return {
    name: "bench-login", baseUrl, createdAt: "2026-09-11T00:00:00.000Z",
    steps: [
      { action: "navigate", url: "/form.html" },
      { action: "fill", target: css("#user"), value: "admin" },
      { action: "fill", target: css("#pwd"), value: "x" },
      { action: "click", target: css("#submit") },
      { action: "assert", type: "text-contains", target: css("#result"), expected: "欢迎" }
    ]
  };
}

describe("runBench", () => {
  it("turn 数按口径正确计算：A=步数，B=ceil(N/5)×2，C=1", async () => {
    const r = await runBench({
      handle: await session.getPage(), tracker, collector, trace: trace(fx.url), vars: {}, rounds: 2
    });
    expect(r.steps).toBe(5);
    expect(r.turnsA).toBe(5);
    expect(r.turnsB).toBe(2);
    expect(r.turnsC).toBe(1);
  });

  it("实测出 B 和 C 的中位耗时", async () => {
    const r = await runBench({
      handle: await session.getPage(), tracker, collector, trace: trace(fx.url), vars: {}, rounds: 2
    });
    expect(r.medianBMs).toBeGreaterThan(0);
    expect(r.medianCMs).toBeGreaterThan(0);
  });

  it("报告是 markdown，含三行对照与待人工填写的 A 耗时栏", async () => {
    const r = await runBench({
      handle: await session.getPage(), tracker, collector, trace: trace(fx.url), vars: {}, rounds: 2
    });
    expect(r.markdown).toContain("| A ");
    expect(r.markdown).toContain("| B ");
    expect(r.markdown).toContain("| C ");
    expect(r.markdown).toContain("待人工填写");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/integration/bench.test.ts`
Expected: FAIL —— 无法解析 `../bench/run.js`

- [ ] **Step 3: 实现 `test/bench/run.ts`**

```ts
import type { PageHandle } from "../../src/session/browser.js";
import type { NetworkTracker } from "../../src/waiter/stability.js";
import type { DiagnosticsCollector } from "../../src/diagnostics/collector.js";
import type { Trace } from "../../src/types.js";
import { replayTrace } from "../../src/trace/replay.js";
import { runBatch } from "../../src/executor/batch.js";
import { takeSnapshot } from "../../src/perception/snapshot.js";

export interface BenchOptions {
  handle: PageHandle;
  tracker: NetworkTracker;
  collector: DiagnosticsCollector;
  trace: Trace;
  vars: Record<string, string>;
  rounds?: number;
}

export interface BenchReport {
  steps: number;
  turnsA: number;
  turnsB: number;
  turnsC: number;
  medianBMs: number;
  medianCMs: number;
  markdown: string;
}

const BATCH_SIZE = 5;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** B：探索模式——每 BATCH_SIZE 步一次 batch，每批前先 snapshot */
async function runModeB(o: BenchOptions): Promise<number> {
  const t0 = Date.now();
  const steps = o.trace.steps;
  for (let i = 0; i < steps.length; i += BATCH_SIZE) {
    await takeSnapshot(o.handle);
    await runBatch({
      handle: o.handle, tracker: o.tracker, collector: o.collector,
      refs: new Map(), vars: o.vars,
      steps: steps.slice(i, i + BATCH_SIZE),
      captureDescriptors: false
    });
  }
  return Date.now() - t0;
}

export async function runBench(o: BenchOptions): Promise<BenchReport> {
  const rounds = o.rounds ?? 5;
  const steps = o.trace.steps.length;

  const bTimes: number[] = [];
  const cTimes: number[] = [];
  for (let i = 0; i < rounds; i++) {
    bTimes.push(await runModeB(o));
    const rec = await replayTrace({ ...o, trace: o.trace });
    cTimes.push(rec.durationMs);
  }

  const medianBMs = median(bTimes);
  const medianCMs = median(cTimes);
  const turnsA = steps;
  const turnsB = Math.ceil(steps / BATCH_SIZE) * 2;
  const turnsC = 1;

  const markdown = [
    `# 基准测试 — ${o.trace.name}`,
    "",
    `步骤数 ${steps} · 轮次 ${rounds}（取中位数）`,
    "",
    "| 方式 | 说明 | agent turn 数 | 实测耗时 |",
    "|---|---|---|---|",
    `| A | 现状：每步一次模型往返 | ${turnsA} | 待人工填写 |`,
    `| B | 探索模式：snapshot + batch 交替 | ${turnsB} | ${medianBMs}ms |`,
    `| C | 回放模式：一次 replay，零模型 | ${turnsC} | ${medianCMs}ms |`,
    "",
    `**turn 数下降**：A→B 减少 ${turnsA - turnsB} 次（${Math.round((1 - turnsB / turnsA) * 100)}%），` +
      `A→C 减少 ${turnsA - turnsC} 次（${Math.round((1 - turnsC / turnsA) * 100)}%）`,
    "",
    "> A 的耗时脚本测不了——它取决于真实模型往返速度。请用现状链路手动跑一次同样的用例，",
    "> 记录墙钟时间填进上表，才能得到完整的提速倍数。"
  ].join("\n");

  return { steps, turnsA, turnsB, turnsC, medianBMs, medianCMs, markdown };
}
```

- [ ] **Step 4: 加 `bench` 脚本入口**

在 `test/bench/run.ts` 末尾追加 CLI 入口：

```ts
// 直接执行时作为 CLI 运行：npm run bench -- ./traces/smoke.json
if (process.argv[1]?.endsWith("run.ts") || process.argv[1]?.endsWith("run.js")) {
  const tracePath = process.argv[2];
  if (!tracePath) {
    console.error("用法：npm run bench -- <tracePath>");
    process.exit(1);
  }
  const { BrowserSession } = await import("../../src/session/browser.js");
  const { NetworkTracker } = await import("../../src/waiter/stability.js");
  const { DiagnosticsCollector } = await import("../../src/diagnostics/collector.js");
  const { loadTrace } = await import("../../src/trace/store.js");

  const session = await BrowserSession.connect(process.env.CUQ_BROWSER_URL ?? "http://127.0.0.1:9222");
  const handle = await session.getPage();
  const report = await runBench({
    handle,
    tracker: await NetworkTracker.attach(handle),
    collector: await DiagnosticsCollector.attach(handle),
    trace: await loadTrace(tracePath),
    vars: process.env as Record<string, string>
  });
  console.log(report.markdown);
  await session.close();
}
```

在 `package.json` 的 `scripts` 里加：

```json
    "bench": "node --experimental-strip-types test/bench/run.ts"
```

- [ ] **Step 5: 创建 `README.md`**

````markdown
# computer-use-quick

Web 端到端测试的 MCP 控制层。把「每步一次模型往返」换成「batch 压缩 + 零模型回放」。

设计文档：`docs/superpowers/specs/2026-09-11-computer-use-quick-design.md`

## 安装与构建

```bash
npm install
npm run build
```

## 启动被测浏览器

服务端不自己启浏览器，而是连接一个已开调试端口的 Chrome：

```bash
# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222

# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

## 接入 Claude Code

在 `.mcp.json` 或 `~/.claude.json` 里加：

```json
{
  "mcpServers": {
    "computer-use-quick": {
      "command": "node",
      "args": ["<仓库绝对路径>/dist/index.js"],
      "env": { "CUQ_BROWSER_URL": "http://127.0.0.1:9222" }
    }
  }
}
```

## 五个工具

| 工具 | 什么时候用 |
|---|---|
| `snapshot` | 看当前页面有什么。替代截图。同构结构会被折叠，用 `expand` 展开 |
| `batch` | 执行一串动作。**不要一次只传一步**——那样就退回到慢的老路了 |
| `save_trace` | 探索完，把成功的步骤固化成可回放用例 |
| `replay` | 跑已有用例。CI 回归用这个，全程不调模型 |
| `inspect` | 只在排查失败时用。取截图/console/网络 |

## 三种用法

**探索式测试**：`snapshot` 看页面 → `batch` 执行一批 → 再 `snapshot` 确认 → 循环。

**固化**：探索通过后 `save_trace`，得到一个 JSON 文件，用 git 管起来。

**回归**：`replay` 传 trace 路径。凭证通过 `vars` 或环境变量注入，**绝不写进 trace**。

## 基准测试

```bash
npm run bench -- ./traces/smoke-login.json
```

输出 A/B/C 三种方式的 turn 数与耗时对照。A（现状每步一次模型往返）的耗时需要人工跑一次填入。

## 已知边界（一期）

- 只支持 Web。桌面端在三期，感知层已留可插拔接口。
- 回放失败时只报告 `heal_required`，不自动修复（二期）。
- 串行单浏览器，多用例并行在二期。
- `wait` 的 `response` 条件用「网络静默」近似，不做 urlPattern 精确匹配。
- iframe：支持同进程 iframe 的感知与定位；跨进程 iframe（OOPIF）不支持。
- iframe 内元素的 `xpath` 兜底策略是全文档搜索，理论上可能误命中主文档的同结构元素。
  前 6 条策略都已限定在 frame 内，实际影响很小。
````

- [ ] **Step 6: 运行全部测试确认通过**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: 测试全绿、无类型错误、构建产出 `dist/`

- [ ] **Step 7: 提交（一期完成）**

```bash
git add README.md test/bench/run.ts test/integration/bench.test.ts package.json
git commit -m "feat: MCP 接入文档与 A/B/C 基准测试，一期完成"
```

---

## 完成标准

一期做完时，下面每一条都应该为真：

- [ ] `npx vitest run` 全绿，`npx tsc --noEmit` 无错误
- [ ] `npm run build` 产出可执行的 `dist/index.js`
- [ ] 按 README 接入 Claude Code 后，5 个工具都能在会话里调用
- [ ] 一条 5 步登录流程可以用**一次** `batch` 调用完成
- [ ] `save_trace` 产出的 JSON 里没有任何 `"ref"`，凭证全是 `${VAR}`
- [ ] `replay` 一次调用跑完整条用例，产出逐步耗时台账
- [ ] cards-v1 上建的 descriptor 能在 cards-v2 上命中，且 run-record 报出漂移告警
- [ ] iframe 内的元素能出现在快照里，并能被 `batch` 正常 fill/click
- [ ] `npm run bench` 输出 turn 数对照表与 B/C 实测耗时
- [ ] 拿靶场 `AI-ORG-TALENT-SANDBOX`（`http://localhost:3040`）的一条真实冒烟用例跑一遍 benchmark，填入 A 的人工实测值，得到真实提速倍数
