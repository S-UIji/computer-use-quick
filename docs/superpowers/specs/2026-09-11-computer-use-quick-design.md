# computer-use-quick 设计文档

日期：2026-09-11
状态：已评审待实现
适用范围：一期（Web），并记录二期/三期方向

---

## 1. 背景与问题

现有端到端冒烟测试走两条链路，都慢：

- **Web**：chrome-devtools MCP 驱动浏览器，模型每步调一次工具
- **桌面**：Claude computer use，模型看截图输出鼠标键盘坐标

以 `AI-ORG-TALENT-SANDBOX` 的实际执行为例（`test/e2e-ui/`）：10+ 条用例的一轮执行留下 **22 个 `snap-*.txt` 快照文件**（每个约 6.4 KB，≈1500-2000 token）和 21 张截图。文件数本身就是证据——执行是「每步一次 snapshot、每步过一次模型」。

### 1.1 耗时的真实结构

在 MCP 架构下，耗时单位**不是一个动作，而是一次 agent turn**。每调一次 MCP 工具，就要把上下文回传模型、等它决定下一步，一次 3~10 秒。一条 25 步的冒烟用例 = 25 次 turn = 3~5 分钟。

其中绝大多数 turn 没有任何不确定性：「点输入框 → 打字 → 点密码框 → 打字 → 点登录」这 5 步，第 1 步之后的 4 步结果完全可预测，却各烧掉一次完整往返。

**所以「把 N 步压成 1 次调用」比「把每步从 3 秒优化到 2 秒」有效得多。MCP 工具的粒度设计本身就是性能设计。** 这是本方案的第一原则，下文所有取舍都由它推导。

### 1.2 四个次级问题

1. **感知用像素**：截图 1500~2500 token/次，每步重传；模型还要从像素里猜控件位置，点错了再重试。
2. **等待靠 sleep**：固定 `sleep 2` 是纯浪费，页面 300ms 就绪也得等满。
3. **零记忆**：同一条用例跑第 100 遍，和第 1 遍一样在从头"思考"。
4. **诊断要多轮**：失败后模型得再调几次工具问现场，又是几个 turn。

---

## 2. 目标与非目标

### 目标

一套 MCP Server，作为 Web 端到端测试的统一控制层，同时服务四类场景：

| 场景 | 运行模式 | 诉求 |
|---|---|---|
| 探索式测试 / 新功能验收 | 探索模式 | 能应对没见过的界面 |
| 发版前手动跑一轮 | 探索 + 回放 | 覆盖广、能继续跑下去 |
| CI 高频回归 | 回放模式 | 快、稳、无人值守 |
| 演示 / 现场验证 | 回放模式（可降速） | 看得见在操作 |

四者不是四套系统，而是**同一架构的四种模式**，核心是「探索 → 固化 → 回放 → 自愈」闭环。

### 非目标

- **不做桌面端**（三期）。感知层留可插拔接口，三期的 Windows 后端以独立子进程接入。
- **不做人类化操作节奏**。见 2.1。
- **不做反自动化检测对抗**。被测系统是内部系统，无此需求。
- **不做用例管理平台**。trace 就是普通 JSON 文件，用 git 管。

### 2.1 关于「像真人」的边界

**砍掉**：鼠标轨迹动画、随机人类化延迟、逐字符打字节奏。这些纯粹拖慢速度，对内部系统冒烟没有价值。

**保留**：经 CDP `Input` 域派发的真实浏览器事件（`isTrusted: true`），前端 JS 区分不出来，且不比直接 `element.click()` 慢多少。

不降级成「JS 直接调 `click()`」——那会绕过 hover / focus / blur 等真实交互链路，反而漏 bug。**真实事件序列保留，人类化节奏全砍。**

---

## 3. 架构

```
Claude Code ──stdio──► computer-use-quick (MCP Server, 单进程)
                            │
                            ├─ Session Manager ── CDP/WebSocket ──► Chrome
                            ├─ Perception   a11y 树抓取 → 裁剪 → 折叠 → 快照文本
                            ├─ Locator      descriptor 生成 + 多策略解析 + 漂移判定
                            ├─ Executor     各 action 实现（经 CDP Input）
                            ├─ Waiter       隐式稳定性等待 + 显式等待条件
                            ├─ Assertion    可见 / 文本 / URL / 接口状态
                            ├─ Trace Store  trace 读写 + replay 引擎
                            └─ Report       run-record 生成
```

`Perception` 与 `Locator` 之间是纯数据接口（节点集合 → descriptor）。这是二期桌面后端的接入点：换掉 Perception 的实现，Locator 及其下游不变。

### 3.1 三种运行模式（同一套代码）

- **探索模式**：`snapshot` → `batch` → `snapshot` 循环，模型驱动。慢，但能应对未知界面。
- **回放模式**：`replay(trace)`，零模型介入。数量级提速的来源。
- **自愈模式**（二期）：replay 失败 → 返回结构化失败上下文 → 模型修一步 → 更新 trace。

---

## 4. MCP 工具面（一期 5 个）

粒度即性能，所以工具**少而粗**：

| 工具 | 作用 | 设计理由 |
|---|---|---|
| `snapshot` | 返回精简可交互元素列表（带 ref） | 替代截图，token 压到 1/3 以下 |
| `batch` | **核心**。一次传入 N 步，服务端顺序执行 | 把 N 次 turn 压成 1 次 |
| `save_trace` | 把本 session 成功执行过的步骤固化为可回放用例 | 探索的副产物自动变资产 |
| `replay` | **核心**。一次调用跑完整条用例，全程不过模型 | CI 场景的全部价值 |
| `inspect` | 取截图 / console / 网络 | 只在失败时调，不进主路径 |

**刻意不提供单独的 `click` / `fill` / `wait` 工具。** 想点一下也走 `batch`（数组长度为 1）。这是为了避免模型养成「一次调一个」的习惯——那正是现状慢的原因。

---

## 5. 感知层

### 5.1 快照格式

来源：CDP `Accessibility.getFullAXTree`，辅以 DOM 属性补充。输出**缩进文本**而非 JSON（省约 40% token）：

```
heading "欢迎登录"
[e4] textbox "用户名" value=""
[e5] textbox "密码" value=""
[e3] button "登录"
[e7] link "忘记密码"
```

裁剪规则：

- 只保留可交互节点（button / link / textbox / checkbox / radio / combobox / menuitem / tab…）与语义文本节点（heading / status / alert）
- 丢弃不可见元素（`display:none` / `visibility:hidden` / 零尺寸）
- 丢弃无 name 的纯布局容器（`generic`）
- name 超长截断（默认 80 字符）

目标：典型业务页压到 **300~800 token**（对比截图 1500~2500）。

### 5.2 同构模式折叠

业务系统充斥同构重复结构（列表、卡片墙、表格）。实测 `AI-ORG-TALENT-SANDBOX` 首页：339 个 AX 节点中，16 张部门卡片结构**完全同构**。折叠后：

```
[16 张部门卡片，结构相同，字段：部门名/正职/空岗/岗级/人才标签/总人数·正编·外包·其他]
  1. 战略与运营中心 · 空岗 · 0/0/0/0
  2. 教育事业群 · 空岗 · 青苗57 致远35 百将65 · 5081/3814/1049/218
  ...
```

339 节点 → 约 80 行。

**识别方式**：同父节点下，子树的 role 序列签名相同且重复 ≥ 阈值（默认 3）的兄弟节点组，判定为同构组。

**已知风险**：折叠掉的细节模型看不见，可能漏 bug。三条缓解——

1. 折叠阈值保守（默认 3，可配）
2. 折叠时**保留每项的区别性字段**（名称、关键数值），只折叠结构
3. `snapshot` 支持 `expand` 参数，展开指定分组拿完整细节

---

## 6. 定位层

### 6.1 核心区分：ref 是短期句柄，descriptor 是长期描述符

混为一谈会导致 trace 里存了 `e42` 这种东西，下次回放全废。

- **ref**（`e4`）：仅本次快照后有效，服务端 Map 到 `backendNodeId`，页面导航即失效。给模型在一次对话内指代元素用。
- **descriptor**：多策略定位描述符，写进 trace 长期保存。

### 6.2 descriptor 策略表

被测系统**没有 `data-testid`**，因此主力是语义 + 容器锚定：

| 优先级 | 策略 | 示例 |
|---|---|---|
| 1 | testId（碰巧存在就用） | `[data-testid="submit"]` |
| 2 | **容器锚定 role+name** | `卡片(含文本 "教育事业群") › button "查看在岗干部明细"` |
| 3 | **行锚定**（表格专用） | `row(含文本 "ORD20250911") › button "删除"` |
| 4 | role+name 全页唯一 | `button "提交"` |
| 5 | 可见文本 + tag 限定 | `a:text("忘记密码")` |
| 6 | css（基于 id / 稳定 class） | `#login-form .submit` |
| 7 | xpath 结构路径 | 兜底 |

回放时**按序尝试，第一个唯一命中的胜出**。

消歧用**容器内 nth**，绝不用全页 nth——全页 nth 在列表插一行就整体错位。

### 6.3 容器锚定走 DOM，不走 AX

**这是基于实测的关键设计决定。**

实测 `AI-ORG-TALENT-SANDBOX` 首页发现：a11y 树里**没有卡片容器**。16 张部门卡片的按钮平铺在 `main` 下，没有 `group` / `article` / `region` 包裹。后果是大量元素全页不唯一：

| 元素 | 全页重复次数 |
|---|---|
| `button "查看在岗干部明细"` | 16 |
| `button "负责人治理"` | 16 |
| `button "查看总人数明细，共0人"` | 多个（0 人部门不止一个） |
| `button "安徽讯学教育科技有限公司(体系外)"` | 2（真实同名部门） |

因此 **`Locator` 必须同时消费 AX 树和 DOM 树**，容器边界从 DOM 求：

> 从目标元素向上回溯，找最近的、包含某个唯一锚文本的共同祖先，以它为容器边界。

这也正是真人的做法——先认是哪张卡，再点卡里的按钮。

### 6.4 纯语义无解时的兜底

同名部门（`安徽讯学教育科技有限公司(体系外)` 出现两次）这类情况，任何纯语义定位都区分不了。descriptor 额外记录**容器内的区别性内容**（一个 643 人外包，一个 783 人）参与消歧。

### 6.5 懒计算

descriptor **只在元素真正被操作时才计算**，不在快照时给全页几十个元素都算一遍 css/xpath。一个页面实际被操作的通常 1~3 个元素，这让 `snapshot` 保持在几十毫秒量级。

### 6.6 iframe / shadow DOM

descriptor 携带 frame 路径（frame 按 url / name 定位）。一期完整支持 iframe（业务系统高频）；shadow DOM 做基础穿透（AX 树本身可穿透）。

---

## 7. 执行引擎

### 7.1 步骤类型

`navigate` · `click` · `fill` · `select` · `press` · `hover` · `scroll` · `wait` · `assert` · `extract`

`extract` 把页面上的值（如新建后生成的订单号）存进运行时变量，供后续步骤引用。没有它，一条「创建 → 查询 → 删除」的完整链必须拆成三次 `batch` 调用——又退回多 turn。

### 7.2 等待：默认隐式，显式是例外

**每个动作后自动做稳定性等待，用例里不需要写 wait。** 取以下条件最先满足者：

- DOM 变更静默 ≥ 150 ms
- 无 in-flight XHR / fetch ≥ 500 ms
- 上限超时 5 s（可配）

显式 `wait` 只用于特殊场景：等元素出现/消失、等指定接口返回、等 URL 变化。

固定 `sleep` **提供但在报告里告警**。总有诡异场景需要它，但每出现一次都是一处该被改掉的技术债，得让它显形。

### 7.3 失败语义：fail-fast

一期只做 fail-fast，不支持 `continueOnError`。冒烟测试前面挂了后面没意义，保持简单。

### 7.4 失败返回：一次给全

这是对第一原则最直接的落实。`batch` 失败时**一次性**返回：

- 失败步索引 + 原步骤定义
- 错误类型：`target-not-found` / `ambiguous` / `timeout` / `assert-failed`
- 失败时刻快照
- 候选元素列表（歧义时，上限 10 条）
- 最近 20 条 console 报错
- 最近 20 条失败网络请求（非 2xx/3xx）

模型拿到这一坨就能直接决定怎么改，不用再调 `inspect` 问三轮。

### 7.5 变量与凭证

`${VAR}` 插值，两个来源：

1. 配置文件 / 环境变量——**凭证只走这里，绝不落进 trace 文件**
2. `extract` 产生的运行时变量

---

## 8. Trace 与 replay

### 8.1 trace 格式

```json
{
  "name": "smoke-login",
  "baseUrl": "http://localhost:3040",
  "steps": [
    { "action": "navigate", "url": "/#/" },
    { "action": "fill",
      "target": { "strategies": [
        { "kind": "container-role-name",
          "container": { "containsText": "教育事业群" },
          "role": "textbox", "name": "客户名称" },
        { "kind": "css", "value": "#customer-name" },
        { "kind": "xpath", "value": "..." }
      ]},
      "value": "${CUSTOMER}" },
    { "action": "assert", "type": "visible",
      "target": { "strategies": [ ... ] } }
  ]
}
```

### 8.2 replay 输出：run-record

每步记录：耗时、**命中的是第几策略**、漂移告警、断言结果；失败时附截图。

### 8.3 漂移告警

记录实际命中的策略序号。若 testId 失效、退到 xpath 才命中 → **不算失败，但在报告里告警**。

这是**改版预警信号**，比测试挂了才发现早得多。一期就做——不影响速度，只多存一点信息。

### 8.4 并发

一期串行单浏览器。但 trace 设计上**不假设任何跨用例共享状态**，为二期多 BrowserContext 并行留门。

---

## 9. 模块边界

```
src/
  server.ts        MCP 入口，工具注册（snapshot/batch/save_trace/replay/inspect）
  session/         浏览器连接、页面与 frame 管理
  perception/      a11y 树抓取 → 裁剪 → 同构折叠 → 快照文本渲染
  locator/         descriptor 生成 + 多策略解析 + DOM 容器求解 + 漂移判定
  executor/        各 action 实现
  waiter/          隐式稳定性等待 + 显式等待条件
  assertion/       断言
  trace/           trace 读写 + replay 引擎
  report/          run-record 生成
```

每个模块单一职责、可独立测试。`perception` ↔ `locator` 的接口是二期桌面后端的接入点。

---

## 10. 技术选型

**TypeScript + puppeteer-core（仅作 CDP 连接层，不用其高层 API）**

决策依据不是性能——语言选型对端到端耗时的影响 <5%，提速 100% 来自架构。真正的理由：

1. **底层优化空间**：`batch` 中连续多步时，直连 CDP 可以用**一次** `Runtime.evaluate` 批量解析多个 target 的定位，而不是每步一次往返。这类优化在 Playwright 的 locator 抽象下做不了。
2. **MCP SDK 在 TS 上是一等公民**；`chrome-devtools-mcp` 本身是 TS，其快照裁剪实现可借鉴。
3. 无跨进程跳转。（对比：Playwright 的 Python 绑定底下跑一个 Node driver 进程，Python 经管道与之通信，多一整跳。）

三期 Windows 桌面的生态（`uiautomation` / `pywinauto`）确实更偏 Python，但这不构成反对——感知层本就设计成可插拔，届时以独立 Python 子进程经本地 IPC 接入。一期不实现该子进程，只留接口。

锁定 puppeteer-core 版本，规避 CDP 版本差异。

---

## 11. 测试策略

### 11.1 单元测试

a11y 裁剪规则、同构折叠签名算法、descriptor 生成、DOM 容器求解、trace 序列化、变量插值。纯函数，毫秒级。

### 11.2 集成测试：本地 fixture 站点

起一个静态 HTTP 服务，刻意造这些页面：

| fixture | 验证目标 |
|---|---|
| 表单页（各类控件） | 基础 action |
| 异步加载列表 | 隐式等待是否真的省掉了 sleep |
| 同名按钮表格 | 行锚定 + 容器内 nth |
| 无 a11y 容器的卡片墙 | **DOM 容器锚定**（复刻靶场的真实形态） |
| 模态框 + iframe | 容器锚定与 frame 路径 |
| 同构 20 项列表 | 模式折叠 + `expand` 展开 |
| **同页面 v1/v2 改版对** | **策略回退与漂移告警** |

最后一条是对本方案核心风险（trace 能否稳定回放）的直接验证，不可省。

### 11.3 基准测试（验收指标，非可选项）

**靶场**：`AI-ORG-TALENT-SANDBOX`（`http://localhost:3040`）。选它的理由：

- a11y 质量实测良好——有 landmark（`banner`/`navigation`/`main`/`complementary`）、按钮名自带业务语义与数值（`button "查看总人数明细，共5081人"`）、带状态（`pressed`/`checked`）、有 live region。`role+name` 主力策略成立。
- **已有现成 e2e 基线可作 A/B 对照组**：`test/e2e-ui/` 下有 10+ 条用例（IMP-001~008、ETL-001~002…）、21 张截图、22 个快照文件。同一批用例跑新方案，提速倍数直接量得出来。

取一条约 25 步的真实冒烟用例，三种方式各跑 5 次取中位数：

| | 方式 | 记录指标 |
|---|---|---|
| A | 现状：chrome-devtools MCP 每步一 turn | 总耗时 / turn 数 / token |
| B | 本方案探索模式（snapshot + batch） | 同上 |
| C | 本方案 replay | 同上 |

**目标值（目标，非承诺）**：turn 数从 ~25 降到 ≤3；C 相对 A 提速一个数量级。replay 的绝对耗时主要由页面加载决定。跑出来是多少就是多少，一期结束用真实数字说话。

---

## 12. 风险登记

| # | 风险 | 缓解 |
|---|---|---|
| 1 | **a11y 质量依赖被测系统**。若组件库无 `aria-label` / `<label for>` 关联，输入框 name 会大面积为空（按钮问题不大，内容文本天然是 name） | placeholder / 邻近 label 文本 / 表单结构位置作为 name 回退链。靶场实测覆盖率良好，风险已显著降低 |
| 2 | **trace 漂移**：页面改版导致定位失效 | 多策略回退 + 漂移告警（一期）；自愈（二期） |
| 3 | **同构折叠漏信息**：折叠掉的细节模型看不见 | 保守阈值 + 保留区别性字段 + `expand` 参数 |
| 4 | **同名/同结构元素纯语义无解** | descriptor 纳入容器内区别性内容 |
| 5 | CDP 版本差异 | 锁 puppeteer-core 版本 |

长期看，推动被测前端补 `data-testid` 是性价比最高的一笔投资，回放稳定性直接上一个台阶。但本设计不依赖它。

---

## 13. 分期

**一期（本设计范围）**：Web。感知层（裁剪 + 同构折叠）、定位层（多策略 + DOM 容器锚定 + 漂移告警）、执行引擎（batch + 隐式等待 + fail-fast + 变量）、trace 录制与 replay、5 个 MCP 工具、三层测试 + benchmark。

一期结束交付**真实提速数字**，据此决定后续投入。

**二期**：失败自愈（replay 失败 → 模型修一步 → 更新 trace）；多 BrowserContext 并行；快照增量 diff。

**三期**：Windows 桌面后端（独立 Python 子进程，经 `perception` 接口接入）。

---

## 14. 已决策记录

| 决策 | 结论 | 依据 |
|---|---|---|
| 方案路线 | 分层感知 + 轨迹回放，按「感知优化 → 录制回放 → 自愈」分期 | 一期是完整方案的真子集，不会白做 |
| 一期平台 | 仅 Web | a11y 通道成熟，快速验证架构 |
| 「像真人」 | 保留真实事件，砍人类化节奏 | 项目目标是提速 |
| 语言/库 | TypeScript + puppeteer-core / 裸 CDP | 底层批量定位优化空间 + MCP SDK 一等公民 |
| 单步工具 | 不提供，一律走 `batch` | 防止模型退回一次一步 |
| 失败语义 | 一期只做 fail-fast | 冒烟场景够用，保持简单 |
| 容器锚定 | 走 DOM 而非 AX | 实测靶场 a11y 无卡片容器 |
| 同构折叠 | 一期就做 | 业务系统普适，收益大；风险由阈值 + expand 控制 |
| 漂移告警 | 一期就做 | 不影响速度，改版预警价值高 |
| 靶场 | AI-ORG-TALENT-SANDBOX | a11y 质量好 + 已有 e2e 基线可作 A/B 对照 |
