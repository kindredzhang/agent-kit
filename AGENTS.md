# Agent Instructions

- 项目暂用名称为 AgentKit；命名可随项目演进调整。
- 使用 TypeScript 和 Bun。
- 源码文件中不写注释；通过清晰的命名、类型和模块结构表达意图。
- Agent、消息、事件和模型接口保持厂商无关。
- OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 的 SDK 调用和数据转换分别放在对应适配器中。
- 各厂商适配器使用官方 SDK，并转换为核心统一的消息与流事件类型。
