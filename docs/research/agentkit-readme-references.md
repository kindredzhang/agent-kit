# AgentKit 首页 README 对照

> 调研日期：2026-11-27。只比较三个开源框架的 GitHub 官方 README 如何引导开发者，不评测框架能力。

## 对照

| 官方 README | 实际写法 | AgentKit 可借鉴 |
| --- | --- | --- |
| [Vercel AI SDK（TypeScript）](https://github.com/vercel/ai/blob/main/README.md) | 首句同时交代语言、用途和厂商无关；[Unified Provider Architecture](https://github.com/vercel/ai/blob/main/README.md#unified-provider-architecture) 用两种模型接入方式展示同一个调用入口，[Usage](https://github.com/vercel/ai/blob/main/README.md#usage) 再按任务展开。 | 开头说清「用 TypeScript/Bun 构建能调用工具的 Agent」，接着说明换的是模型适配器，不是工具和运行事件接口。不在开头列完所有适配器。 |
| [OpenAI Agents SDK JS（TypeScript）](https://github.com/openai/openai-agents-js/blob/main/README.md) | [Get started](https://github.com/openai/openai-agents-js/blob/main/README.md#get-started) 先给运行环境和安装方式，再按文本、沙箱、语音分流；[文本示例](https://github.com/openai/openai-agents-js/blob/main/README.md#build-a-text-agent) 创建 Agent、运行一次并打印结果。[Core concepts](https://github.com/openai/openai-agents-js/blob/main/README.md#core-concepts) 用一句解释加一个指南链接介绍每个概念。 | 首页只保留一条最短路径。把模型配置提前到示例前，给出准确的 Bun 命令和可观察结果；审批、会话和事件各用一句话说明何时需要，再链接到指南。 |
| [Pydantic AI（Python）](https://github.com/pydantic/pydantic-ai/blob/main/README.md) | [What are you building?](https://github.com/pydantic/pydantic-ai/blob/main/README.md#what-are-you-building) 按开发者要做的事分节；如[数据提取](https://github.com/pydantic/pydantic-ai/blob/main/README.md#data-extraction) 展示安装、代码和输出，紧跟对应指南。[Next Steps](https://github.com/pydantic/pydantic-ai/blob/main/README.md#next-steps) 再分安装与示例、观测、上线。 | 让场景成为找文档的入口：工具要改数据 → 看人工审批与恢复；要跨请求保留对话 → 看会话存储；要排查一次运行 → 看事件与追踪。每个场景只引一条最相关的入口。 |

## 建议的首页顺序

1. **一句话定位。** 交代它是嵌入应用的 Agent 运行库，以及为何选它：不只是调一次模型，而是让模型调用应用提供的工具。
2. **一条可跑的路径。** 按 Bun 前置条件 → 获取代码或安装 → 模型配置 → 运行命令 → 预期看到的结果排列。优先选一个查固定数据的只读工具，不引入数据库、外部工具服务或审批配置；说明能观察到什么，不保证模型逐字输出。
3. **按需求去下一步。** 在示例后放两三条「遇到什么问题 → 读哪篇指南」，而不是第二个长示例或全量 API 清单。具体命令、导入和内部链接以仓库当前可用的入口为准。
