# 示例

这些示例对着真实模型运行，用来验证整条链路而不只是单元测试里的假模型。

```bash
cp .env.example .env        # 填入 base URL、API key 与模型 id
bun run examples            # 全部运行
bun run examples approval   # 只运行匹配的示例
```

任一示例失败会以非零退出码结束，可直接接进 CI（前提是能访问模型端点）。

## 需要配置

| 变量 | 作用 |
| --- | --- |
| `OPENAI_BASE_URL` | 任意兼容 OpenAI Chat Completions 的端点 |
| `OPENAI_API_KEY` | 该端点的 key |
| `AGENTKIT_MODEL` | 该端点提供的模型 id |

示例统一使用 `OpenAIChatCompletionsModel`。换成 OpenAI Responses 或 Anthropic Messages 适配器时只需替换模型构造，Agent 侧代码不变。

## 各示例验证什么

| 文件 | 覆盖的能力 |
| --- | --- |
| `tool-loop.ts` | 多工具并行调用、`AgentTraceCollector`、`evaluateToolTrajectory`、usage 累计 |
| `structured-output.ts` | `outputSchema` 隐式 `final_answer` 工具、本地 Zod 校验后的 `structuredOutput` |
| `approval.ts` | `approvalMode: "pause"`、`AgentApprovalQueue` 跨进程记录与批准、`resume(agent, runId)`、拒绝不执行 |
| `durable-recovery.ts` | 检查点写入顺序、崩溃后按 `runId` 恢复、同批次重放的 `toolCallId` 幂等键、终态清理 |

`durable-recovery.ts` 值得单独说明：它**故意**在工具执行后重新从同一检查点恢复一次，用来证明重放会带着相同的 `toolCallId` 回来，因此幂等键能拦住重复扣款。这正是持久恢复的 at-least-once 语义，不是 bug。

## 真实模型暴露过的问题

第一次跑 `tool-loop.ts` 时发现 Chat Completions 适配器丢弃了流式响应里的 `reasoning_content`，而 Anthropic 与 Responses 适配器都会发出 `reasoning.delta`。该问题已修复并有 `src/providers/openai/chat-completions.test.ts` 覆盖。这是引入真实端点验收的直接收益。
