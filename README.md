# Rein

**在 TypeScript 应用里运行能调用工具、能等待人工审批的 AI Agent。**

Rein 是一个厂商无关的 Agent 运行时。你提供模型和业务工具，它负责校验参数、按策略执行工具，再把结果交给模型继续处理。应用从同一条事件流读取输出、工具调用和审批状态，不用为每个模型端点重写这套循环。

比如，库存助手可以直接查询库存；如果后来要让它修改订单，可以先暂停这次运行，等人工批准后再继续。Rein 可以嵌入现有应用，不要求特定的 Web 框架或托管服务。

[快速开始](#快速开始) · [接入真实模型](#接入真实模型) · [使用指南](docs/guide.md) · [示例](examples/README.md)

## 快速开始

先用一个按脚本应答的假模型跑通「模型发出工具调用 → Rein 执行 → 模型回答」。安装依赖后，这个示例不需要 API Key，也不会调用模型服务。

安装 [Bun](https://bun.sh/) 后，从源码构建：

```sh
git clone https://github.com/kindredzhang/rein-kit.git
cd rein-kit
bun install --frozen-lockfile
bun run build
```

在仓库根目录创建 `quickstart.ts`：

```ts
import { z } from "zod";
import { Agent, defineTool } from "rein-kit";
import { createFakeModel } from "rein-kit/testing";

const checkStock = defineTool({
  name: "check_stock",
  description: "查询指定商品的可用库存。",
  input: z.object({ sku: z.string() }),
  annotations: { readOnly: true },
  execute: ({ sku }) => ({ sku, available: sku === "A-1" ? 3 : 0 }),
});

const model = createFakeModel({
  turns: [
    { toolCalls: [{ name: "check_stock", input: { sku: "A-1" } }] },
    { text: "A-1 还有 3 件库存。" },
  ],
});

const agent = new Agent({
  model,
  instructions: "你是库存助手。回答前先用工具查询库存。",
  tools: [checkStock],
});

for await (const event of agent.stream({
  messages: [{ role: "user", content: "A-1 还有库存吗？" }],
})) {
  if (event.type === "tool.execution.completed") {
    console.log(`${event.name}: ${JSON.stringify(event.result)}`);
  }
  if (event.type === "message.delta" && event.delta.type === "text") {
    process.stdout.write(event.delta.text);
  }
  if (event.type === "agent.completed") process.stdout.write("\n");
  if (event.type === "agent.failed") throw event.error;
  if (event.type === "agent.stopped") throw new Error(event.stopReason);
}
```

运行 `bun run quickstart.ts`，会看到实际执行的工具结果，以及假模型按脚本返回的文本：

```text
check_stock: {"sku":"A-1","available":3}
A-1 还有 3 件库存。
```

## 接入真实模型

以 OpenAI Chat Completions 为例，设置 `OPENAI_API_KEY` 和 `REIN_MODEL`，后者填支持工具调用的模型 ID。使用兼容网关时再设置 `OPENAI_BASE_URL`。可以把这些变量放在本地 `.env` 中，不要提交密钥。

将快速开始里的 `createFakeModel` 导入换成下面两条导入，再替换 `const model` 的定义。工具和 `agent.stream()` 不变。

```ts
import OpenAI from "openai";
import { OpenAIChatCompletionsModel } from "rein-kit/openai";

const modelId = process.env.REIN_MODEL;
if (!modelId) throw new Error("请设置 REIN_MODEL");

const model = new OpenAIChatCompletionsModel({ client: new OpenAI(), model: modelId });
```

| 模型 API | 适配器 | 导入路径 | SDK |
| --- | --- | --- | --- |
| OpenAI Chat Completions | `OpenAIChatCompletionsModel` | `rein-kit/openai` | `openai` |
| OpenAI Responses | `OpenAIResponsesModel` | `rein-kit/openai` | `openai` |
| Anthropic Messages | `AnthropicMessagesModel` | `rein-kit/anthropic` | `@anthropic-ai/sdk` |

核心入口不引入厂商 SDK。以上 SDK 已包含在仓库的开发依赖中；[安装到自己的项目](docs/guide.md#安装与打包)时，只需另装所选的 SDK。已配置兼容网关的话，也可直接运行 `bun run examples tool-loop`，查看[完整示例](examples/README.md)。

## 按场景找到下一步

| 如果你需要 | 从这里开始 |
| --- | --- |
| 执行写操作前先问人 | [审批队列](docs/guide.md#审批队列)：暂停待审工具，记录决定，再恢复同一次运行。 |
| 在不同请求之间延续对话 | [会话存储](docs/guide.md#会话存储)：用 `sessionId` 载入并追加对话历史。 |
| 进程重启后继续未完成任务 | [持久恢复](docs/guide.md#进程崩溃后的持久恢复)：配置检查点存储，按 `runId` 恢复。 |
| 输出经过校验的数据，或让模型读取图片与 PDF | [结构化输出](docs/guide.md#结构化输出) · [多模态输入](docs/guide.md#多模态用户消息) |
| 限制长任务的时间、调用次数和上下文大小 | [预算与重试](docs/guide.md#预算与重试)：也可限制每条工具结果的字节数。 |
| 排查模型调用与工具执行，或在 CI 中做回归 | [追踪与评估](docs/guide.md#追踪与评估)：支持 OpenTelemetry 导出和离线假模型。 |
| 接入 MCP 工具，或把子任务交给另一个 Agent | [MCP 与子代理](docs/guide.md#扩展) |

**运行边界：** Rein 不是执行沙箱。鉴权、工具实际能访问什么、并发恢复去重都由应用负责。检查点恢复可能重放工具调用；有外部副作用的工具应使用幂等键。Token 预算也不是账单上限。

## 开发

源码和示例使用 Bun；构建后的 ESM 包也可在 Node.js 中使用。安装依赖后运行以下检查，均不需要模型密钥（打包验收还需要 Node.js 和 npm）：

```sh
bun run typecheck
bun test
bun run verify-package
```

[术语表](GLOSSARY.md) · [开发路线图](docs/research/rein-roadmap.md) · [MIT 许可证](LICENSE)
