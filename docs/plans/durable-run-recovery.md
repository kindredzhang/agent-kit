# AgentKit 实施计划：进程崩溃后的持久恢复

> 日期：2026-11-26。状态：设计已定稿，按切片实施。
> 前置能力：Agent run、工具审批与暂停恢复、Session 持久化、共享预算、工具重试、运行前 Hooks。

## 1. 目标与范围

当前的 `AgentRunState` 只在两个位置产生：审批暂停（`agent.paused`）和 `max_turns` 停止且仍有未执行工具调用时。这两种情况都要求 **进程仍然活着**——快照随事件交给宿主，由宿主决定是否保存。进程崩溃时，进行中的 run 不会留下任何快照，已完成的模型轮次和工具结果全部丢失。

本批增加的是**运行中的检查点**：在 run 还在执行时，把可恢复快照写入宿主提供的存储；进程崩溃后，宿主用 `runId` 从存储取回快照并继续。

范围：

1. 新增 `AgentRunStore` 存储接口与内存、SQLite 两个实现。
2. 在模型请求前和工具批次执行前写入检查点，并在终态清理。
3. 让 `Agent.resume` 支持只凭 `runId` 从存储恢复。
4. 明确恢复语义为 **at-least-once**：崩溃后重新执行的工具批次可能重复产生外部副作用，幂等由宿主与工具承担。
5. 文档、词汇表与路线图同步。

非目标：

- **不承诺 exactly-once**，也不提供分布式事务。检查点、外部副作用和 Session 追加三者无法原子提交。
- 不实现跨进程的并发认领、租约或心跳。同一 `runId` 的并发恢复仍由宿主串行化。
- 不持久化子代理的检查点，也不支持从父 run 恢复整棵任务树。
- 不在检查点里保存模型请求的中间流式状态。已发出的流式输出无法续传，崩溃时该轮请求作废并重发。
- 不实现自动恢复调度、重试队列或 TTL 清理策略。

## 2. 对照依据

| 产品 | 已确认的相关行为 | 对本计划的启发 |
| --- | --- | --- |
| [OpenAI Agents SDK · human-in-the-loop](https://openai.github.io/openai-agents-python/human_in_the_loop/) | `RunState` 可 JSON 序列化；反序列化**不认证**快照或其提交者；审批只表示允许执行，**不保证 exactly-once**；进程在外部副作用之后、保存状态之前崩溃，从旧快照恢复会重复执行；建议为每个逻辑动作分配稳定幂等键，并要求目标端原子去重 | 检查点必须沿用「未签名、宿主负责鉴权」的既有边界；幂等键要在工具执行上下文里天然稳定 |
| [LangGraph · interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) | `interrupt()` 暂停后以同一 `thread_id` 恢复时**节点从头重跑**，因此 interrupt 之前的副作用必须幂等 | 恢复点越靠近副作用，重跑的范围越小；本计划用「模型轮次前」与「工具批次前」两个位置把重跑范围压到最小 |
| 本项目既有约束（[README](../../README.md)、[shared-agent-budget.md](./shared-agent-budget.md)） | `AgentRunState` 未签名、不保证 exactly-once；`AgentBudget.checkpoint()` 在有活跃模型请求时拒绝快照；Session 只在 `agent.completed` 时追加，且单次追加批次原子 | 检查点只能写在两个模型请求之间；写入失败必须让 run 失败，不能假装持久化成功 |

## 3. 领域

- **检查点（Run checkpoint）**：run 执行过程中写入存储的 `AgentRunState`。与审批暂停产生的快照结构相同，区别在写入时机和触发者。
- **恢复位置（Resume point）**：检查点记录的「下一次该做什么」。本批有两种：
  - `model_turn`：消息已包含此前所有工具结果，恢复后从下一轮模型请求继续。
  - `tool_batch`：存在一批尚未执行的工具调用，恢复后（经审批）执行该批次。沿用现有 `AgentRunState` 的语义。
- **重放窗口（Replay window）**：崩溃后会被重新执行的部分。`model_turn` 的重放窗口是「最多一轮模型请求」；`tool_batch` 的重放窗口是「该批次的所有工具调用」。
- **幂等键（Idempotency key）**：工具调用在同一批次重放时保持不变的标识。`ToolExecutionContext.toolCallId` 来自保存的快照，重放时逐字相同，可直接作为外部幂等键。

## 4. 行为设计

### 4.1 存储接口

```ts
export interface AgentRunStore {
  save(state: AgentRunState): Promise<void>;
  load(runId: string): Promise<AgentRunState | undefined>;
  delete(runId: string): Promise<void>;
}
```

- 一个 `runId` 至多一个检查点，`save` 是 upsert（后写覆盖先写）。
- 接口只做单条记录的读写，不承诺并发控制、排序或历史版本。
- 提供 `InMemoryRunStore`（测试与单进程宿主）和 `SQLiteRunStore`（与 `SQLiteSessionStore` 同风格，`run_id` 主键，`save` 在事务内执行）。
- 存储整体可被宿主替换；AgentKit 不规定序列化格式之外的任何存储约束。

### 4.2 写入时机

配置 `AgentOptions.runStore` 后，run 在以下两处写入检查点：

1. **每轮模型请求前**，位于上下文压缩之后、`beforeModel` hook 与预算认领之前。保存 `resumeAt: "model_turn"`：消息是压缩后的当前上下文，`pendingToolCalls` 与 `approvalDecisions` 为空。
2. **执行工具批次前**，位于参数解析与审批全部完成之后。保存 `resumeAt: "tool_batch"`：消息以带工具调用的助手消息结尾，`pendingToolCalls` 为该批次，审批决定一并保存。

两处都满足 `AgentBudget.checkpoint()` 的前提（没有活跃模型请求）。未配置 `runStore` 时不产生任何额外开销，行为完全不变。

每次写入发出一条 `agent.checkpointed` 事件：

```ts
{ type: "agent.checkpointed"; runId: string; turn: number; resumeAt: "model_turn" | "tool_batch" }
```

事件不带快照本体——快照已在存储中，重复塞进事件流只会放大内存与传输成本。宿主需要内容时直接读存储。

写入失败按 run 失败处理：发出 `agent.failed`，错误为存储抛出的异常。持久化是宿主显式要求的语义，静默降级会让宿主误以为存在可恢复点。

### 4.3 恢复位置与校验

`AgentRunState` 增加可选字段 `resumeAt?: "model_turn" | "tool_batch"`，缺省视为 `"tool_batch"`，因此此前保存的快照无需迁移。

- `resumeAt: "model_turn"` 时，校验要求 `pendingToolCalls` 为空、`approvalDecisions` 为空、没有 `pendingApproval`、最后一条消息不是尚未执行的助手工具调用消息。恢复后该轮按**普通轮次**处理：重新压缩上下文、重新请求模型，审批决定不跨轮沿用。
- `resumeAt: "tool_batch"` 时保持现有校验与恢复路径不变。
- 若保存的轮次高于新 Agent 的 `maxTurns`：`tool_batch` 沿用现有行为（再次以 `max_turns` 停止并保留快照）；`model_turn` 直接以 `max_turns` 停止，事件不带 `message`。
- 旧版本 AgentKit 读到带 `resumeAt: "model_turn"` 的快照时，会因为 `pendingToolCalls` 为空而在校验阶段报错——安全失败，不会误执行。

`Agent.resume` 的输入扩展为「状态或运行 id 二选一」：

```ts
agent.resume({ runId: "..." });                    // 从 runStore 载入检查点
agent.resume({ state, approval: { ... } });       // 现有用法不变
```

`runId` 形式要求配置了 `runStore`，载入结果必须存在且 `state.runId` 与请求的 id 一致，否则以 `agent.failed` 结束。两者同时提供、或都不提供，同样是错误。

### 4.4 终态与清理

检查点代表「这个 run 还能继续」。因此：

| 终态 | 清理行为 | 理由 |
| --- | --- | --- |
| `agent.completed` | 删除 | run 已结束，继续恢复只会重复提交 |
| `agent.failed` | 删除 | 失败不可恢复，残留检查点会诱使宿主重放 |
| `agent.stopped` 且 `stopReason` 为 `cancelled` / `length` / `context_limit` / `budget_exceeded` / `usage_unavailable` | 删除 | 不可恢复的停止 |
| `agent.stopped` 且带 `runState`（`max_turns`） | 保留 | 该状态仍可恢复；宿主已同时收到快照 |
| `agent.paused` | 保留 | run 正在等待审批，崩溃后仍应能恢复到暂停点 |

删除发生在终态事件**交给宿主之前**：宿主一旦观察到终态，就不会再看到对应的检查点。删除失败时事件流抛出异常而不是发出终态事件——「你永远不会观察到一次没有清理检查点的结束」比「结束事件一定送达」更重要。

宿主中途放弃消费事件流（break 或直接丢弃生成器）不属于终态，检查点会保留。这是有意的：放弃消费不等于 run 结束。宿主可显式 `runStore.delete(runId)`。

### 4.5 副作用与幂等协议

持久恢复把「进程崩溃」变成「批次重放」，因此必须把重放范围与幂等要求写成契约：

- **重放范围**：崩溃发生在模型请求期间，最多重发该轮请求；崩溃发生在工具执行期间，重发整个批次（包括已完成的工具）。
- **幂等键**：同一批次重放时 `toolCallId` 保持不变。会产生外部副作用的工具应把 `toolCallId`（或宿主拼接的 `runId:toolCallId`）作为幂等键传给下游，由下游原子去重。审批决定的重放同理，不会重复请求审批。
- **不可重放的动作**：无法幂等的工具（如发送通知、扣款）必须依赖下游幂等键；AgentKit 无法提供补偿。这与现有 `AgentRunState` 文档中的约束一致，只是从「暂停恢复」扩展到了「崩溃恢复」。
- **Session**：run 进行中不追加 Session，只在 `agent.completed` 时追加。检查点保存 `messagesToAppend`，恢复后完成时一次性写入。若崩溃恰好发生在「Session 已追加、检查点尚未删除」之间，恢复时的历史基线校验会发现 Session 已变化并拒绝恢复——安全失败，不会重复追加。
- **用量与预算**：检查点保存预算账本。恢复 `model_turn` 检查点时，崩溃前那次模型请求的用量不可知，因此账本被标记为不完整：启用 `maxTotalTokens` 时下一次请求以 `usage_unavailable` 停止，未启用时正常继续。这是有意保守——崩溃的请求很可能已在服务端计费。`model_turn` 检查点本身在请求前写入，保存时账本仍是完整的。

### 4.6 安全边界

- 检查点**未签名**，与现有快照一致。宿主必须保护存储、在恢复前鉴权、原子认领并防止并发恢复同一个 `runId`。
- 检查点包含完整消息、工具参数与结果，可能含用户内容与密钥。存储的访问控制与加密由宿主负责。
- `resumeAt: "model_turn"` 的快照不携带待执行工具调用，降低「被篡改成执行任意工具」的表面积；但 `tool_batch` 快照仍会被校验工具定义与审批策略的指纹，沿用现有防护。
- 存储不校验快照来源。`load` 返回的数据一律视为不可信输入，恢复时走完整校验。

### 4.7 与其他能力的交互

- **子代理**：`createSubagentTool` 启动的子 run 不继承 `runStore`。父 run 崩溃后重放子代理工具调用，会重新启动子 run。子 run 内部的检查点不属于本批范围。
- **Hooks**：`beforeModel` 位于检查点之后，恢复时重新执行；`beforeTool` 位于工具批次检查点之后，重放时同样重新执行。Hook 必须可重复调用。
- **工具重试**：重试发生在单次工具执行内部，崩溃后重放的仍是「整个批次」，两者层次不同。
- **模型请求重试**：只处理同一进程内的瞬时错误；崩溃恢复由检查点负责，两者不重叠。

## 5. 接口草图

```ts
const agent = new Agent({
  model,
  tools: [chargeCard],
  runStore: new SQLiteRunStore(database),
});

for await (const event of agent.stream({ messages, sessionId: "order-42" })) {
  if (event.type === "agent.checkpointed") {
    metrics.increment("agent.checkpoint", { resumeAt: event.resumeAt });
  }
}

// 崩溃后（可能是另一个进程）
for await (const event of agent.resume({ runId: savedRunId })) {
  // ...
}
```

## 6. 切片与验收测试

| 切片 | 交付 | 公共接口验收 |
| --- | --- | --- |
| B1 | `AgentRunStore`、`InMemoryRunStore`、`SQLiteRunStore` | 保存后可载入、覆盖写生效、删除后载入为空；SQLite 跨实例可见；非法 `runId` 与损坏 JSON 被拒绝 |
| B2 | 检查点写入、`agent.checkpointed`、终态清理、`resumeAt` 校验 | 每轮两次写入且顺序为先 `model_turn` 后 `tool_batch`；completed 后存储为空；`max_turns` 与 `paused` 后保留；写入失败转为 `agent.failed`；未配置存储时无事件、无行为变化 |
| B3 | `resume({ runId })` 与 `model_turn` 恢复 | 从 `model_turn` 检查点恢复不重放已完成的工具；从 `tool_batch` 检查点恢复重放该批次且 `toolCallId` 不变；`runId` 缺失/不匹配/未知均安全失败；Session 历史变化被拒绝 |
| B4 | README、GLOSSARY、路线图、全量回归 | 说明 at-least-once、幂等键、清理规则与安全边界；`bun test`、`bun run tsc --noEmit`、`git diff --check` 通过 |

测试以 `Agent.stream()` / `Agent.resume()` 与 `AgentRunStore` 为接缝，使用确定性模型与内存存储；SQLite 切片用 `bun:sqlite` 的 `:memory:` 数据库，不依赖真实模型或真实文件。

## 7. 待定问题

1. 检查点保存完整 `sessionHistory`，长会话下每次写入是 O(会话长度)。后续可改为保存「历史基线引用 + 偏移」，但需要 Session 存储提供版本号，本批不做。
2. 是否为检查点增加 TTL 或数量上限。当前交给宿主的存储策略；本批不内建清理任务。
3. 是否把 `agent.checkpointed` 写入 trace。当前 trace 已能表达暂停与停止，检查点属于存储细节，暂不进入 trace。
