# AgentKit

AgentKit 是一个使用 TypeScript 和 Bun 编写的轻量 Agent 框架起点。当前版本提供厂商无关的消息、模型流事件和 Agent 事件，并带有 OpenAI Chat Completions、OpenAI Responses 与 Anthropic Messages 适配器。

```ts
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { Agent, AnthropicMessagesModel, defineTool } from "./index";

const getWeather = defineTool({
  name: "get_weather",
  description: "查询指定城市的天气。",
  input: z.object({ city: z.string() }),
  annotations: { readOnly: true, idempotent: true },
  execute: async ({ city }) => ({ city, temperatureC: 21 }),
});

const agent = new Agent({
  model: new AnthropicMessagesModel({
    client: new Anthropic(),
    model: "claude-sonnet-5-5",
  }),
  tools: [getWeather],
  maxTurns: 10,
});

for await (const event of agent.stream({
  messages: [{ role: "user", content: "东京现在天气怎么样？" }],
})) {
  if (event.type === "message.delta" && event.delta.type === "text") {
    process.stdout.write(event.delta.text);
  }
}
```

`defineTool` 根据 Zod schema 生成模型使用的 JSON Schema，并在执行前验证参数。标记为 `readOnly` 的工具默认可自动执行，同一批只读工具可以并行运行；其他工具默认需要 `approveTool` 回调批准，并按顺序执行。没有审批处理器或审批被拒绝时，工具不会运行，拒绝结果会交给模型。工具失败会作为错误结果交给模型，并通过 `tool.execution.failed` 事件报告。

`annotations` 描述工具的 `readOnly`、`destructive` 和 `idempotent` 属性；这些是运行时策略信息，不会发送给模型。默认情况下，`destructive` 工具需要审批。`requiresApproval` 可以针对单个工具显式覆盖默认审批策略。宿主通过 `tool.approval.requested` 和 `tool.approval.resolved` 事件获知审批状态；审批事件和回调会提供原始工具调用与校验后的执行参数。注解是工具定义者的声明；接入远程工具时，宿主应先验证其策略元数据，不要直接信任远程注解。

Agent run 的终态由 `stopReason` 描述：`agent.completed` 表示正常完成或模型拒答，`agent.stopped` 表示达到轮数上限、取消、输出截断或上下文预算上限，`agent.failed` 表示运行错误。模型的 `finishReason` 只说明最后一次模型调用如何结束。若 provider 提供了 usage，所有终态事件都会携带累计 usage；可恢复的工具执行错误仍会回传模型，不会直接结束 run。

通过 `maxContextTokens` 可为每个 Agent run 设置单次模型请求的输入上下文预算。Agent 在每次模型调用前估算消息、指令和工具定义；默认估算器是厂商无关的近似值，也可以用 `estimateContextTokens` 提供自定义估算。输出由 `maxOutputTokens` 单独控制。超过预算时，Agent 按顺序移除较早的完整对话或工具交互，保留指令和当前 user 请求，并发出不包含消息内容的 `agent.context.compacted` 事件。如果保留内容仍超预算，Agent 会在调用模型前以 `context_limit` 停止。未设置 `maxContextTokens` 时，上下文行为保持不变。

`SessionStore` 保存可跨多个 Agent run 延续的对话历史。传入 `sessionId` 时，Agent 会加载历史，并将 `messages` 视为本次新增输入；`instructions` 每次都会加入模型请求，但不会存入 Session。内存实现适用于单进程使用，SQLite 实现适用于本地持久化：

```ts
import Anthropic from "@anthropic-ai/sdk";
import { Database } from "bun:sqlite";
import { Agent, AnthropicMessagesModel, SQLiteSessionStore } from "./index";

const database = new Database("agentkit.sqlite");
const sessionStore = new SQLiteSessionStore(database);
const agent = new Agent({
  model: new AnthropicMessagesModel({
    client: new Anthropic(),
    model: "claude-sonnet-5-5",
  }),
  sessionStore,
});

for await (const event of agent.stream({
  sessionId: "conversation-1",
  messages: [{ role: "user", content: "继续上次的对话。" }],
})) {
  if (event.type === "message.delta" && event.delta.type === "text") {
    process.stdout.write(event.delta.text);
  }
}

database.close();
```

只有以 `agent.completed` 结束的 run 会追加 Session；`agent.stopped`、`agent.failed` 和取消的 run 不会写入。压缩只影响当前 run 的模型请求，不会改写已保存历史。若工具已经执行但 run 未完成，该次历史也不会保存，重试时可能再次调用工具。宿主应串行执行同一 `sessionId` 的 run；Store 只保证单次追加批次的原子性，不会协调并发 run 的读取和写入。

### 同一 run 的暂停与恢复

将 `approvalMode` 设为 `"pause"` 后，需要审批的工具会通过 `agent.paused` 暂停，事件包含 JSON 可序列化的 `runState`。宿主取得批准或拒绝结果后调用 `agent.resume({ state, approval: { toolCallId, decision } })`；恢复事件沿用原 `runId`。同一批次有多个待审批工具时，每个决定会逐次暂停和恢复。`max_turns` 停止时，如果还有尚未执行的工具调用，`agent.stopped` 也会提供 `runState`。

`AgentRunState` 是未完成 run 的快照，不是 Session。它包含当前消息和工具调用，可能含有用户内容、工具参数与结果；宿主应按敏感数据保护，并在恢复前验证调用者身份、授权及快照来源。宿主还应原子地认领并消费快照，避免并发或重复恢复同一个 run。快照本身不提供签名或 exactly-once 保证；工具副作用应使用外部幂等键。恢复时应提供兼容的模型与 Agent 配置、工具定义和审批策略；Agent 会校验 provider、配置、工具及 Session 历史基线，但宿主仍需确保底层模型部署与自定义上下文估算器实现一致。若快照轮次高于新 Agent 的 `maxTurns`，恢复会再次以 `max_turns` 停止并保留原快照，直到提高轮数上限。

不配置 `runStore` 时，可恢复点只有工具审批暂停，以及 `max_turns` 停止时尚未执行的工具调用；配置后还会有运行中的检查点，见下节。取消或失败的 run 不会自动生成可恢复快照。工具在 run 完成前即使已产生副作用，也不会写入 Session；恢复只能避免重放已保存在快照中的审批决定，不能保证外部副作用恰好执行一次。

### 进程崩溃后的持久恢复

前面的 `AgentRunState` 只在暂停或 `max_turns` 时交给宿主，进程崩溃时进行中的 run 不会留下任何快照。配置 `runStore` 后，Agent 会在 run 执行过程中写入检查点：

```ts
import { Database } from "bun:sqlite";
import { Agent, SQLiteRunStore } from "./index";

const database = new Database("agentkit.sqlite");
const runStore = new SQLiteRunStore(database);
const agent = new Agent({ model, tools, sessionStore, runStore });

for await (const event of agent.stream({ messages, sessionId: "order-42" })) {
  if (event.type === "agent.checkpointed") {
    console.log(event.runId, event.turn, event.resumeAt);
  }
  if (event.type === "agent.paused") {
    persistApprovalPrompt(event.runId, event.pendingToolCall);
  }
}

// 崩溃后，可能来自另一个进程
for await (const event of agent.resume({ runId: savedRunId })) {
  // ...
}
```

- 检查点写两次：每轮模型请求前（`resumeAt: "model_turn"`，此时消息已包含此前所有工具结果）和工具批次执行前（`resumeAt: "tool_batch"`，等待参数解析与审批完成）。两者都在没有活跃模型请求时写入，因此可直接复用 `AgentBudget.checkpoint()`。
- `AgentRunStore` 只有 `save` / `load` / `delete`，一个 `runId` 至多一个检查点，`save` 是覆盖写。`InMemoryRunStore` 用于测试与单进程宿主，`SQLiteRunStore` 与 `SQLiteSessionStore` 风格一致。
- `agent.resume({ runId })` 从存储载入检查点；`agent.resume({ state, approval })` 的既有用法不变。二者必须且只能提供一个，载入结果必须存在且 `runId` 一致。
- 清理规则：`agent.completed`、`agent.failed`、以及不带 `runState` 的 `agent.stopped` 会删除检查点；`agent.paused` 与带 `runState` 的 `max_turns` 停止会保留（并刷新）检查点。删除发生在终态事件交给宿主之前。中途放弃消费事件流不算终态，检查点会留下，宿主可显式 `runStore.delete(runId)`。
- 检查点写入失败会让 run 以 `agent.failed` 结束。持久化是宿主显式要求的语义，静默降级会让宿主误以为存在可恢复点。

**恢复语义是 at-least-once，不是 exactly-once。** 崩溃发生在模型请求期间，最多重发该轮请求；崩溃发生在工具执行期间，整个批次都会重放，包括已经完成的工具。同一批次重放时 `toolCallId` 保持不变，因此它就是天然的幂等键：会产生外部副作用的工具应把 `toolCallId`（或 `runId:toolCallId`）传给下游做原子去重。无法幂等的动作（扣款、发通知）只能依赖下游去重，AgentKit 不提供补偿。

检查点未签名，与 `AgentRunState` 的既有边界一致：宿主必须保护存储、在恢复前鉴权、原子认领并防止并发恢复同一个 `runId`。检查点包含完整消息与工具结果，访问控制与加密由宿主负责。Session 只在 `agent.completed` 时追加；若崩溃恰好发生在「Session 已写入、检查点尚未删除」之间，恢复时的历史基线校验会拒绝该快照，不会重复追加。从 `model_turn` 检查点恢复时，崩溃前那次请求的用量不可知，账本按不完整处理：启用 `maxTotalTokens` 会以 `usage_unavailable` 停止。子代理不继承 `runStore`，父 run 重放子代理工具调用会重新启动子 run。设计细节见 [docs/plans/durable-run-recovery.md](docs/plans/durable-run-recovery.md)。

### 模型请求重试

`modelRetry` 让模型请求在**尚未产生任何输出**时重试，适用于连接中断、限流或服务端瞬时错误：

```ts
const agent = new Agent({
  model,
  modelRetry: { maxAttempts: 3, delayMs: 500 },
});
```

- 只在请求还没有发出任何 delta 或工具调用时重试。流式内容一旦交给事件消费者就无法收回，此时重试会产生重复文本或重复工具调用，因此这类失败会直接结束 run，而不是重试。
- 每次尝试都重新认领一个模型调用名额。启用 `maxModelCalls` 时，重试会消耗名额；名额耗尽会以 `budget_exceeded` 停止，而不是继续重试。
- 启用 `maxTotalTokens` 时，一次失败且未报告 `totalTokens` 的尝试会把账本标记为不完整，后续尝试以 `usage_unavailable` 停止。这是有意的：失败请求可能已在服务端产生不可见的计费。
- `shouldRetry` 可按错误过滤；`AbortError` 与已取消的 run 永不重试，等待期间取消会立即结束。每次重试发出 `model.request.retrying`，追踪中按 turn 记录 `modelRetries`。
- 这是请求级重试，不是断点续跑：它不会重放已经执行的工具，也不会从中断的消息处继续。
- `modelRetry` 与工具级 `retry` 相互独立：前者针对模型请求，后者针对工具执行。

### 工具重试

工具可以在定义中声明重试策略，让暂时性失败在工具内部恢复，而不是立刻作为错误回灌模型：

```ts
const fetchPage = defineTool({
  name: "fetch_page",
  description: "下载页面",
  input: z.object({ url: z.string() }),
  annotations: { readOnly: true, idempotent: true },
  retry: { maxAttempts: 3, delayMs: 200 },
  execute: ({ url }) => fetch(url).then((response) => response.text()),
});
```

- `maxAttempts` 必填，取值 1–10；`delayMs` 是每次失败后的固定等待，默认立即重试；`shouldRetry` 可按错误决定是否继续，返回 false 时保留当前错误。
- 重试发生在一次审批之后。获批的工具在重试过程中不会重新请求审批；宿主若要求每次尝试都重新授权，应在工具内部而不是 `retry` 中实现。
- `AbortError` 和已取消的 run 不会重试；等待期间取消会立即结束。不要在非幂等工具上启用重试：一次失败的调用可能已经产生了副作用。
- 成功事件和失败事件在 `attempts` 大于 1 时携带尝试次数，追踪中的工具记录也会保存该值。未声明策略的工具保持原有的一次执行语义。
- `beforeTool` 在整次执行前运行一次，不会为每次重试重复调用。重试耗尽后仍走现有工具错误路径，模型可以决定是否再次调用。

### 运行前 Hooks

`Agent` 的 `hooks` 可在模型请求和工具执行前检查运行上下文。Hook 可同步执行或返回 Promise；正常返回允许继续，抛错则阻止对应操作。

```ts
const agent = new Agent({
  model,
  tools: [getWeather],
  hooks: {
    beforeModel: ({ messages, turn }) => {
      if (messages.length > 100) throw new Error(`第 ${turn} 轮的消息数量超限`);
    },
    beforeTool: ({ toolCall }) => {
      if (toolCall.name === "restricted") throw new Error("工具被策略禁止");
    },
  },
});
```

`beforeModel` 在上下文压缩之后、预算认领和模型调用之前执行；抛错会使 run 以 `agent.failed` 结束，不消耗模型调用名额。它会在每次新模型请求前执行，包括恢复后产生的新请求；恢复已保存的工具调用时不会重放对应的模型 hook。

`beforeTool` 在参数解析和审批通过之后、实际执行工具之前执行；抛错会产生工具失败事件和工具错误结果，模型可据此决定下一步。已拒绝或未获审批的工具不会调用该 hook；恢复后待执行的工具会重新检查。只读工具可能并发执行，其 hook 也可能并发；`tool.execution.started` 表示执行尝试开始，不保证 hook 已放行。取消发生在 hook 等待期间时，hook 返回后不会启动对应的模型或工具调用；hook 应自行响应传入的 `signal`。

Hook 收到的消息、工具定义和原始工具调用是副本，修改它们不会改变实际请求；`beforeTool` 接收模型的原始 JSON 参数，而非工具解析后的值。Hook 不会继承到子代理，宿主应分别配置各个 Agent。它们可以读取敏感内容，应由可信宿主提供；此版本不提供输出过滤，也不阻止已经流出的模型内容。Hook 配置不保存在 run 快照中，恢复时由宿主确保策略符合要求。

### 结构化输出

传入 `outputSchema` 后，Agent 会向模型提供一个名为 `final_answer` 的隐式工具，其输入 schema 由 Zod 对象生成。模型必须通过该工具提交最终结果；Agent 在本地校验通过后，以 `structuredOutput` 返回解析后的对象：

```ts
import { z } from "zod";

const answer = z.object({
  sentiment: z.enum(["positive", "negative"]),
  confidence: z.number().min(0).max(1),
});

const agent = new Agent({ model, outputSchema: answer });
for await (const event of agent.stream({
  messages: [{ role: "user", content: "判断这条反馈的情绪。" }],
})) {
  if (event.type === "agent.completed") console.log(event.structuredOutput);
}
```

行为与边界：

- 校验失败时，Zod 错误会作为工具错误回灌模型，模型可以在后续轮次修正；最终只接受校验通过的结果。`tool.execution.failed` 和追踪中同样能看到这次失败。
- 模型没有调用输出工具而直接给出文本时，Agent 会追加一条不写入 Session 的 developer 消息，提醒它调用 `final_answer`；若在 `max_turns` 之前仍未提交，则以 `max_turns` 停止。
- 输出工具必须单独出现在一轮工具调用中，与其它工具混用会按工具错误处理，避免未经确认就结束 run。
- 模型拒答时仍以 `refusal` 结束，不产生 `structuredOutput`；输出被截断时以 `length` 停止。
- 输出工具是只读且免审批的隐式工具，会对 `beforeTool` hook 和追踪可见。工具名默认 `final_answer`，可用 `outputToolName` 修改；与显式工具重名会在构造时报错。`outputToolName` 单独提供而没有 `outputSchema` 也会报错。
- 该实现不依赖各厂商的原生 JSON 模式，因此在三个适配器上行为一致；代价是额外一次工具往返，并且 schema 通过工具定义表达。子代理使用结构化输出时，父代理收到的是 JSON 字符串。
- 输出配置不进入 Session，但会写入暂停恢复快照的工具定义校验；恢复时必须提供相同的 `outputSchema` 和 `outputToolName`。

### 追踪与工具轨迹评估

为每次 `agent.stream()` 或 `agent.resume()` 创建一个 `AgentTraceCollector`，并将事件传给 `record()`。`finish()` 返回可序列化的追踪记录，宿主可以写入自己的日志或遥测系统。追踪层级为 run → turn → 模型调用与工具执行，同时记录审批、上下文压缩、用量和运行结果。

```ts
import { AgentTraceCollector, evaluateToolTrajectory } from "./index";

const collector = new AgentTraceCollector();
for await (const event of agent.stream({
  messages: [{ role: "user", content: "查询东京的天气。" }],
})) {
  collector.record(event);
}

const trace = collector.finish();
if (trace) {
  const result = evaluateToolTrajectory([trace], [{ turn: 1, name: "get_weather" }]);
  if (!result.passed) throw new Error(JSON.stringify(result.mismatch));
}
```

暂停和恢复各自产生带独立 `id` 的追踪记录，并共享 `runId`。评估时按发生顺序传入同一 run 的各段记录。评估严格比较 `tool.execution.started` 对应的轮次与工具名，返回实际序列以及第一个差异的零基索引。这样并行工具的完成顺序不会影响结果。需要在 CI 中断言固定轨迹时，可以用预设响应的 `LanguageModel`。工具是否成功以及 run 是否完成，可以分别通过追踪中的 `status` 断言。

### 批量回归评估

`evaluateAgentCases()` 在一条公开接缝上批量运行用例，并同时断言 **run 是否按预期结束、工具轨迹、最终文本与结构化结果**，而不只是工具调用顺序：

```ts
import { evaluateAgentCases, observeAgentEvents } from "./index";

const report = await evaluateAgentCases(
  [
    {
      name: "在缺货时停止下单",
      input: "帮我买那本书",
      expect: {
        stopReason: "completed",
        toolTrajectory: [{ turn: 1, name: "check_stock" }],
        textIncludes: "缺货",
      },
    },
    {
      name: "输出经过校验的情绪结果",
      input: "包装很好，物流也快。",
      expect: { structuredOutput: { sentiment: "positive", confidence: 0.9 } },
    },
  ],
  async ({ input }, signal) =>
    observeAgentEvents(agent.stream({ messages: [{ role: "user", content: input }], signal })),
);

if (!report.passed) {
  for (const result of report.results.filter(({ passed }) => !passed)) {
    console.error(result.name, result.failures);
  }
}
```

- 用例只检查声明过的项；`expect` 为 `{}` 表示只跑通、不做断言。
- 失败不会中断整轮评估：每个用例单独结算，报告给出 `summary` 与逐例 `failures`，可直接在 CI 中按 `passed` 失败退出。
- `structuredOutput` 按值比较，忽略对象键顺序。
- 观测函数抛错会转成 `observation` 失败，而不是让整批崩溃。
- `observeAgentEvents()` 是便捷适配器，把事件流收集为 `stopReason`、`toolTrajectory`、`text`、`structuredOutput` 与 `usage`。需要更多信息时，可自行实现 `AgentEvalObserver`。
- 用例名必须唯一；重复会在开始前报错。评估器不做并发调度，执行顺序由观测函数决定。
- 这里评估的是**单次 run 的可观察结果**，不是模型质量评分；它不包含 LLM 裁判或数据集管理。需要判定开放式答案时，可在 `AgentEvalObserver` 中接入自己的裁判模型。

默认只记录运行元数据。可独立开启 `recordInputs` 以记录本段事件中观察到的原始工具参数，或开启 `recordOutputs` 以记录助手正文和成功的工具结果。收集器只读取事件，因此模型请求正文和恢复快照中的载荷不会进入追踪。可通过 `requestModel` 补充模型标识。run 上的用量在终态或暂停事件提供累计值时覆盖为该值，因此同一 run 的分段用量不能直接相加。若宿主提前停止消费事件，仍可调用 `finish()` 得到 `interrupted` 记录。

### MCP 工具接入

`createMCPToolSource()` 把已连接的 MCP 客户端提供的工具转换为 `AgentTool`，复用现有的审批、并行规划、错误回灌、暂停恢复和追踪。适配器只依赖结构化的 `MCPToolClient` 接口（`listTools` / `callTool`），不引入 MCP SDK 运行时依赖；宿主传入官方客户端的实例即可。连接与关闭由宿主负责。

```ts
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Agent, AnthropicMessagesModel, createMCPToolSource } from "./index";

const client = new Client({ name: "my-host", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: "my-mcp-server" }));

const mcpTools = await createMCPToolSource(client, { namespace: "files" });
const agent = new Agent({
  model: new AnthropicMessagesModel({ client: new Anthropic(), model: "claude-sonnet-5-5" }),
  tools: mcpTools.tools,
  approveTool: async ({ tool }) => askTheUser(tool.name),
});
```

安全边界：

- **默认所有 MCP 工具都需要审批**，且适配器不把服务端声明的 `readOnlyHint` / `destructiveHint` 传给 Agent 策略。MCP 规范明确注解只是提示、不能作为授权依据；信任远程注解等于让服务端决定哪些工具可以不经审批直接执行。宿主确认服务端可信后，可用 `trustAnnotations: true` 启用注解映射，让只读工具免审批并且可以并行。
- 工具名默认加 `namespace__` 前缀，避免多个服务端或本地工具重名；与本地工具重名时 `Agent` 构造器会报错。
- 工具参数由服务端校验；`isError` 结果会作为工具错误回灌模型，协议层异常（如未知工具）同样走现有失败路径。
- 服务端可以随时改变工具的行为，固定 schema 不代表行为固定；暂停中的 run 在工具定义变化后恢复会被拒绝，但这只保证定义一致，不保证行为一致。

版本：`@modelcontextprotocol/client` 与 `@modelcontextprotocol/server` 2.4.0 仅作为开发依赖用于契约测试；已在 Bun 1.3.14 下验证内存传输、工具列表、调用与错误语义。

### 任务树用量与调用次数

在根 run 的 `stream()` 输入中设置 `budget: { maxModelCalls: 12, maxTotalTokens: 50000 }`，可限制该 run 和通过 `createSubagentTool` 启动的后代合计发起的模型请求次数及报告的 token 用量。两个上限均可单独设置；每次请求在开始前认领一个调用名额，失败或取消不会返还。未设置上限时仍会统计用量。预算属于一次根 run，独立 run 不共享额度。

`agent.budget.updated` 事件提供 `modelCalls`、各请求报告的累计 `usage`、`requestsWithUsage`、`usageComplete` 和 `tokenUsageComplete`。后者分别表明所有请求的 input/output/total 字段或 total 字段是否完整；请求尚未结束、异常中断或字段缺失时为 false。即使完整，也不能将统计视为服务端账单。现有终态 `usage` 仍只包含当前 run。

```ts
for await (const event of agent.stream({
  messages: [{ role: "user", content: "调研并比较方案。" }],
  budget: { maxModelCalls: 12, maxTotalTokens: 50000 },
})) {
  if (event.type === "agent.budget.updated") console.log(event.budget);
  if (event.type === "agent.stopped") console.log(event.stopReason);
}
```

调用次数或已报告的 `totalTokens` 达到上限时，下一个需要调用模型的 run 以 `budget_exceeded` 停止。**token 上限是软上限**：已经发出的请求仍可完成，尤其并行请求的实际总用量可能超过上限；工具也可能继续执行。启用 token 上限时，如果请求未正常完成或没有报告有效的 `totalTokens`，下一个需要调用模型的 run 以 `usage_unavailable` 停止。预算只覆盖 AgentKit 管理的模型请求，不包含工具自行发起的外部调用或收费；它不保证美元费用上限。

审批暂停和 `max_turns` 快照保存共享账本，恢复时继续累计。旧版不含预算的快照仍可恢复，其此前的树级用量无法重建，恢复后从新的账本开始统计。快照在有其他模型请求执行时拒绝生成；宿主仍须确保快照的来源可信并避免重复恢复。

### 子代理

`createSubagentTool()` 把一个完整的 Agent 包装成工具：父 Agent 调用它并传入任务描述，工具内部运行一次独立的子 run，把子 run 的最终文本作为工具结果返回。父 Agent 保留控制权，因此作用域、审批、并行规划、错误回灌与追踪都沿用现有工具路径。

```ts
import Anthropic from "@anthropic-ai/sdk";
import { Agent, AnthropicMessagesModel, createSubagentTool } from "./index";

const model = new AnthropicMessagesModel({ client: new Anthropic(), model: "claude-sonnet-5-5" });
const researcher = createSubagentTool({
  name: "delegate_research",
  description: "把一段资料检索交给子代理，返回精炼摘要。",
  createAgent: (depth) => new Agent({ model, instructions: `你是第 ${depth} 层的研究子代理。` }),
  maxDepth: 3,
  maxConcurrency: 2,
  onUsage: (usage) => console.log("subagent usage", usage),
});

const agent = new Agent({ model, tools: [researcher], maxTurns: 10 });
```

约定与边界：

- 子 run 只接受以 `agent.completed` 结束。`agent.stopped` 或 `agent.failed` 会变成工具错误，消息包含 `stopReason`（失败时还带原始错误），模型可以决定是否重试；父 run 的终态不受影响。
- `maxDepth` 默认 3：达到上限时直接抛错，不创建子 Agent。深度沿父子 `AbortSignal` 链传播，因此嵌套调用同一工具也能正确计数。
- `maxConcurrency` 默认 2，按深度分层限制同一工具实例的并发子 run；超出时排队，排队中的调用可以随父 signal 取消。
- `createAgent(depth)` 每次调用都应返回新的 `Agent`，避免子 run 之间共享可变状态。
- 子 run 的追踪与父 run 独立：父事件流不会混入子事件，需要子 run 的追踪时在 `createAgent` 里自行挂 `AgentTraceCollector`。
- 子代理会放大 token 成本。`onUsage` 上报每个子 run 的累计 usage；根 run 可通过 `budget` 设置父子共享的模型调用次数与 token 软上限，未使用该预算时由宿主自行累计。
- 工具注解为 `readOnly`，因此父 Agent 不会要求审批，且可以并行调用。这个注解不保证子 Agent 只读：子 Agent 使用自己的工具和审批策略，宿主必须审查其配置；若子工具允许自动执行写操作，父层不会再次审批。

Anthropic 使用 `AnthropicMessagesModel`；OpenAI Chat Completions 使用 `OpenAIChatCompletionsModel`；OpenAI Responses 使用 `OpenAIResponsesModel`。三种适配器都通过 `LanguageModel` 接口接入同一个 `Agent`。

安装依赖：

```sh
bun install
```
