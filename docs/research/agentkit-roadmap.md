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

### 阶段 5：MCP 与子代理

实施计划：[docs/plans/mcp-and-subagents.md](../plans/mcp-and-subagents.md)（已完成 MCP SDK v2 在 Bun 下的兼容性验证）。

- MCP 只做客户端侧的工具接入：`tools/list` → 适配为 `AgentTool`，`annotations` 直接喂给阶段 1 的审批策略；工具执行错误（`isError: true`）按现有「错误结果回灌模型」路径处理（[MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)）。传输先支持 stdio 与 Streamable HTTP。
- 工具定义变更要做指纹校验，防「工具定义被替换」类攻击（AI SDK 文档明确建议对已审批工具做 fingerprint）（[MCP tools (AI SDK)](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools)）。
- 子代理**先做 agents-as-tools，不做 handoff**：子代理作为一个工具，输入任务描述、输出摘要，父代理保留控制权与聚合。这正是 OpenAI 对「有界子任务」的推荐用法，且天然复用阶段 1–3 的工具作用域、审批与追踪（[multi-agent](https://openai.github.io/openai-agents-python/multi_agent/)）。
- 与子代理一同交付三道上限：嵌套深度、并发数、总预算（对照 3 / 20 / `maxBudgetUsd` 的默认值）。没有上限的子代理会瞬间放大成本，且预算必须跨代理共享，否则「预算」只是个装饰。

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

1. **核心行为通过公开的 `Agent.stream()` 和 `Agent.resume()` 测试**。使用确定性的 `LanguageModel` 假实现验证厂商无关的行为；只有修改 provider adapter 或其序列化时，才要求受影响的适配器分别通过测试。
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
