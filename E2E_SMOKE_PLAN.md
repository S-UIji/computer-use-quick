# computer-use-quick 全量端到端冒烟计划

首次执行：2026-09-30；状态更新：2026-10-08
目标：用真实有头 Chrome、真实 MCP stdio 客户端和旁路“用户”连接，验证从探索到回放、自愈、并发、观察模式和浏览器生命周期的完整链路，并把模型/用户实际会遇到的不舒服之处记录成可修复的问题。

## 执行原则

- 每次测试使用独立 Chrome profile、独立 DevTools 端口和独立靶场数据。
- 冒烟 trace 必须幂等：重复运行不会因为上一次新增的订单、cookie 或 localStorage 造成重复目标。
- 每个场景同时记录 MCP 返回、进度通知、当前 URL、页面可见性、窗口边界、console/网络失败和用户实际截图。
- “调用成功”不等于“用户体验通过”：任何额外模型往返、页面误切换、错误归因、遮挡、无意义噪音都单独记为问题。
- 完成代码改动后先 `npm run build`，再执行下列真实浏览器流程；结束时必须 `ci-harness down`。

## 环境准备

```powershell
npm run build
node scripts/ci-harness.mjs down        # 清理可能过期的环境文件
node scripts/ci-harness.mjs up --headed
node scripts/e2e-smoke.mjs
```

读取 `.scratch/ci-env.json` 中的 `browserURL`，以此启动 MCP 客户端。所有临时 trace、截图和日志放在 `.scratch/e2e-<timestamp>/`。

真实客户端必须覆盖：

- `initialize` / `notifications/initialized`
- `snapshot`、`batch`、`list_pages`
- `save_trace`、`replay`、`replay_suite`
- `save_auth`、`heal_step`
- `inspect`
- 带 `progressToken` 和不带 `progressToken` 两种调用

## 测试矩阵

| 编号 | 场景 | 关键步骤 | 通过标准 |
|---|---|---|---|
| E0 | 环境幂等 | 旧 `.scratch/ci-env.json` + 端口已死后执行 `up` | 自动清理过期文件并继续，不能要求人工 `down` |
| E1 | 首次连接 | Chrome 未开时连接 MCP，再启动 Chrome | MCP 握手成功；工具返回可执行启动指引 |
| E2 | 探索登录 | snapshot → batch 填写账号/密码 → 点击登录 | 一次 batch 完成；密码不进 trace；进度按步骤到达 |
| E3 | 快照可操作性 | 检查工具栏、表格、对话框、同名按钮 | 叶子交互元素直接有 ref；表格按行组织；不需要无意义 `expand` |
| E4 | 异步与等待 | 网络异步、纯定时器、visible/hidden、重复目标 | 网络等待按接口完成；纯定时器需要显式 wait；歧义报 `ambiguous` 和匹配数；hidden 不假通过 |
| E5 | 探索固化 | 正常 batch → save_trace；明文凭证 → save_trace | 占位符保留；明文被拒；trace 可读、可回放 |
| E6 | 正常回放 | 独立 Context 中 replay 完整 trace | 零模型往返、步骤台账完整、失败上下文为空 |
| E7 | 缺变量预检 | replay/replay_suite/heal 缺少 `${VAR}` | 零步执行、零窗口副作用，列出全部缺失变量；不误用 `PWD/HOME/PATH` 等系统变量 |
| E8 | 视觉断言 | 首次建基线 → 通过 → 改样式失败 → 更新基线 | actual/expected/diff 可读；视觉失败不可自愈 |
| E9 | 单点自愈 | 改名造成定位失败 → snapshot/batch 演示 → heal_step | 演示成功、独立 Context 验证成功、原子写回、再 replay 全绿 |
| E10 | 多点自愈 | 同一 trace 制造两个独立定位故障 | 结果明确指出修复步是否已通过、阻塞点是否后移；预算不误扣；存在可继续修复路径 |
| E11 | 并发回放 | replay_suite 3 条、重试、heal 验证 | Context/cookie 隔离；有头窗口不重叠；重试不新增失控窗口；进度尽早出现 |
| E12 | JS 弹窗 | confirm/prompt/alert、两次调用之间弹窗、加载即弹窗 | 调用不挂；策略和弹窗内容写入结果；步骤级 dismiss/accept 可复现 |
| E13 | 用户介入 | 执行中点击/按键/滚动；执行间切标签 | 点击/按键在步骤边界变为 `user-interrupted`；滚动只告警；后续指引明确 |
| E14 | 标签页安全 | 关闭被操作页；再调用不带 pageId 的 batch | 不接管用户其他标签；错误说明页面已关闭或新开页 |
| E15 | 页面变化 | snapshot 后用户退出/导航，再提交旧 ref | 返回 URL 变化提示和“先 snapshot”建议；失败上下文带当前 URL |
| E16 | 观察模式 | active/idle/interrupted、导航期间、截图 | idle 不遮挡页面；导航后标注无明显缺口；步骤说明包含动作和目标 |
| E17 | 生命周期 | 浏览器关闭 → 工具调用 → 重开同端口 | 断开后给出指引；重开后同一 MCP 会话自动重连并一次性告知旧 ref 失效 |
| E18 | 输出质量 | 故意失败、favicon 404、坏步骤、suite 失败 | 过滤无关噪音；坏步骤给可读输入错误；结果带 URL/title；机读收尾行稳定 |

## 一次完整执行顺序

1. 清理并启动有头 Chrome，记录 PID、profile、端口和屏幕尺寸。
2. 在 Chrome 未开时启动一个独立 MCP 服务，验证 E1；随后启动 Chrome并复用该服务。
3. 使用独立靶场完成登录、订单创建、订单刷新、订单删除、对话框开关、帮助页新标签和退出。
4. 在每一次 `snapshot` 后记录：快照文本、ref 数、折叠组数、URL、title。重点检查工具栏和表格是否把可操作目标折叠掉。
5. 固化一条包含登录、异步等待、弹窗和新增订单的 trace；先用明文密码故意触发拒绝，再用变量占位符保存。
6. 在新 BrowserContext 中 replay；用另一个版本页面制造按钮改名和重复订单两类定位故障。
7. 分别执行单点 heal 和多点 heal，检查验证门是否把“修复点已通过、后续点失败”说清楚。
8. 复制三条 trace 做 replay_suite，观察开始进度、重试、窗口边界、失败合并和最终 `SUITE_RESULT`。
9. 旁路用户连接执行：运行中点击、按键、滚动、切换标签、关闭被操作页、修改 URL，并保存用户实际看到的截图。
10. 关闭浏览器、重开浏览器、重试工具；确认同一服务无需重启即可恢复。
11. 保存所有日志后执行 `node scripts/ci-harness.mjs down`，确认临时 profile 和环境文件被清理。

## 本次真实执行结果（2026-09-30）

已执行：`.scratch/e2e-ux.mjs`、`.scratch/e2e-smoke.mjs`、`.scratch/e2e-ux-probe.mjs`，均使用真实有头 Chrome 和 MCP stdio。证据保存在：

- `.scratch/e2e-ux/log.md`
- `.scratch/e2e-ux-probe-current.log`
- `.scratch/e2e-ux/s1-idle.png`
- `.scratch/e2e-ux/s2c-user-view.png`
- `.scratch/e2e-ux/s5-heal-validation.png`
- `.scratch/e2e-ux/s6-suite-window.png`

通过或基本通过：

- R1 凭证保护：明文保存被拒，变量占位符保留。
- R2 弹窗：confirm 约 235ms 返回，加载即 alert 约 537ms 返回；结果包含弹窗内容和处理策略。
- R3 生命周期：浏览器关闭后返回启动指引，重开后同一服务自动重连。
- R6 等待歧义：回放中正确报告 `ambiguous`，并给出“最后一次定位匹配到 N 个”。
- 用户介入识别：点击会在步骤边界停止并标红，滚动只告警，退出时标注被清理。

本次仍失败或体验明显不舒服：

| 编号 | 证据 | 结论 |
|---|---|---|
| BUG-01 | `snapshot` 把“刷新/新建订单/删除全部”和表格内容折叠；需要额外 `expand` | R4 已于 2026-10-08 修复并验证（随 R4 提交交付）：叶子按钮保留 ref，表格按行展示，公共字段如实输出 |
| BUG-02 | `.scratch/e2e-ux.mjs` 的探索、replay 和 heal 共用内存 `orders`；`ux-order` 第 10 步先后匹配到 2、3 个“西北分公司” | UX 脚本的数据污染导致重复订单；正式隔离冒烟入口已在 `23dead8` 完成，但旧 UX 脚本仍需在复验前隔离数据。此问题与 BUG-13 的外部只读 trace 歧义分开跟踪 |
| BUG-03 | heal 第 6 步演示成功，但第 10 步因重复数据失败；结果仍说“第 6 步修复失败” | R5，多故障时文案和预算误导，验证门无法继续推进 |
| BUG-04 | 关闭被操作标签后，不带 pageId 的下一次 batch 接管剩余用户标签并导航 | R7 已于 2026-10-08 修复并推送（`1cd7955`，已归档）：关闭后新开默认页；显式失效 ID 拒绝；用户页 URL/内容不变 |
| BUG-05 | 用户退出后旧 descriptor 失败只报 `target-not-found`，没有 URL 变化提示 | R8 已于 2026-10-08 实现并推送（`6f81d38`，已归档）：按页检测完整 URL，返回变化提示及失败现场地址 |
| BUG-06 | idle 角标长期位于顶部中央，遮住页面顶部内容 | R10，待命态应移到角落并缩短文案 |
| BUG-07 | 慢导航期间约 200ms 采样不到 overlay（日志为 2/5 个采样缺失） | R12，跨文档导航时标注有空窗 |
| BUG-08 | suite 3 并发 + 重试窗口出现在 (20,20)、(30,30)…，6 个窗口互相覆盖 | R13，无法同时观察并发任务 |
| BUG-09 | 用户切到帮助页后，agent 执行刷新会把被操作页拉回前台，帮助页变 hidden | R14，打断用户当前工作 |
| BUG-10 | 被打断结果没有“先确认用户完成，再 snapshot，再从第 N 步重提”的下一步指引 | R15，agent 容易立即重试并与用户抢页面 |
| BUG-11 | 所有失败现场都带 `favicon.ico` 404；suite 确定性定位失败仍完整重试 | R16/R17，噪音和等待成本都偏高 |
| BUG-12 | 旧 `.scratch/ci-env.json` 指向已死 Chrome 时，`ci-harness up` 直接拒绝 | R18 已在 `23dead8` 修复并推送：过期环境自动清理，有效环境仍阻止重复启动 |
| BUG-13 | 旧 `.scratch/e2e-smoke.mjs` 使用外部 `localhost:3040` 的只读 `traces/smoke-login.json`，第 5 步容器锚定匹配到 30 个同名按钮，初次 suite 为 0/2 | 外部靶场的容器锚定歧义仍未解决；不能归因为 BUG-02 的重复订单，也不能用新隔离冒烟通过证明它已修复 |

## 已完成修复与当前基线（2026-10-08）

- R6 已在 `9edfff0` 修复并推送：visible/hidden 保留最后定位状态，歧义报告匹配数量，hidden 不再假通过。
- 正式隔离冒烟和 R18 已在 `23dead8` 完成并推送；`master` 与 `origin/master` 均包含这两个提交。
- `scripts/e2e-smoke.mjs` 自带随机端口、内存数据的临时 SUT，动态生成 good/broken trace。已有两轮真实 MCP 验证均为初次 `ok=1 failed=1`，heal 后复跑 `ok=2 failed=0`，收尾为 `E2E_SMOKE_RESULT ok=2 failed=0 rounds=2`。
- 2026-10-08 已重新执行全量测试：55 个文件 / 419 个测试全绿（新增 R7 17 项回归）；基线 52/402 亦在开工前重跑通过。
- 两个已完成 change 已同步主规范并归档至 `openspec/changes/archive/2026-10-08-fix-waiter-ambiguity/` 与 `openspec/changes/archive/2026-10-08-fix-e2e-smoke-isolation/`。
- R7 已在 `1cd7955` 提交、推送并归档（`2026-10-08-fix-closed-page-selection`）：真实 SDK/stdio 测试覆盖无效 ID、默认页恢复、关闭中断、套件不重试、自愈拒修/预算、装配期间关闭与并发恢复。两轮有头复验均报告用户页 URL/内容不变，日志：`.scratch/r7-e2e/log.txt`。
- 正常隔离闭环在有头与 headless 各运行两轮，均通过。headless 复跑墙钟 2505ms、2529ms；有头第二轮复跑 66453ms，两个首个 fill 各约 62693ms，原因尚未定位。证据：`traces/runs/20261008-104017-smoke-good-r2/run-record.json` 和同时间的 `smoke-broken-r2`。将其作为有头并发输入性能问题继续调查，不能由全绿结论抹去。
- R8 已在 `6f81d38` 提交、推送并归档至 `2026-10-08-detect-page-url-changes`：新增 28 项测试；全量 58 个文件 / 447 个测试通过。两轮有头复验验证用户从 /app 导航到 /login 后的 URL 变化提示、失败地址、snapshot diff 刷新基线及批次自身导航不误警，日志：`.scratch/r8-e2e/log.txt`。
- R8 的 headless 隔离闭环连续两轮通过，复跑墙钟 2465ms、2578ms。提示在 batch 响应中返回，不会自动阻断动作；同 URL 刷新/纯 DOM 变化不检测，旧 ref 跨导航后也不保证必然失效。
- R4 已实现并验证；全量 60 个文件 / 470 个测试通过。新增 23 项结构/真实浏览器用例，覆盖叶子不重折叠、语义行及 LayoutTableRow、重复列值、嵌套子组、公共字段、expand 和定位。
- 两轮有头 MCP 验证均直接点击六个工具栏按钮，并展开数据行后点击 ORD-002 的删除按钮；两轮 headless 隔离冒烟均完成自愈和复跑全绿（复跑墙钟 2530ms、2443ms）。
- 外部 `localhost:3040` 的容器锚定问题及已记录的有头并发输入耗时继续独立跟踪。

## 修复优先级

1. **收口 R4**：已实现并验证，按独立提交审阅；R7、R8 已提交、推送及归档。
2. **修 R5**：使用干净数据构造两个独立故障，验证多点自愈可以继续推进，不能把后续失败归咎于已通过的修复。复用旧 UX 脚本前先隔离其 `orders`。
3. **修 R10/R12/R13/R14/R15**：集中改善有头观察模式的可见性、窗口管理和用户协作。
4. **修 R16/R17**：收敛 suite 报告和失败噪音。R18 已随隔离冒烟完成，不再列入待修项。

## R4 前后对照（2026-10-08）

快照均来自相同静态夹具；字符数是输出长度，不是精确 token 数。ref 总数包含结构/文本节点，六个工具栏按钮可直接点击由真实 MCP 操作另行验证。

| 夹具 | 字符数 前→后 | ref 总数 前→后 | 折叠组 前→后 |
|---|---:|---:|---:|
| 工具栏与表格 | 1004 → 761 | 8 → 24 | 9 → 1 |
| 卡片墙 | 169 → 169 | 2 → 2 | 1 → 1 |
| 20 项列表 | 274 → 274 | 1 → 1 | 1 → 1 |
| 同名按钮表格 | 220 → 251 | 2 → 6 | 2 → 1 |

工具栏夹具减少 24.2% 字符；同名按钮表格增加 31 字符以保留表头/行边界与 ref。卡片墙和列表的 groupId 前后不变。行组内部按钮仍通过 expand 或容器锚定操作。

`npm run bench -- .scratch/r4-evidence/trace.json` 使用同一 5 步流程、前后各 5 轮取中位数：

| 模式 | 往返数 | 修复前 | 修复后 |
|---|---:|---:|---:|
| A 单步 | 5 | 1265ms | 1232ms |
| B 批次探索 | 2 | 1194ms | 1189ms |
| C 回放 | 1 | 1158ms | 1189ms |

该样本耗时变化约 ±3%，不能据此声称通用加速；主要收益是首次快照即可获取工具栏 ref。首次基线因临时服务根路径 404 失败，修正后重新执行，失败运行未计入表中。

本地证据：`.scratch/r4-evidence/before.json`、`after.json`、`bench-before.txt`、`bench-after.txt`、`headed-log.txt`、`headed-snapshot-1.txt`、`headed-1.png`。

## 每次修复的验收门槛

- 相关单元/集成测试全绿。
- 本计划对应场景在干净 profile、干净数据上重复运行至少两次。
- 失败场景必须验证错误类型、文案、当前 URL、候选信息和进度通知，而不是只看退出码。
- 有头场景必须检查截图和窗口边界；headless 场景必须再跑一次，确保观察模式改动没有污染 CI。
- 所有结果可由 `log.md`、截图和 `SUITE_RESULT` 收尾行复核。
