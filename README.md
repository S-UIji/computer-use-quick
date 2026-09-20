# computer-use-quick

Web 端到端测试的 MCP 控制层。把「每步一次模型往返」换成「batch 压缩 + 零模型回放」。

设计文档：[`docs/superpowers/specs/2026-09-11-computer-use-quick-design.md`](docs/superpowers/specs/2026-09-11-computer-use-quick-design.md)

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

## 工具

| 工具 | 什么时候用 |
|---|---|
| `snapshot` | 看当前页面有什么。替代截图。结构相同的兄弟节点会折叠，用 `expand` 展开 |
| `batch` | 执行一串动作。**不要一次只传一步**——那样就退回到慢的老路了 |
| `list_pages` | 列出所有标签页的 pageId。点了会开新标签的链接后用 |
| `discard_steps` | 探索走了弯路时，丢弃已记录的步骤（最近 N 步或全部），再 `save_trace` |
| `save_trace` | 探索完，把成功的步骤固化成可回放用例 |
| `replay` | 跑已有用例。CI 回归用这个，全程不调模型 |
| `inspect` | 只在排查失败时用。取截图/console/网络 |

## 三种用法

**探索式测试**：`snapshot` 看页面 → `batch` 执行一批 → 再 `snapshot` 确认 → 循环。

**固化**：探索通过后 `save_trace`，得到一个 JSON 文件，用 git 管起来。

**回归**：`replay` 传 trace 路径。凭证通过 `vars` 或环境变量注入，**绝不写进 trace**——
写了明文，`save_trace` 会直接拒绝保存。

## 快照长什么样

结构相同的重复单元会被折叠，只列出各项的区别性内容：

```
[e1] heading "组织一览" level=1
[3 项结构相同，展开用 expand=["g1s8g68e"]，字段：查看在岗干部明细/负责人治理]
  1. 教育事业群 · 总人数 5081 人
  2. 技术平台中心 · 总人数 0 人
  3. 人力资源中心 · 总人数 0 人
```

组内元素没有 ref，但**不需要先 expand** 就能操作——直接用容器锚定：

```json
{"kind":"container-role-name","containerText":"教育事业群",
 "role":"button","name":"查看在岗干部明细"}
```

## 定位是怎么做到稳的

`save_trace` 时为每个被操作的元素生成一条**多策略**描述符，回放时按序尝试，
第一个唯一命中的胜出：

| 优先级 | 策略 |
|---|---|
| 1 | `data-testid` |
| 2 | 容器锚定 role+name（`卡片(含"教育事业群") › button "查看在岗干部明细"`） |
| 3 | 行锚定（表格专用） |
| 4 | 全页唯一的 role+name |
| 5 | 可见文本 + tag |
| 6 | css |
| 7 | xpath（兜底） |

回放时会记录**实际命中的是第几条**。如果首选策略失效、退到后面才命中，
run-record 里会出**漂移告警**——回放不算失败，但这是页面改版的预警信号。

## 基准测试

```bash
npm run bench -- ./traces/smoke-login.json
```

自动输出 A/B/C 三种方式的 turn 数与实测工具耗时对照。模型思考时间未计入——
实际提速取决于模型往返速度（设计文档估算 3-10s/turn）。

## 已知边界（一期）

- 只支持 Web。桌面端在三期，感知层已留可插拔接口。
- 回放失败时只报告 `heal_required`，不自动修复（二期）。
- 串行单浏览器，多用例并行在二期。
- **隐式等待检测不到纯 `setTimeout` 触发的更新**——那种情况页面上不存在任何在途信号，
  必须用显式 `wait`。带网络请求的异步更新则能正常等到。
- 隐式等待的网络在途信号只统计 XHR/Fetch/Document/Script/Stylesheet，
  信标/图片类请求不拖住等待；单个请求超过 10s 视为长轮询或僵尸，不再阻塞。
  打满 timeoutMs 上限的步骤会在结果里带告警。
- `wait` 的 `response` 条件用「网络静默」近似，不做 urlPattern 精确匹配。
- iframe：支持同进程 iframe 的感知、css/role-name 定位与操作；跨进程 iframe（OOPIF）不支持。
- iframe 内**不支持容器锚定和文本策略**——这两者依赖在主 frame 执行 JS 打标记，
  够不到子文档。iframe 内请用 css 或 role-name。
- `xpath` 兜底策略是全文档搜索，对 iframe 内元素理论上可能误命中主文档的同结构元素。
- **click 对被 CSS 隐藏/覆盖的元素自动兜底**：先做 hit-test（`elementFromPoint`），
  若目标元素不在点击坐标（被覆盖 div 替代或 `opacity:0` 隐藏），在 CDP 鼠标事件之后
  补一个 `dispatchEvent(MouseEvent('click'))` 直达目标元素，避免双击副作用。

## 开发

```bash
npm test                  # 先 tsc 构建再跑全部（26 个文件 / 185 个测试）
npm run test:unit         # 纯函数单测，毫秒级
npm run test:integration  # 需真实 Chrome
```

`test/integration/mcp-server.test.ts` 会把 `dist/index.js` 作为真实 MCP server
拉起来走 stdio 协议对话——这是唯一覆盖工具注册与返回格式的测试，所以 `npm test`
会先 `tsc`，免得拿旧产物测出假绿。

集成测试通过 vitest `globalSetup` **全套件共享一个 Chrome 实例**。
不要在测试文件里各自 `puppeteer.launch()`——那样会有 N 次收尾，
而 puppeteer 的 `browser.close()` 会偶发挂死，把整个文件拖成 hook timeout。
