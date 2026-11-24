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

Anthropic 使用 `AnthropicMessagesModel`；OpenAI Chat Completions 使用 `OpenAIChatCompletionsModel`；OpenAI Responses 使用 `OpenAIResponsesModel`。三种适配器都通过 `LanguageModel` 接口接入同一个 `Agent`。

安装依赖：

```sh
bun install
```
