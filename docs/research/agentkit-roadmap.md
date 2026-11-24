# AgentKit 路线图研究：主流 Agent 产品与框架的设计取舍

> 调研日期：2026-11-24。范围：只使用官方一手文档、规范和第一方仓库。
> 目标：在 AgentKit 现有的「厂商无关消息/流事件 + Zod 工具 + 多轮工具循环」之上，判断接下来该补哪些原语、按什么顺序补、哪些应当推迟。

---

## 1. 现状盘点（作为基线）

AgentKit 目前具备（读代码得出，非外部资料）：

- `LanguageModel` 单一抽象 + 三个适配器（OpenAI Chat Completions、OpenAI Responses、Anthropic Messages）；
- `defineTool` 把 Zod schema 转成 JSON Schema，执行前校验；工具失败以错误结果回灌模型；
- 单轮内并行执行工具、按调用顺序回填结果，`maxTurns` 默认 10；
- 完整的事件流（`agent.started` → `turn.started` → `message.delta` → `tool.execution.*` → `agent.completed` / `agent.failed`），`AbortSignal` 已贯穿到 `ModelRequest` 与 `ToolExecutionContext`。

后续可对照的能力包括审批/中断、持久化与恢复、上下文压缩、hooks/中间件、追踪、MCP、子代理与预算；不同产品覆盖范围和实现层级不同，不能视为五家都内建了全部能力。

值得优先处理的现状问题：

1. **`maxTurns` 触顶被报成 `agent.failed`**。主流框架会区分循环停止原因：Anthropic Agent SDK 用 `error_max_turns` 等 `ResultMessage` 子类型表达停止状态；OpenAI Agents SDK 的 Python 实现抛出 `MaxTurnsExceeded` 异常；Vercel AI SDK 的 `stoppedBy` 区分模型自然结束、停止条件、缺少工具执行器和审批中断，并明确指出 `finishReason` 只反映最后一次模型调用，不能代替循环停止原因（[Anthropic agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)、[OpenAI running agents](https://openai.github.io/openai-agents-python/running_agents/)、[AI SDK loop control](https://ai-sdk.dev/docs/agents/loop-control)）。AgentKit 当前把轮数耗尽作为 `agent.failed`；同样，取消、模型拒答和输出长度限制还没有统一的 run 级终止原因。
2. **工具无条件并发执行**。AgentKit 还没有只读/有副作用分类或审批钩子；一旦工具会写入外部状态，默认并发可能产生冲突。Anthropic Agent SDK 对内置读工具与写工具采用不同并发策略，自定义工具默认串行；MCP 也建议宿主在工具调用时保留人类拒绝的能力（[Anthropic agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)、[MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)）。

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
3. 持久化恢复不是事务：OpenAI 文档说明序列化的 `RunState` 本身不负责认证，且不保证 exactly-once；LangGraph 文档说明恢复时节点会从头执行，因此前置副作用要幂等。AgentKit 在加入可恢复审批时，应明确这些限制并避免自动重放非幂等操作。

### 2.3 一个容易被忽略的细节：工具并发不是免费的

Agent SDK 的策略是**只读工具并发、写工具串行**，自定义工具默认串行，需要 `readOnlyHint` 注解才并发（[agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)）。MCP 规范要求客户端把工具注解视为不可信信息，建议始终保留人类拒绝调用的能力，并建议把工具执行错误回传给模型以便纠正；规范没有强制要求每次调用都弹出确认界面（[MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)）。

AgentKit 当前是无条件并行。一旦工具开始有副作用，这个默认值就从「快」变成「危险」——而它恰好又是审批策略需要消费的同一份元数据。两者应当一起做。

---

## 3. 对 AgentKit 的分期建议

排序原则：**先明确 run 为什么结束，再给有副作用的工具加执行策略，之后才做持久化与扩展**。当前 `instructions` 已由 [Anthropic 适配器](../../src/providers/anthropic/messages.ts) 合并到顶层 `system` 参数，不需要列为待修问题。审批若只在当前进程内等待，不依赖可序列化快照；只有跨进程暂停/恢复才需要 run state。

### 阶段 0：终止语义与运行边界

- 增加独立于模型 `FinishReason` 的 run 级 `stopReason`，区分正常完成、轮数耗尽、取消、模型/工具错误与拒答等情况。模型的输出长度限制保留为模型停止信息，不能误报为 run 已正常完成。
- 在成功、失败、取消和限额停止的最终事件中提供已知的累计 usage；避免让调用方只能从 `agent.completed` 读取成本信息。
- 为 `maxTurns` 明确边界语义：当前实现将每次模型响应计为一轮，若最后一轮仍要求工具则停止执行该批工具并报告失败。新的终止原因应把它表达为限额停止。

理由：调用方需要稳定判断是否可重试、是否已完成、是否需要提高预算；后续预算、追踪、审批恢复也都依赖清楚的终止状态。

### 阶段 1：工具策略与进程内审批

- 为工具增加行为标记，例如 `readOnly`、`destructive`、`idempotent`。这些只是声明，不能单独作为安全判断；由宿主提供的策略决定是否允许运行。
- 改为默认顺序执行；只有明确标记为只读、且宿主策略允许的工具才并行。这样并发能力仍可用，但不会把任意副作用工具默认放在一起执行。
- 在工具执行前加入 `beforeTool`/审批谓词。拒绝时把结构化拒绝结果回填给模型并发出拒绝事件；对需要交互的调用方，可由回调等待审批，不必先引入远程审批协议。
- 保持工具执行错误回填模型的行为，并为一次调用明确审批状态、工具定义和参数，避免调用方在回调中自行重建这些上下文。

这一步先解决 AgentKit 作为库的核心责任：明确什么可以执行、何时可并行。工具注解不可信、策略由宿主控制的边界应写入文档（[MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)）。

### 阶段 2：Session、暂停恢复与压缩

- 定义最小 `Session` 接口：`load(sessionId)` / `append(items)` / `clear()`，结构对照 Agents SDK 的 session 操作与历史截取语义（[sessions](https://openai.github.io/openai-agents-python/sessions/)）。先给内存实现，再给一个 `bun:sqlite` 实现（符合项目「用 bun:sqlite」的约定）。
- `AgentRunInput` 从「一次 messages」演进为「session + 新输入」，继续对话与恢复同一个中断 run 使用清楚区分的入口。
- 只有此阶段才加入可持久化 `AgentRunState`：保存 messages、待执行工具调用、审批决定状态、turn 与累计 usage；为同一 run 恢复定义身份校验和原子状态转换。文档明确快照需要宿主鉴权，不保证 exactly-once；会产生副作用的工具应支持外部幂等键（[OpenAI human-in-the-loop](https://openai.github.io/openai-agents-python/human_in_the_loop/)、[LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)）。
- 压缩做成可拦截事件：`context.compaction.started/completed` + 一个可替换的摘要器，并把摘要 LLM 调用作为**独立事件**暴露，避免它混进普通 turn 的事件流（对照 `compact_boundary` 与 `PreCompact`）。
- 明确不做：向量化长期记忆 / MemoryService。ADK 的 Session 与 Memory 是两层，AgentKit 先把第一层（线程内）做对，跨线程记忆属于应用层。

### 阶段 3：追踪与评估

- 把现有 `AgentEvent` 映射为 span 树：run → turn → chat（模型调用）→ execute_tool，字段采用 GenAI 语义约定（`gen_ai.operation.name`、`gen_ai.request.model`、输入输出可选记录），名称对齐 AI SDK 的 `invoke_agent` / `step` / `chat` / `execute_tool`（[telemetry](https://ai-sdk.dev/docs/ai-sdk-core/telemetry)）。先输出一个纯 JS 的 span 收集器接口，OTel 只作为可选实现，不引入运行时依赖。
- 评估先用「轨迹夹具」而不是语义评分：为每个测试用例固定 expected tool trajectory，跑 `bun test` 做精确匹配；参考 ADK 的 `tool_trajectory_avg_score` 默认 1.0，并明确它比 `response_match_score`（ROUGE-1，对措辞敏感）更适合 CI（[evaluate](https://adk.dev/evaluate/)）。LLM 裁判作为后续可选项。
- 注意隐私开关：默认是否记录工具入参与结果，必须显式可选（对照 `recordInputs`/`recordOutputs` 与 `trace_include_sensitive_data`）。

### 阶段 4：MCP 与子代理

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

1. **每个新原语必须三家适配器同时通过测试**。审批与压缩最容易被写成「OpenAI Responses 专属」，因为它们在那里的服务端语义更强；但 Anthropic 的 tool_use/tool_result 与 Chat Completions 的函数调用都能承载同一份快照，差别只在序列化层。
2. **事件是唯一可观测契约**。现有 `AgentEvent` 已经足够细（tool.call.arguments.delta 级别），新增的一切（approval、compaction、budget）都应当是事件而不是回调，这样追踪、UI、测试共用一条通道。
3. **`ToolExecutionContext` 需要扩张而不是被替换**：加 `sessionId`、`approvalId`、`runState` 引用，保持现在的 `runId/turn/toolCallId/signal`。
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
