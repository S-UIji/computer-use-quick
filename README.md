# computer-use-quick

Web 端到端测试的 MCP 控制层。把「每步一次模型往返」换成「batch 压缩 + 零模型回放」。

## 安装与构建

```bash
npm install
npm run build
```

## 启动被测浏览器

服务端不自己启浏览器，而是连接一个已开调试端口的 Chrome（有头、headless 均可）：

```bash
# Windows（cmd）
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir=%LOCALAPPDATA%\cuq-chrome-profile

# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.cuq-chrome-profile"
```

**`--user-data-dir` 必须带，且不能指向日常 Chrome 的默认目录**：Chrome 136 起，默认 profile 下
`--remote-debugging-port` 会被静默忽略（防止恶意软件借调试端口窃取日常浏览器的 cookie/密码）。
独立目录顺带避开另一个坑：日常 Chrome 已在运行时，同 profile 的启动参数会被转交给已有进程而丢弃。
目录固定不变，手动登录一次后登录态就留在里面；它是全新 profile，不含日常书签与登录态。
浏览器打开 `http://127.0.0.1:9222/json/version` 能看到 JSON 即就绪。

服务端启动时不连浏览器，先起服务端、后开 Chrome 也可以：第一次工具调用时才去连，连不上会返回
当前平台完整的启动命令，照做后直接重试即可。浏览器中途被关掉，重新打开后下一次调用会自动重连，
不需要重启 MCP 服务端（重连后的第一次返回会提示之前的标签页和 ref 已失效）。

不想手动启动的话，在 MCP 配置的 `env` 里加 `"CUQ_LAUNCH": "auto"`：连不上且地址是本机时，
服务端用上面同一个 profile 目录自己拉起有头 Chrome；服务端退出时不关它，下次直接复用。
Chrome 不在常见位置（或想用 Edge）时，用 `CUQ_CHROME_PATH` 指定可执行文件路径。

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
| `replay_suite` | 并行回放多条 trace：每条独立 BrowserContext（零共享 cookie），失败自动完整重试 1 次（flaky 标记），跑完全部再汇总；失败上下文可直接接 `heal_step`。`concurrency` 默认 3、上限 8 |
| `save_auth` | 把当前页面登录态（cookie + localStorage）存为认证态文件并设为 session 默认，replay/suite/heal 验证门自动注入——用例不必每次从头登录 |
| `heal_step` | 回放失败后的自愈：演示修正步 → 独立 Context 全量重放验证 → 全绿才写回 trace。`assert-failed` 服务端拒修（可能是真 bug） |
| `inspect` | 只在排查失败时用。取截图/console/网络 |

## 标签页选择与关闭恢复

`snapshot` / `batch` 等工具传入有效 `pageId` 时，该页成为默认操作页；
传入不存在或已关闭的 ID 会返回错误，请先用 `list_pages` 重新选页。

默认操作页被关闭后，下一次省略 `pageId` 的取页会新建空白标签页并告知新 ID，
用户的其他标签页保持不变。旧 ref 不可复用，请先 `snapshot` 确认。
只调用 `list_pages` 不会新开页，也不会把其他页标为默认页。

执行中或收尾时页面关闭会报告 `page-closed`；套件不自动重试，
回放不要求自愈。自愈验证页被关闭时不写回 trace、不扣预算，恢复页面后重新运行。

## 页面变化提示

成功的 `snapshot`（包括 diff）和完成的 `batch` 会按标签页记录 URL。
下一次 batch 开始时地址有变化，响应前缀会展示前后 URL，并提示
“ref 可能已失效，请先 snapshot 确认”。提示在该批次返回时出现，批次仍按原有规则执行，
不会自动阻断或重试；批次自身的导航会更新终态基线，不影响下一次判断。

失败上下文附带当前 URL；关闭页面时标明最后已知地址。
新增 URL 诊断会隐藏 userinfo 和 token/password/secret 等明显凭证参数，
但不承诺识别任意业务参数。query/hash 变化会被检测；同 URL 刷新和纯 DOM 变化不在本项范围内。

## 三种用法

**探索式测试**：`snapshot` 看页面 → `batch` 执行一批 → 再 `snapshot` 确认 → 循环。

**固化**：探索通过后 `save_trace`，得到一个 JSON 文件，用 git 管起来。
写 trace 时给每个意图步配断言（自愈验证门的语义天花板）。

**回归**：`replay` 传 trace 路径。凭证通过 `vars` 或环境变量注入，**绝不写进 trace**——
写了明文，`save_trace` 会直接拒绝保存。batch 里写 `${VAR}` 占位符，trace 里存的就是占位符，
真实值只在执行时替换。凭证字段按 `type=password` 与定位信息里的字样（password、密码、口令、令牌等）识别；
向凭证字段写明文时 batch 当场告警，不必等到 `save_trace` 被拒。

**自愈**：replay 返回 `heal_required` 后，用 `snapshot`/`batch` 在失败页面上找到正确操作，
调 `heal_step` 演示修正步——服务端捕获描述符、新标签页全量重放验证，全绿才原子写回，
heal 历史留在 `<trace>.heal.jsonl` 供审计。只修定位类失败（找不到/歧义/超时），
断言失败会被拒绝：那可能是被测系统的真 bug。同一步最多 2 次尝试、一轮最多 3 处，
超出转人工。

**视觉断言**：`assert` 支持 `type: "screenshot-match"`——元素区域（或 `fullPage: true`
整页）截图与基线逐像素比对，差异超阈值即失败（归为 `assert-failed`，heal 拒修）。
基线存 `traces/baselines/<用例名>/`，按 descriptor 哈希命名（heal 换步不移位）；
首次运行自动建基线，页面改版属预期时用 `updateBaselines: true` 重录。
失败时 actual/expected/diff 三图随运行归档，可直接判读差异位置。
基线对环境敏感（字体/DPR），请在目标运行环境（CI）生成。

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
npm run bench -- ./traces/<用例名>.json
```

仓库不附带示例 trace（`traces/` 已 gitignore），先用 `save_trace` 对你的靶场录制一份。

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
#   replay_suite → 逐失败 heal_step → 全绿
node scripts/ci-harness.mjs gate   # 对 ./traces/*.json 终判，退出码 0/1，自动清理
```

本地想看回放过程时用 `up --headed` 起有头 Chrome，每个隔离 Context 各开一个窗口。
实测（6 条 × 16 步，3 并发）有头墙钟比 headless 慢约 9%，零失败零重试；
窗口被最小化或完全遮挡时未验证，观察期间请保持窗口可见。视觉基线仍应在 headless 环境生成。

批量报告末行是机读收尾行 `SUITE_RESULT ok=N failed=M total=K wall_ms=D`，
流水线 grep 它拿退出依据。每次运行的 run-record 落盘 `traces/runs/<时间戳>-<用例名>/`
（gitignored），失败附现场包（截图 + 快照 + trace 副本）；认证态用 `save_auth`
捕获一次后自动注入，用例不必每条都登录。自愈有服务端护栏：只修定位类失败、单步≤2 次、
一轮≤3 处、断言失败拒修（转人工），全自动写回前必过独立 Context 验证门。

本地要跑可重复的二期闭环冒烟：`node scripts/e2e-smoke.mjs`。它自带随机端口的临时 SUT，连续两轮验证 `replay_suite → heal_step → replay_suite`；运行前先 `node scripts/ci-harness.mjs up`，结束后 `node scripts/ci-harness.mjs down`。

## 观察模式（有头时自动启用）

连接的是有头 Chrome 时，服务端自动进入观察模式（`CUQ_WATCH=auto`，可设 `on` / `off` 覆盖）：

- **只标被操作的页面**：执行中是紫色描边 + 顶部角标「🤖 computer-use-quick 正在操作 · {标签} · 第 i/N 步」；
  两次调用之间退成淡色「⏸ 待命」；检测到用户介入后变红「✋ 执行已停止」。
- **用户介入如实归因**：执行期间在被操作页面上点击或按键，会在步骤边界停下并报 `user-interrupted`
  （不再误报成 `target-not-found`）。`heal_step` 拒修这类失败、不耗预算；`replay_suite` 不自动重试被打断的用例。
  滚动只记告警、不中止；待命时可以随意操作（例如手动登录）。
- **进度推送**：客户端在 `tools/call` 的 `_meta` 带 `progressToken` 时，batch/replay 按步、
  replay_suite 按用例、heal_step 按「演示 → 验证门」推送 `notifications/progress`（与有头无头无关）。
  Claude Code 的展示情况（据其 changelog 与 issue #86464，未在本项目实测）：前台调用时进度文字显示在工具调用行下方；
  超过 120s 被转入后台的调用，2026-09 下旬之前的版本会丢弃进度，之后的版本在后台任务里显示最新进度。

标注画在 `<html>` 下的封闭 Shadow DOM 里，不进快照、不拖隐式等待、不挡点击、截图时自动隐藏，
生成的描述符与无标注时相同（均有集成测试覆盖）。headless 下不启用，CI 行为不变。

标注的生命周期：「已被打断」的红色标注保留到下一次执行；服务端正常退出（客户端关闭 stdin、
SIGTERM、Ctrl+C）或调用 `BrowserSession.close()` 时会先撤掉所有标注再断开。

已知边界：`<dialog>` 模态框与全屏元素会盖过标注；服务端进程被强杀或崩溃时来不及清理，标注残留到页面刷新；
跨进程 iframe 内的操作检测不到；上报只含事件类型与坐标，不含按键值。

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
- **JS 弹窗（alert/confirm/prompt/离开页面确认）自动处理**：弹窗开着时页面上的一切操作都会挂住，
  所以执行期间弹出的窗立即处理。
  - 策略：confirm/prompt 默认确定；步骤里写 `"dialog": "dismiss"` 取消；`"promptText"` 指定
    prompt 要填的文本（支持 `${VAR}`），省略则用弹窗自带的默认值；alert 与离开页面确认总是放行。
  - 报告与固化：处理结果写进该步结果；固化时按默认策略处理过弹窗的步骤会记下 `dialog`，回放据此复现。
  - 两次调用之间弹出的窗（定时器触发，或有头模式下用户自己点出来的）先不动，
    下一次工具调用开始时按默认策略处理，并写在该次返回的最前面。
  - 接管前就已开着弹窗的标签页只能盲关，报告里拿不到弹窗内容。

## 开发

```bash
npm test                  # 先 tsc 构建再跑全部（58 个文件 / 447 个测试）
npm run test:unit         # 纯函数单测，毫秒级
npm run test:integration  # 需真实 Chrome
```

`test/integration/mcp-*.test.ts` 会把 `dist/index.js` 作为真实 MCP server
拉起来走 stdio 协议对话，覆盖工具注册、返回格式和页面生命周期；所以 `npm test`
会先 `tsc`，免得拿旧产物测出假绿。

集成测试通过 vitest `globalSetup` **全套件共享一个 Chrome 实例**。
不要在测试文件里各自 `puppeteer.launch()`——那样会有 N 次收尾，
而 puppeteer 的 `browser.close()` 会偶发挂死，把整个文件拖成 hook timeout。
