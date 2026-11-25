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

Anthropic 使用 `AnthropicMessagesModel`；OpenAI Chat Completions 使用 `OpenAIChatCompletionsModel`；OpenAI Responses 使用 `OpenAIResponsesModel`。三种适配器都通过 `LanguageModel` 接口接入同一个 `Agent`。

安装依赖：

```sh
bun install
```
