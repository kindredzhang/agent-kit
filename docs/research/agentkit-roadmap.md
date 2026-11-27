# AgentKit 路线图研究：主流 Agent 产品与框架的设计取舍

> 调研日期：2026-11-24。范围：只使用官方一手文档、规范和第一方仓库。
> 目标：在 AgentKit 现有的「厂商无关消息/流事件 + Zod 工具 + 多轮工具循环」之上，判断接下来该补哪些原语、按什么顺序补、哪些应当推迟。

---

## 1. 现状盘点（作为基线）

AgentKit 目前具备（读代码得出，非外部资料）：

- `LanguageModel` 单一抽象 + 三个适配器（OpenAI Chat Completions、OpenAI Responses、Anthropic Messages）；
- `defineTool` 把 Zod schema 转成 JSON Schema，执行前校验；工具失败以错误结果回灌模型；
- 工具策略包含 `readOnly`、`destructive`、`idempotent` 与进程内审批；明确标记为只读且非破坏性的工具可并行，其他工具默认需要审批并按序执行；
- Agent run 提供独立的停止原因和累计 usage，`AbortSignal` 已贯穿到 `ModelRequest` 与 `ToolExecutionContext`；
- 可选的 run-local 上下文预算与确定性压缩：按需估算完整模型输入，移除较早的完整对话或工具交互，并以事件报告缩减；
- `SessionStore` 支持内存与 SQLite 实现，可跨 run 加载和追加对话历史；
- 完整事件流覆盖 run、model turn、消息、工具执行、审批与上下文压缩；`AgentRunState` 支持在审批暂停或 `max_turns` 停止时恢复同一 run。

后续可对照的能力包括 hooks/中间件、追踪、评估、MCP、子代理与跨代理预算；不同产品覆盖范围和实现层级不同，不能视为五家都内建了全部能力。

- `AgentTraceCollector` 将 run、turn、模型调用与工具执行组织成可导出的追踪记录；`evaluateToolTrajectory` 支持确定性的工具轨迹评估。

下一阶段聚焦 MCP 与子代理的接入形态。

---

## 2. 对比：产品体验模式 vs 框架原语

分开看这两层很重要：**产品体验**决定了原语必须长成什么样，**框架原语**才是 AgentKit 要写进 `src/core` 的东西。

### 2.1 产品体验层（用户可感知的六种模式）

| 体验模式 | 代表实现 | 对原语的硬性要求 |
| --- | --- | --- |
| 副作用操作前的**审批卡片** | Claude Code 的 `canUseTool` 回调与六步求值流程（hooks → deny → ask → 权限模式 → allow → 回调），模式含 `default`/`dontAsk`/`acceptEdits`/`plan`/`auto`/`bypassPermissions`；Auto 模式由分类器模型逐个放行或拦截 shell 与网络请求（[permissions](https://code.claude.com/docs/en/agent-sdk/permissions)） | 应在工具执行前检查策略；若审批要跨进程或稍后恢复，运行状态还需可序列化，并能继续同一个 run |
| **会话延续 / 分叉** | Agent SDK 的 resume/fork 与 `sessionStore` 双写；OpenAI Responses 的 `previous_response_id` 链式与 30 天 `store`（[conversation state](https://developers.openai.com/api/docs/guides/conversation-state)） | 需要 session id + 可持久化的消息历史 + 可选的「分叉」语义 |
| **压缩可见的边界** | Agent SDK 自动压缩时发出 `compact_boundary` 系统消息；`PreCompact` hook 可在压缩前归档全文（[agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)、[hooks](https://code.claude.com/docs/en/agent-sdk/hooks)） | 压缩必须是一个可拦截事件，而不是藏在适配器里的静默改写 |
| **预算与轮次的硬停** | `maxTurns` + `maxBudgetUsd`，子代理开销计入同一预算，触顶时拒绝继续派生并停掉后台子代理（[agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)、[subagents](https://code.claude.com/docs/en/agent-sdk/subagents)） | usage 要按次累积并进入同一个可中断的预算判定 |
| **可观测的时间线** | Agents SDK 默认开启追踪，`task_span` → `turn_span` → agent / generation / function_call / guardrail / handoff 各成 span；可由 `add_trace_processor()` 加处理器（[tracing](https://openai.github.io/openai-agents-python/tracing/)） | 事件粒度必须比「一次 run」更细，且要能挂父级关系 |
| **子代理的上下文隔离** | 子代理独立上下文，只有最终消息回到父级；深度默认 3 层、并发默认 20（[subagents](https://code.claude.com/docs/en/agent-sdk/subagents)） | 「代理即工具」的返回值必须是摘要，而不是子代理完整 transcript |

### 2.2 框架原语层（同样的能力，不同的元模型）

| 维度 | OpenAI Agents SDK | Anthropic Agent SDK | LangGraph | Google ADK | Vercel AI SDK |
| --- | --- | --- | --- | --- | --- |
| 控制流 | 内建循环 + handoff / agents-as-tools（[multi-agent](https://openai.github.io/openai-agents-python/multi_agent/)） | 内建循环，由宿主进程托管（[overview](https://code.claude.com/docs/en/agent-sdk/overview)） | 显式图：共享 state + nodes + edges（[overview](https://docs.langchain.com/oss/python/langgraph/overview)） | `LlmAgent` + 工作流 agent（sequential/loop/parallel）（[workflows](https://adk.dev/workflows/)） | `ToolLoopAgent` + `stopWhen` / `prepareStep`（[loop control](https://ai-sdk.dev/docs/agents/loop-control)） |
| 校验与边界检查 | guardrails：input 只作用于链首、output 只作用于链尾、tool guardrail 每次调用都跑；`run_in_parallel=True` 默认并行但会「已经花掉 token」；tripwire 立即中止（[guardrails](https://openai.github.io/openai-agents-python/guardrails/)） | hooks：`PreToolUse`/`PostToolUse`/`SubagentStart`/`PreCompact`，在宿主进程运行、不占上下文，可短路（[hooks](https://code.claude.com/docs/en/agent-sdk/hooks)） | 图节点本身即检查点 | callbacks：before/after agent/model/tool，**返回值可覆盖下一步**（返回 `dict` 直接替代工具结果）（[callbacks](https://adk.dev/callbacks/)） | `wrapLanguageModel` 中间件：`transformParams`/`wrapGenerate`/`wrapStream`（[middleware](https://ai-sdk.dev/docs/ai-sdk-core/middleware)） |
| 审批 | `needs_approval`；中断写入 `RunResult.interruptions`，`to_state()` → `approve/reject` → 以 `RunState` 恢复；`RunState` 可 JSON 序列化，**匿名无签名，且不保证 exactly-once**，需幂等键（[human-in-the-loop](https://openai.github.io/openai-agents-python/human_in_the_loop/)） | 权限求值 + 回调；模式可在会话中动态切换 | `interrupt()` 暂停 → `Command(resume=...)` + 同 `thread_id` 恢复；**节点从头重跑**，故 interrupt 之前的副作用必须幂等（[interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)） | before_tool 回调返回 dict 即跳过真实工具 | `toolApproval: { getWeather: 'user-approval' }`；`approval-requested` 状态终止循环并报 `stoppedBy: 'approval'`；服务端可用 `experimental_toolApprovalSecret` 校验审批来源（[chatbot tool usage](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage)、[loop control](https://ai-sdk.dev/docs/agents/loop-control)） |
| 持久化 | Session（`get_items`/`add_items`/`pop_item`/`clear_session`）；SQLite/Redis/加密后端；`limit=N` 只取最近 N 条（[sessions](https://openai.github.io/openai-agents-python/sessions/)） | session id + resume/fork + 可选 `sessionStore` 双写 | checkpointer 按 `thread_id` 存 checkpoint + 跨线程 Store | SessionService（events + state）+ 跨会话 MemoryService（[sessions](https://adk.dev/sessions/)） | 本身不提供，交由上层 |
| 流式粒度 | 事件流 + 独立追踪数据 | `AssistantMessage`(每 content block)/`UserMessage`/`StreamEvent`/`ResultMessage` | `values`/`updates`/`messages`/`custom`/`debug`，`subgraphs=True` 时用 `ns` 标识来源（[streaming](https://docs.langchain.com/oss/python/langgraph/streaming)） | events | UI 侧 tool parts 状态机（`input-available` → `output-available` …） |
| 评估 | 依赖追踪导出到第三方 | 依赖追踪 | 依赖外部 | 内建：`tool_trajectory_avg_score`（轨迹精确匹配）、`response_match_score`（ROUGE-1）、LLM 裁判、用户模拟，`adk eval` 进 CI（[evaluate](https://adk.dev/evaluate/)） | telemetry 事件供外部 |

**从这张表能读出的三条结论：**

1. 这些产品普遍提供模型驱动的工具循环；LangGraph 则把显式状态图作为核心抽象，ADK 也提供顺序、循环和并行工作流。它们展示的是不同复杂度的控制流选项，不能据此断言某一种抽象适合所有场景。AgentKit 目前以单个循环为主，先把这个控制流的安全性、停止原因和可恢复性做好，再根据真实需求决定是否加图编排。
2. **如果 AgentKit 要支持跨进程或稍后恢复的审批**，运行状态必须可序列化，恢复时需验证同一个 run/session 的身份与待审批调用。单进程内通过回调等待批准，则不必一开始就引入持久化快照。
3. 持久化恢复不是事务：OpenAI 文档说明序列化的 `RunState` 本身不负责认证，且不保证 exactly-once；LangGraph 文档说明恢复时节点会从头执行，因此前置副作用要幂等。AgentKit 的 `AgentRunState` 同样是未签名快照；宿主必须负责鉴权、原子认领和防止并发重复恢复，外部副作用应使用幂等键。

### 2.3 一个容易被忽略的细节：工具并发不是免费的

Agent SDK 的策略是**只读工具并发、写工具串行**，自定义工具默认串行，需要 `readOnlyHint` 注解才并发（[agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)）。MCP 规范要求客户端把工具注解视为不可信信息，建议始终保留人类拒绝调用的能力，并建议把工具执行错误回传给模型以便纠正；规范没有强制要求每次调用都弹出确认界面（[MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)）。

AgentKit 已将工具注解与审批策略用于执行规划：明确标记为只读且非破坏性的工具可以并行，其他工具默认需要审批并顺序执行。注解仍是定义者声明，宿主需要在接入远程工具时验证其策略元数据。

---

## 3. 对 AgentKit 的分期建议

排序原则：**先明确 run 为什么结束，再给有副作用的工具加执行策略，然后限制单次 run 的上下文增长，再实现跨 run Session；同一 run 的暂停恢复、追踪与扩展随后推进**。当前 `instructions` 已由 [Anthropic 适配器](../../src/providers/anthropic/messages.ts) 合并到顶层 `system` 参数，不需要列为待修问题。审批若只在当前进程内等待，不依赖可序列化快照；只有跨进程暂停/恢复才需要 run state。

### 阶段 0：终止语义与运行边界（已完成）

- run 级 `stopReason` 独立于模型 `FinishReason`，区分正常完成、拒答、轮数耗尽、取消、输出截断、上下文限额与错误。
- 若 provider 提供 usage，成功、失败、取消和限额停止的最终事件都会携带累计 usage。
- `maxTurns` 将每次模型响应计为一轮；最后一轮仍要求工具时，不执行该批工具，并以 `agent.stopped` / `max_turns` 表达限额停止。

理由：调用方需要稳定判断是否可重试、是否已完成、是否需要提高预算；后续预算、追踪、审批恢复也都依赖清楚的终止状态。

### 阶段 1：工具策略与进程内审批（已完成）

- 工具支持 `readOnly`、`destructive`、`idempotent` 注解与 `requiresApproval` 显式覆盖。注解是定义者声明，允许运行的决策仍由 Agent 策略和宿主审批决定。
- 明确只读且非破坏性的工具可并行；其他工具默认需要审批并顺序执行。
- `approveTool` 在工具执行前处理进程内审批。拒绝、缺少审批处理器、审批失败与取消都有明确的审批结果事件。
- 工具执行错误仍会作为结果回填模型；审批回调收到工具定义、原始调用、校验后的参数与运行上下文。

这一阶段明确了 AgentKit 作为库在工具执行上的默认策略：哪些工具可以并行、哪些调用需要宿主批准。工具注解不可信、策略由宿主控制的约束应写入文档（[MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)）。

### 阶段 2：run-local 上下文预算与压缩（已完成）

- 通过可选的 `maxContextTokens` 限制每次模型请求的输入上下文，输出上限仍由 `maxOutputTokens` 控制；默认估算器提供厂商无关的近似值，`estimateContextTokens` 允许宿主替换估算方式。
- 超预算时按顺序移除较早的完整对话轮次或工具交互组，保留 system/developer 指令与当前 user 请求；assistant 工具调用及其整批结果作为一个压缩单元。
- 每次缩减发出 `agent.context.compacted`，仅包含缩减前后估算值和移除轮次数；保留内容仍超限时，在调用模型前以 `context_limit` 停止。压缩不调用模型生成摘要。

### 阶段 3：Session 持久化与跨 run 对话（已完成）

- `SessionStore` 提供 `load(sessionId)` / `append(sessionId, messages)` / `clear(sessionId)`，并提供内存实现与 `bun:sqlite` 实现；SQLite 的每次 append 批次在事务内写入。
- `AgentRunInput` 接收 `sessionId` 与本次新增 `messages`。新 Agent 实例可以从同一个 Session 延续已完成的对话；`instructions` 不进入历史，run-local 上下文压缩也不会改写 Session。
- 只有以 `agent.completed` 结束的 run 会追加 Session。停止、取消或失败的 run 不持久化；宿主需串行执行相同 `sessionId` 的 run。

#### 同一 run 的暂停与恢复（已完成）

- `AgentRunState` 保存当前消息、未执行的工具调用、审批决定、Session 基线、轮次与累计 usage；`agent.paused` 暴露审批暂停点，`agent.stopped` 在 `max_turns` 且仍有待执行工具调用时携带快照。`Agent.resume()` 沿用原 `runId`，不会重放产生待审批工具调用的模型请求。
- 恢复时校验快照版本、provider、Agent 配置、工具定义与审批策略，并确认 Session 历史没有变化。增加轮数预算后可继续；若保存轮次已超出新上限，则再次以 `max_turns` 停止并保留快照。
- 快照可 JSON 序列化，但不带签名，也不保证 exactly-once。宿主负责鉴权、保护敏感内容、原子认领与避免重复恢复；会产生副作用的工具应使用外部幂等键（[OpenAI human-in-the-loop](https://openai.github.io/openai-agents-python/human_in_the_loop/)、[LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)）。底层模型部署和自定义上下文估算器的兼容性也由宿主保证。
- 明确不做：向量化长期记忆 / MemoryService。ADK 的 Session 与 Memory 是两层，AgentKit 先把第一层（线程内）做对，跨线程记忆属于应用层。

### 阶段 4：追踪与评估（已完成）

- `AgentTraceCollector` 消费 `AgentEvent`，生成 run → turn → 模型调用与工具执行的 span 树。记录包含时间、审批、上下文压缩、用量与运行结果。操作名使用 `invoke_agent`、`step`、`chat`、`execute_tool`，宿主可填入 `requestModel` 并将记录映射到所用的遥测系统。收集器无新增运行时依赖。([AI SDK telemetry](https://ai-sdk.dev/docs/ai-sdk-core/telemetry))
- `evaluateToolTrajectory` 按执行开始事件比较轮次与工具名，并报告首个差异。Bun 测试使用固定模型响应验证正序、错序、缺失和额外执行，覆盖并行与审批恢复。([ADK evaluate](https://adk.dev/evaluate/))
- `recordInputs` 与 `recordOutputs` 默认关闭，宿主可独立开启工具入参、助手正文及成功的工具结果记录。暂停与恢复记录通过 `runId` 关联。

### 阶段 5：MCP 与子代理（已完成）

实施计划：[docs/plans/mcp-and-subagents.md](../plans/mcp-and-subagents.md)。MCP 客户端工具接入（`createMCPToolSource`）与子代理（`createSubagentTool`）均已完成，全量 55 项测试通过。

- MCP 只做客户端侧的工具接入：`tools/list` → 适配为 `AgentTool`，`annotations` 直接喂给阶段 1 的审批策略；工具执行错误（`isError: true`）按现有「错误结果回灌模型」路径处理（[MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)）。传输由宿主负责，适配器只依赖结构化客户端接口。
- 暂停快照已保存工具定义并按 JSON 比较，恢复时工具定义变化会被拒绝，覆盖「工具定义被替换」类攻击面（AI SDK 文档明确建议对已审批工具做 fingerprint）（[MCP tools (AI SDK)](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools)）。
- 子代理**先做 agents-as-tools，不做 handoff**：子代理作为一个工具，输入任务描述、输出摘要，父代理保留控制权与聚合。这正是 OpenAI 对「有界子任务」的推荐用法，且天然复用阶段 1–3 的工具作用域、审批与追踪（[multi-agent](https://openai.github.io/openai-agents-python/multi_agent/)）。
- 与子代理一同交付了深度与并发两道硬上限（默认 3 / 2）。跨代理共享预算已在后续批次完成：`Agent.stream` 的 `budget.maxModelCalls` 与 `maxTotalTokens` 由根 run 和经 `createSubagentTool` 启动的后代共用账本，详见 [docs/plans/shared-agent-budget.md](../plans/shared-agent-budget.md)；`onUsage` 仍只上报单个子 run 的 usage。没有上限的子代理会瞬间放大成本，且预算必须跨代理共享，否则「预算」只是个装饰。

### 阶段 6：运行前 Hooks 与结构化输出（已完成）

- `Agent` 的 `hooks.beforeModel` / `hooks.beforeTool` 在模型请求和工具实际执行前提供可抛错的检查点。`beforeModel` 位于上下文压缩之后、预算认领之前；`beforeTool` 位于参数解析与审批之后，恢复后的待执行工具会重新检查。Hook 收到副本，不能修改实际请求。它们不向子代理继承，也不进入恢复快照，宿主恢复时需提供一致策略。
- `outputSchema` 把一个隐式只读 `final_answer` 工具加入模型工具列表，最终结果经本地 Zod 校验后以 `structuredOutput` 返回；校验失败按工具错误回灌模型，未调用时插入一条不写入 Session 的 developer 提醒。实现不依赖厂商原生 JSON 模式，因此三个适配器行为一致，代价是多一次工具往返。设计取舍：只接受单独成轮的输出调用，拒答、截断和 `max_turns` 都不产生结构化结果。

### 阶段 7：进程崩溃后的持久恢复（已完成）

实施计划：[docs/plans/durable-run-recovery.md](../plans/durable-run-recovery.md)。

- `AgentOptions.runStore` 接收 `AgentRunStore`（`save` / `load` / `delete`），提供内存与 SQLite 实现。检查点每轮写两次：模型请求前的 `model_turn` 与工具批次执行前的 `tool_batch`，都在没有活跃模型请求时写入；每次写入发出 `agent.checkpointed`，事件不带快照本体。
- `Agent.resume({ runId })` 从存储恢复，`Agent.resume({ state, approval })` 保持不变。检查点未签名，与既有 `AgentRunState` 边界一致：宿主负责存储保护、鉴权、原子认领与防并发恢复（[OpenAI human-in-the-loop](https://openai.github.io/openai-agents-python/human_in_the_loop/)）。
- 恢复语义明确为 **at-least-once**：崩溃后重放窗口是「一轮模型请求」或「一个工具批次」。同一批次重放时 `toolCallId` 不变，可直接作为外部幂等键；这与 LangGraph「恢复时节点从头重跑、前置副作用必须幂等」的约束同源（[LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)）。
- 终态清理：completed / failed / 不可恢复的 stopped 删除检查点，paused 与带 `runState` 的 `max_turns` 保留并刷新。删除先于终态事件送达宿主。写入失败按 run 失败处理，不静默降级。
- Session 仍在 `agent.completed` 时追加；崩溃若落在「Session 已写、检查点未删」之间，恢复时的历史基线校验会安全拒绝。子代理不继承 `runStore`。

### 阶段 8：审批队列（已完成）

`AgentApprovalQueue` 把「暂停 → 落库 → 另一个进程批准 → 恢复」收进库内，`AgentApprovalStore` 提供内存与 SQLite 实现。

- `observe()` 包装事件流并在旁边记录 `agent.paused` 的待审批调用，同时透传全部事件；遇到终态清空该 run 的请求。
- 请求键是 Agent 生成的 `approvalId`，不是模型给的 `toolCallId`：后者在同一 run 的后续轮次可能重复，前者每次暂停都是新值。每个 run 至多保留一条记录。
- `decide()` 拒绝重复决定与未知请求，`resume(agent, runId)` 把已记录的决定喂回 `agent.resume`。鉴权、原子认领与并发去重仍归宿主。
- 与 [OpenAI human-in-the-loop](https://openai.github.io/openai-agents-python/human_in_the_loop/) 的 `RunState` 一样，队列本身不认证、不保证 exactly-once。

### 阶段 9：可发布形态（已完成）

包从「私有源码仓库」变成可安装的 ESM 包。

- `package.json` 补全 `version`、`license`、`repository`、`files`、`exports` 与 `prepublishOnly`。`zod` 是唯一的运行时依赖。
- `openai` 与 `@anthropic-ai/sdk` 在源码里只做类型用，因此移入可选 `peerDependencies`。适配器移出核心入口，改由 `agent-kit/openai` 与 `agent-kit/anthropic` 子路径导出——只用核心 API 的宿主不再需要安装任何厂商 SDK。
- SQLite 存储不再 import `bun:sqlite`，改为接受结构化 `SQLiteDatabase` / `SQLiteStatement` 接口。`bun:sqlite` 的 `Database` 天然满足该接口，`dist/**/*.d.ts` 因而不泄漏 Bun 类型。
- 源码相对导入统一带 `.js` 后缀，声明文件在 `moduleResolution: "nodenext"` 下可解析；构建改用 `tsc`（`tsconfig.build.json`）保结构输出，产物同时供 Node ESM 与 Bun 使用。
- `src/package.test.ts` 把上述约定固定成测试：出口形状、依赖面、核心声明不含厂商 SDK 与 `bun:sqlite`、声明文件相对导入带扩展名。

### 阶段 10：持续集成（已完成）

此前所有检查都靠本地手动运行，改动是否破坏发布形态没有第三方见证。

- `.github/workflows/ci.yml` 分四个 job：`typecheck`、`test`、`package`、`examples`。前三个在每次 push 到 `main` 和每个 PR 上运行；`examples` 只在 push 且仓库变量 `AGENTKIT_LIVE_EXAMPLES` 为 `true` 时运行。
- `scripts/verify-package.ts` 把阶段 9 的消费者验收固化成脚本：`npm pack` 出 tarball，装进干净的临时项目，再检查 tarball 内容、Node 能否加载三个入口、可选 peer 是否被误装、以及消费者在 `moduleResolution: "nodenext"` 下只用核心 API 能否通过类型检查。CI 里执行它的是 `package` job，本地等价命令是 `bun run verify-package`。
- 该脚本做过反向验证：在消费者里 import `agent-kit/openai` 且不装 SDK 时，`tsc` 如期报 `TS2307`——说明「核心类型可解析」的检查不是空转。
- `examples` job 的开关放在仓库变量而不是 secret 上，因为 GitHub Actions 的 job 级 `if` 只允许 `github`、`needs`、`vars`、`inputs` 四个上下文，`secrets` 在其中不可用（[context availability](https://docs.github.com/en/actions/learn-github-actions/contexts#context-availability)）。开关打开但三个 secret 缺任何一个时，该 job 显式失败，避免「看着绿其实没跑」。

### 阶段 11：超时与墙钟预算（已完成）

此前轮次、上下文、调用次数、token 都有上限，只有时间没有。一个永不 resolve 的工具或不返回的网关连接会让 run 无限期占住进程，而其余越界都能优雅降级成 `agent.stopped`。

- 时间并入既有 `AgentBudget` 而不是新增概念：`maxDurationMs` 加进 `AgentBudgetOptions`，`elapsedMs` 加进 `AgentBudgetSnapshot`。快照、检查点、trace、`agent.budget.updated` 全部免费复用，停因沿用 `budget_exceeded`。
- 计时按**活跃时间**累积，暂停期间不计。`AgentBudget` 维护 `elapsedBeforeSegment` 与 `segmentStartedAt`，`startClock` / `stopClock` 用深度计数，使共享预算的子代理 run 不会重复计时。`elapsedMs` 进快照，所以崩溃恢复后是接着算剩余额度，而不是重新计时——否则持久恢复就成了绕过时间上限的通道。
- 预算派生一个 `AbortSignal`，与宿主的 `input.signal` 用 `AbortSignal.any` 合成 `runSignal`，只注入在途的模型请求、工具执行与重试等待。**用户取消与预算耗尽因此保持语义分离**：`signal` 仍表示宿主取消，既有 8 处 `signal?.aborted → cancelled` 判断不受影响；预算耗尽走原生的 `claim()` 路径产出 `budget_exceeded`。第一版把预算信号直接并进 `signal`，导致忽略 abort 的工具会被报成 `cancelled`，由 `reports the wall-clock budget, not cancellation, when a tool ignores the abort` 固定住。
- `defineTool({ timeoutMs })` 提供单次尝试粒度：超时抛 `TimeoutError`，走普通工具失败路径（`tool.execution.failed`、错误回灌模型、run 继续），并与 `retry` 正交叠加。
- 实现细节：超时定时器**不能** `unref()`。Bun 会因此认为没有挂起句柄而直接退出，定时器永不触发；`unref` 只适用于「不该阻止进程退出」的辅助定时器，而超时定时器恰恰是应该保持进程活着的那个。

### 阶段 12：OpenTelemetry 导出（已完成）

追踪记录早就能序列化，但把它接进主流可观测栈还得用户自己写映射。这一阶段把 `AgentTrace` 转成符合 [GenAI 语义约定](https://github.com/open-telemetry/semantic-conventions-genai) 的 span 树，放在新子路径 `agent-kit/otel`。

- **不发明 span 类型**。语义约定里只有 `invoke_agent`、`chat`、`execute_tool` 三类适用于本库；`plan` 明确要求「无法区分规划与普通推理时不应上报」，而轮次（`step`）在规范中没有对应物。所以 turn 不是 span，chat 与 execute_tool 直接挂在 run span 下。
- **子路径依赖而非结构化接口**。原本打算沿用 `SQLiteDatabase` 的做法定义一个 `Tracer` 形状接口来绕开依赖，但父子关系只能经由 OTel 的 Context API（`trace.setSpan(context.active(), span)` + 把 context 传给 `startSpan`）建立，结构化接口在这里建不出真正的 span 树。于是与 `agent-kit/openai` 依赖 `openai` 同理：`@opentelemetry/api` 放进 optional peer，核心入口仍然零依赖。
- **内容捕获必须显式开启**。`gen_ai.output.messages`、`gen_ai.tool.call.arguments`、`gen_ai.tool.call.result` 属于规范里的 opt-in 属性，可能含用户数据；它们只在 `AgentTraceCollector` 打开 `recordInputs` / `recordOutputs` 时才出现。OTel JS 的 `setAttribute` 只接受原始值与同类数组，所以这些 JSON 结构序列化成字符串。
- **错误只留类型名**。既有的 trace 测试明确要求错误消息不进入追踪记录（可能含敏感信息），因此 `AgentTraceError` 只有 `name`；span 上的 `error.type` 与 `status.message` 都用它。这与规范要的「低基数错误标识」正好一致。
- **`AgentTrace` 补了两个字段**：`error`（run 与工具各一份）和 `sessionId`（映射成 `gen_ai.conversation.id`）。`agent.started` / `agent.resumed` 事件相应带上可选 `sessionId`。
- 采集器按 `record()` 调用时刻打时间戳，这一点在导出时才暴露出来：先把事件收集成数组再回放，所有 span 时长会塌成零。README 已写明要边流边记。
- `verify-package` 增加了双向检查：没装 `@opentelemetry/api` 时 `agent-kit/otel` 必须报 `ERR_MODULE_NOT_FOUND`，装上后必须能导出真实 span 并通过 `nodenext` 类型检查。负向检查做过实证，不是空转。

### 阶段 13：假模型（已完成）

核心行为一直靠测试文件里手写的 `LanguageModel` 假对象验证，但每个测试文件都重写一遍流式分片、工具调用 id、终态推导，而且宿主要测自己的工具时同样得从头写。这一阶段把这套东西抽成公开子路径 `agent-kit/testing` 的 `createFakeModel()`。

- **以「轮」为脚本单位，不以事件为单位**。使用者脑子里想的是「这一轮模型说什么」，不是「先发 3 个 text.delta 再发 finish」。分片、id 生成、`finishReason` 推导都属于实现细节，由假模型负责。
- **脚本用尽必须报错，不能重复最后一轮**。静默重复是最容易写出来的"友好"行为，但它会让「Agent 是否多发了一次模型请求」这类断言永远为真——测试会意外通过，而不是失败。现在第二十次请求会得到 `The fake model has no scripted turn for request N.`。
- **`error` 与 `hang` 是一等公民**。重试、超时、取消这几条路径正是宿主最难自测的，所以脚本项可以直接抛错，或挂起到 `signal` abort 为止。`hang` 的实现只监听 abort 而不做别的，保证测的是 Agent 的取消逻辑而不是假模型的计时器。
- **`model.requests` 暴露完整请求**。断言「Agent 到底把什么发给了模型」是宿主的常见需求（系统提示是否拼对、工具结果是否回灌、压缩是否生效），所以假模型保留每次收到的 `ModelRequest`，`messages` 做浅拷贝以免后续变更影响历史记录。
- **不校验工具参数 schema**。校验是被测 Agent 的职责；假模型若也校验一遍，就等于把待测逻辑复制进测试替身，两边同时出错时会互相掩盖。

### 阶段 14：评估并发（已完成）

`evaluateAgentCases()` 一开始是串行 `for`。跑几十个真实用例时，等待几乎全花在模型延迟上，评估耗时正比于用例数，而每个用例本来就是独立的 run。

- **`{ concurrency }` 以 worker 池实现，不是分批**。分批（`chunk` + `Promise.all`）会让整批等最慢的那个，慢用例会拖住所有后续用例；worker 池是用例一结束就补位，长尾不会堆积。默认值保持 1，因为默认行为改变会悄悄放大宿主的端点并发压力。
- **结果数组按索引写入**，不是 `push`。并发完成顺序不定，`push` 会让 `results` 顺序随机，而调用方按用例名对照报告时依赖顺序。测试直接断言 `results.map(name)` 等于输入顺序。
- **`concurrency` 在开始前校验**。`0`、负数、小数都会让 worker 池不启动或启动错误的个数，静默返回空报告比抛错危险得多。
- 每个用例的失败仍只落在自己身上，`AbortSignal` 仍是一例一个——并发只改调度，不改语义。

### 阶段 15：审批队列的分页与保留期（已完成）

`AgentApprovalQueue.list()` 是全表读 + JS 过滤，`AgentApprovalStore.list()` 是 `SELECT ... ORDER BY rowid` 无 `LIMIT`。审批面板想显示二十条待审，代价是整表的 `JSON.parse`。同时 `AgentApprovalRequest` 没有时间字段，所以「清理陈旧记录」根本无法表达——记录只在 `observe()` 走完终态时才消失，而崩溃、关页面、宿主提前停止消费都会留下永久残留。

- **先加 `createdAt`，再做其余两件事**。没有时间戳，保留期无从下手；把它做成必填字段而不是可选，强制每个 `save()` 的调用方交代时间。`now` 沿用 `AgentTraceCollector` 的可注入惯例，测试可以钉住时钟而不是匹配真实时间。
- **游标是三元组，不是偏移量**。`(createdAt, runId, approvalId)` 命名全序中的一个位置。偏移量在翻页之间有人审批时会跳过或重复记录。单个 `createdAt` 不够——同一毫秒可以有多条请求，所以另外两个字段参与排序。编码成 base64url 的不透明串，宿主不该解析它。
- **多取一行判断有无下一页**，而不是 `COUNT`。计数与取页是两个时刻的状态，且多一次全表扫描。
- **`list()` 保持不变**。真正想要全部的调用方（测试、脚本）不该被迫翻页；分页是新增的 `listPage()`。
- **`prune` 只删已决记录**。未决请求是某个人的待办，按时间静默删除会吞掉工作。要丢弃被遗弃 run 的待审请求，用已有的 `clear(runId)` 显式指定。
- **SQLite 的删除与计数在同一事务内**，用 `changes()` 取实际删除行数。先 `COUNT` 再 `DELETE` 在并发写入下会给出与事实不符的数字，而这个数字正是宿主用来告警的依据。
- **旧表要能升级**。既有 schema 只有 `CREATE TABLE IF NOT EXISTS`，没有迁移机制。新列通过 `PRAGMA table_info` 检测后 `ALTER TABLE ADD COLUMN`，再从 `request_json` 回填；缺失时间的旧记录回填为 0（排在最前，符合「最老的先被清理」）。

### 明确推迟

| 事项 | 为什么现在不做 |
| --- | --- |
| 显式图 / 状态机编排（LangGraph 式） | 四家主流仍以循环为主；AgentKit 尚无多写者、强确定性需求。等到出现「多分支 + 需要时间旅行」的真实场景再评估（[LangGraph overview](https://docs.langchain.com/oss/python/langgraph/overview)） |
| handoff 式多代理路由 | 需要「当前活跃代理」这一可变状态，与「运行是一次纯循环」的现有模型冲突；agents-as-tools 已覆盖绝大多数场景 |
| 权限模式矩阵 / 分类器自动放行 | 产品层策略，依赖 approval 谓词；过早引入会让核心 API 绑定一种 UX |
| A2A、托管运行环境、沙箱执行 | 跨进程/跨组织的协议与运行时，和「库」的定位不同（ADK 的 A2A 面向部署编排，[adk.dev](https://adk.dev/)） |
| 服务端托管会话（`previous_response_id` / Conversations） | 依赖具体厂商能力，属于适配器可选优化；核心状态必须先在本地可序列化（[conversation state](https://developers.openai.com/api/docs/guides/conversation-state)） |
| 向量长期记忆 | 应用层职责，且需要存储选型；先做完线程内 Session |
| UI/harness 抽象层（AI SDK 的 Chat UI、`HarnessAgent`） | AgentKit 目前是运行时库，没有 UI 宿主；先保证事件流可驱动 UI（[AI SDK intro](https://ai-sdk.dev/docs/introduction)） |

---

## 4. 给实现的几条硬约束

1. **核心行为通过公开的 `Agent.stream()` 和 `Agent.resume()` 测试**。使用 `agent-kit/testing` 的 `createFakeModel()` 或等价的确定性假实现验证厂商无关的行为；只有修改 provider adapter 或其序列化时，才要求受影响的适配器分别通过测试。
2. **运行状态通过事件观察**。现有 `AgentEvent` 已经足够细（tool.call.arguments.delta 级别）；审批、压缩与限额等运行状态通过事件暴露，宿主策略回调提供决定，但不替代事件时间线。
3. **`ToolExecutionContext` 需要扩张而不是被替换**：宿主工具确有需要时可增加 `sessionId`、`approvalId`；`runState` 引用留待暂停/恢复方案确定后再加入，保持现在的 `runId/turn/toolCallId/signal`。
4. **不要把 `finishReason` 当终止原因用**。AI SDK 的文档已经踩过这个坑：`finishReason` 只是最后一次模型调用，循环是否因步数或审批而停，必须由独立的终止原因表达（[loop control](https://ai-sdk.dev/docs/agents/loop-control)）。

---

## 5. 未能验证 / 需谨慎引用的部分

- **LangGraph 的持久化模式（`exit` / `async` / `sync`）与超步边界语义**：多次抓取 `persistence`、`durable-execution`、`use-graph-api` 页面均未返回这三者的说明，仅确认了 checkpointer 按 `thread_id` 存 checkpoint、Store 跨线程（[persistence](https://docs.langchain.com/oss/python/langgraph/persistence)）。上文没有引用这三个模式名。
- **MCP 工具注解的逐条语义**（`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint` 各自默认值）：只验证到规范页面写明「`annotations` 为可选、客户端必须视作不可信」，未取到单独注解语义页；因此本文对四类 hint 的描述按 AI SDK 与 Anthropic 文档中的用法表述，未引用 MCP 注解页的原文定义。
- **OpenAI Agents SDK 的 JS/TS 版是否已包含审批**：Python 文档有完整的 `needs_approval` / `RunState` 审批说明；JS 仓库页面只列出 human-in-the-loop，未点名 approvals（[openai-agents-js](https://github.com/openai/openai-agents-js)）。若要在 AgentKit 里对齐 JS 生态，需再核一次 JS 文档。
- **ADK 的 `sub_agents` / `transfer_to_agent` 具体 API**：`workflows` 概览页只给了四种工作流风格，未描述这两个符号；本文对 ADK 多代理只引用了概览层结论。
- **AI SDK Core 是否提供内建会话持久化**：`agents` 与 `loop-control` 两页均未提及持久化，`intro` 页也未提；本文按「不提供」处理，属推断而非文档明文。
- **Claude Agent SDK 的 hooks 事件全表**：抓取到的 hooks 页面正文被截断（完整输出落盘），本文只引用了 `agent-loop` 页面列出的常用 hook 与 `PreCompact` 的 `trigger` 字段。

---

## 6. 来源

**OpenAI**
- OpenAI Agents SDK 总览：https://openai.github.io/openai-agents-python/
- Multi-agent / handoffs / agents-as-tools：https://openai.github.io/openai-agents-python/multi_agent/
- Guardrails：https://openai.github.io/openai-agents-python/guardrails/
- Human-in-the-loop（审批）：https://openai.github.io/openai-agents-python/human_in_the_loop/
- Tracing：https://openai.github.io/openai-agents-python/tracing/
- Sessions：https://openai.github.io/openai-agents-python/sessions/
- Running agents：https://openai.github.io/openai-agents-python/running_agents/
- Agents SDK (JS/TS) 仓库：https://github.com/openai/openai-agents-js
- Conversation state（Responses）：https://developers.openai.com/api/docs/guides/conversation-state

**Anthropic**
- Agent SDK overview：https://code.claude.com/docs/en/agent-sdk/overview
- Agent loop / Turns and budget / compaction：https://code.claude.com/docs/en/agent-sdk/agent-loop
- Permissions：https://code.claude.com/docs/en/agent-sdk/permissions
- Hooks：https://code.claude.com/docs/en/agent-sdk/hooks
- Subagents：https://code.claude.com/docs/en/agent-sdk/subagents
- Tool use overview：https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
- Tool runner：https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-runner

**LangChain / LangGraph**
- Overview：https://docs.langchain.com/oss/python/langgraph/overview
- Persistence：https://docs.langchain.com/oss/python/langgraph/persistence
- Interrupts：https://docs.langchain.com/oss/python/langgraph/interrupts
- Streaming：https://docs.langchain.com/oss/python/langgraph/streaming

**Google ADK**
- 首页与导航：https://adk.dev/
- Callbacks：https://adk.dev/callbacks/
- Sessions / Memory：https://adk.dev/sessions/
- Evaluation：https://adk.dev/evaluate/
- Multi-agent workflows：https://adk.dev/workflows/

**Vercel AI SDK**
- Introduction：https://ai-sdk.dev/docs/introduction
- Agents：https://ai-sdk.dev/docs/agents
- Loop control（`stopWhen` / `prepareStep` / `stoppedBy`）：https://ai-sdk.dev/docs/agents/loop-control
- Chatbot tool usage（审批 UI 与 `toolApproval`）：https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage
- Middleware：https://ai-sdk.dev/docs/ai-sdk-core/middleware
- Telemetry：https://ai-sdk.dev/docs/ai-sdk-core/telemetry
- MCP tools：https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools

**协议规范**
- MCP Specification（2026-07-28）：https://modelcontextprotocol.io/specification/latest
- MCP Tools（含注解与错误语义）：https://modelcontextprotocol.io/specification/2026-07-28/server/tools
