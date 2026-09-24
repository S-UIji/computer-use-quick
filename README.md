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
| `snapshot` | 看当前页面有什么。替代截图。结构相同的兄弟节点会折叠，用 `expand` 展开；`diff: true` 只看与上次快照的变化（新增/消失行，新元素带 ref） |
| `batch` | 执行一串动作。**不要一次只传一步**——那样就退回到慢的老路了 |
| `list_pages` | 列出所有标签页的 pageId。点了会开新标签的链接后用 |
| `discard_steps` | 探索走了弯路时，丢弃已记录的步骤（最近 N 步或全部），再 `save_trace` |
| `save_trace` | 探索完，把成功的步骤固化成可回放用例 |
| `replay` | 跑已有用例。CI 回归用这个，全程不调模型 |
| `replay_suite` | 并行回放多条 trace：每条独立 BrowserContext（零共享 cookie），跑完全部再汇总；失败上下文可直接接 `heal_step`。`concurrency` 默认 3、上限 8 |
| `heal_step` | 回放失败后的自愈：演示修正步 → 独立 Context 全量重放验证 → 全绿才写回 trace。`assert-failed` 服务端拒修（可能是真 bug） |
| `inspect` | 只在排查失败时用。取截图/console/网络 |

## 三种用法

**探索式测试**：`snapshot` 看页面 → `batch` 执行一批 → 再 `snapshot` 确认 → 循环。

**固化**：探索通过后 `save_trace`，得到一个 JSON 文件，用 git 管起来。
写 trace 时给每个意图步配断言（自愈验证门的语义天花板），配方见
[`docs/trace-authoring.md`](docs/trace-authoring.md)。

**回归**：`replay` 传 trace 路径。凭证通过 `vars` 或环境变量注入，**绝不写进 trace**——
写了明文，`save_trace` 会直接拒绝保存。

**自愈**：replay 返回 `heal_required` 后，用 `snapshot`/`batch` 在失败页面上找到正确操作，
调 `heal_step` 演示修正步——服务端捕获描述符、新标签页全量重放验证，全绿才原子写回，
heal 历史留在 `<trace>.heal.jsonl` 供审计。只修定位类失败（找不到/歧义/超时），
断言失败会被拒绝：那可能是被测系统的真 bug。同一步最多 2 次尝试、一轮最多 3 处，
超出转人工。

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

### 实测基线（2026-09-22，smoke-login 11 步，5 轮取中位数）

| 方式 | agent turn 数 | 工具侧实测 | 含模型往返估算* |
|---|---|---|---|
| A 单步 | 11 | 5813ms | 40~120s |
| B 探索（每批 5 步） | 6 | 4931ms | 23~65s |
| C 回放 | 1 | 5003ms | 8~15s |

\* 模型往返按 3-10s/turn 估算 + 工具侧实测。三种模式工具侧几乎相同（≈5s，页面耗时是地板）——**提速全部来自消除模型往返**：C 相对 A turn 数降 91%、端到端约 5-10x。

## CI 无人值守回归

```bash
node scripts/ci-harness.mjs up     # 起 headless Chrome，环境写入 .scratch/ci-env.json
#   CI agent 用环境里的 browserURL 配置 MCP，跑自愈循环：
#   replay_suite → 逐失败 heal_step → 全绿（见 docs/ci-unattended-loop.md）
node scripts/ci-harness.mjs gate   # 对 ./traces/*.json 终判，退出码 0/1，自动清理
```

批量报告末行是机读收尾行 `SUITE_RESULT ok=N failed=M total=K wall_ms=D`，
流水线 grep 它拿退出依据。自愈有服务端护栏：只修定位类失败、单步≤2 次、
一轮≤3 处、断言失败拒修（转人工），全自动写回前必过独立 Context 验证门。

## 已知边界（一期）

- 只支持 Web。桌面端在三期，感知层已留可插拔接口。
- 并行回放限单机单浏览器多 Context，`replay_suite` 的 `concurrency` 默认 3、硬上限 8；
  实测 3 并发约 2.7x 加速（固定开销摊薄后会更接近 3x）。
- **隐式等待检测不到纯 `setTimeout` 触发的更新**——那种情况页面上不存在任何在途信号，
  必须用显式 `wait`。带网络请求的异步更新则能正常等到。
- 隐式等待的网络在途信号只统计 XHR/Fetch/Document/Script/Stylesheet，
  信标/图片类请求不拖住等待；单个请求超过 10s 视为长轮询或僵尸，不再阻塞。
  打满 timeoutMs 上限的步骤会在结果里带告警。
- iframe：支持同进程 iframe 的感知、css/role-name 定位与操作、**容器锚定与文本策略**；
  跨进程 iframe（OOPIF）不支持。
- `xpath` 兜底策略是全文档搜索，对 iframe 内元素理论上可能误命中主文档的同结构元素。
- **click 对被 CSS 隐藏/覆盖的元素自动兜底**：先做 hit-test（`elementFromPoint`），
  若目标元素不在点击坐标（被覆盖 div 替代或 `opacity:0` 隐藏），在 CDP 鼠标事件之后
  补一个 `dispatchEvent(MouseEvent('click'))` 直达目标元素，避免双击副作用。

## 开发

```bash
npm test                  # 先 tsc 构建再跑全部（32 个文件 / 244 个测试）
npm run test:unit         # 纯函数单测，毫秒级
npm run test:integration  # 需真实 Chrome
```

`test/integration/mcp-server.test.ts` 会把 `dist/index.js` 作为真实 MCP server
拉起来走 stdio 协议对话——这是唯一覆盖工具注册与返回格式的测试，所以 `npm test`
会先 `tsc`，免得拿旧产物测出假绿。

集成测试通过 vitest `globalSetup` **全套件共享一个 Chrome 实例**。
不要在测试文件里各自 `puppeteer.launch()`——那样会有 N 次收尾，
而 puppeteer 的 `browser.close()` 会偶发挂死，把整个文件拖成 hook timeout。
