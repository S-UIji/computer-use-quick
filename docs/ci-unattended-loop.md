# CI 无人值守回归：工作流 Playbook

本文是 CI 里驱动 agent 的循环契约。目标：一批 trace 从跑到修到终判，全程无人工介入；
只有 playbook 里写明的「转人工信号」出现时才升级给人。

## 角色分工

| 角色 | 职责 | 载体 |
|------|------|------|
| pipeline | 起基础设施、挂接退出码 | `scripts/ci-harness.mjs` |
| agent（模型） | 跑循环、理解失败、演示修复 | 本文 + MCP 工具 |
| MCP server | 执行与护栏，不做任何模型决策 | `dist/index.js` |

服务端没有模型是设计使然：自愈的「理解」必须由 agent 完成，server 只负责执行与刹车。

## 循环步骤

```
1. node scripts/ci-harness.mjs up
   → 环境写入 .scratch/ci-env.json，pipeline 用其中的 browserURL 配置 agent 的 MCP

2. agent 循环（每轮）：
   a. replay_suite(tracePaths=[本轮全部 trace])
   b. 报告最后一行 SUITE_RESULT failed=0 → 跳到 4
   c. 对每个失败用例（聚合报告里有完整失败上下文）：
      - 阅读失败上下文（错误类型/失败步/快照/候选/console/网络）
      - snapshot 看失败页面 → batch 试探找到正确操作
      - heal_step(tracePath, actions=[修正步])  ← stepIndex 可省略，suite 已记账
      - 自愈成功后该 trace 已固化，无需单独复跑
   d. 护栏触发拒绝（预算耗尽/断言失败）→ 按「转人工信号」处理

3. 循环上限：全绿，或所有失败用例都到达转人工条件

4. node scripts/ci-harness.mjs gate
   → 终判 suite（对 ./traces/*.json），退出码 0/1 即流水线结果；gate 自动清理基础设施
```

## 护栏行为（server 强制，agent 不可绕过也不需重复检查）

- **失败类型白名单**：仅 `target-not-found` / `ambiguous` / `timeout` 可修。`assert-failed`
  一律拒绝——断言失败可能是被测系统真 bug，自动改期望等于掩盖缺陷。
- **自愈预算**：同一步最多 2 次尝试、一条 trace 一轮最多 3 处；replay/replay_suite 全绿即清零。
- **验证门**：heal 的修复必须在新标签页全量重放通过才写回；写回是原子 + sidecar 审计。
- **dryRun**：想先验证再写回时用 `dryRun: true`（不落盘、不耗预算）。

## 转人工信号（出现即停止对该 trace 的修复，汇总进最终报告）

| 信号 | 含义 |
|------|------|
| `heal_step` 返回「断言失败不可自动修复」 | 产品行为可能真变了，需人判定是改 trace 还是提 bug |
| 返回「已消耗 N 次自愈尝试/本轮修复周期已消耗 N 次」 | 同一处反复修不好，页面可能大改，需人重新探索 |
| `replay_suite` 同一 trace 连续两轮修复后仍失败 | 超出循环的有效收益，转人工 |

## pipeline 挂接示例

```yaml
# 伪代码，按实际 CI 系统翻译
steps:
  - run: node scripts/ci-harness.mjs up
  - run: ci-agent --mcp-env .scratch/ci-env.json --playbook docs/ci-unattended-loop.md
  - run: node scripts/ci-harness.mjs gate     # 退出码 0/1
```

## 凭证

凭证只走 `vars` / 环境变量注入，**绝不写进 trace**（`save_trace`/`heal_step` 写回都会拒明文）。
CI 里用流水线 secrets 注入 `vars`。
