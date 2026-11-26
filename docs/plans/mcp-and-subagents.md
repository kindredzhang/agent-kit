# AgentKit 下一阶段实施计划：MCP 工具接入与子代理

> 日期：2026-11-26。依据：[路线图阶段 5](../research/agentkit-roadmap.md)。
> 前置已完成：停止原因、工具策略与审批、上下文预算、Session、同一 run 暂停恢复、追踪与工具轨迹评估。

---

## 1. 范围

**阶段 A：MCP 客户端工具接入**

把已连接的 MCP 客户端提供的工具映射为 `AgentTool`，复用现有审批策略、并行规划、错误回灌、暂停恢复与追踪。

**阶段 B：子代理（agents-as-tools）**

子代理作为一个工具：输入任务描述，输出最终摘要；父 Agent 保留控制权，天然复用工具作用域与审批。

**非目标**

- MCP 的 resources、prompts、sampling、elicitation、OAuth 与 SSE 传输。
- handoff 式多代理路由、显式图编排。
- 跨代理预算（美元或 token）。先完成深度与并发上限，预算单独排期。
- 图片/音频工具结果映射到模型消息：AgentKit 消息目前只有文本工具结果。

---

## 2. 现有接缝（实现必须复用的事实）

- `AgentTool`：`name`、`description`、`inputSchema`、`annotations`、`requiresApproval`、`parseInput`、`execute`；`parseInput` 接收 `JsonObject`。
- 审批默认：`requiresApproval` 未设置时，`readOnly !== true || destructive === true` 需要审批；只有 `readOnly` 且非 `destructive` 的工具可并行。
- 工具执行抛错会转为 `tool.execution.failed`，并以 `isError` 工具消息回灌模型，不会终止 run。
- 暂停快照已保存 `toolDefinitions` 与 `toolApprovalPolicies`，恢复时以 JSON 比较；工具定义变化会被拒绝。
- 追踪按 `tool.execution.started` 建立 `execute_tool` span，审批事件单独记录。

---

## 3. 阶段 A：MCP 工具接入

### 3.1 接口草图

```ts
// src/integrations/mcp.ts

export interface MCPToolClient {
  listTools(params?: { cursor?: string }): Promise<{
    tools: readonly {
      name: string;
      description?: string;
      inputSchema: unknown;
      annotations?: {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
      };
    }[];
    nextCursor?: string;
  }>;
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<{
    content?: readonly { type: string; text?: string }[];
    structuredContent?: unknown;
    isError?: boolean;
  }>;
}

export interface MCPToolSourceOptions {
  namespace?: string;
  trustAnnotations?: boolean;
  toolName?: (serverToolName: string) => string;
}

export function createMCPToolSource(
  client: MCPToolClient,
  options?: MCPToolSourceOptions,
): Promise<{ tools: AnyAgentTool[]; refresh(): Promise<void> }>;
```

- 结构化的 `MCPToolClient` 让核心零运行时依赖；宿主传入真实 MCP SDK 客户端。测试用真实 SDK 的 in-memory 传输做契约测试（仅开发依赖），另用 fake port 覆盖映射分支。
- 适配器不负责 `connect()`/`close()`；调用方在连接后创建 tool source，客户端关闭后工具失效。
- `refresh()` 重新列出工具，供宿主在服务端声明变化后更新；已构建的 `Agent` 需要重建才能看到新工具。

### 3.2 映射决策

| 主题 | 决策 | 理由 |
| --- | --- | --- |
| 命名 | 默认 `namespace__toolName`；`toolName` 可覆盖；结果必须匹配 `[A-Za-z0-9_-]{1,64}`，不合法直接报错 | 静默改写会造成不可见的重名；长度限制来自模型侧工具名约束 |
| 审批 | 默认所有 MCP 工具 `requiresApproval: true`，且不暴露 `readOnly`/`destructive` 注解 | MCP 规范明确注解是不可信提示；若按其声明自动放行，恶意服务端可把写操作标成只读 |
| 受信模式 | `trustAnnotations: true` 时映射 `readOnlyHint`/`destructiveHint`/`idempotentHint`，允许只读工具并行与免审批 | 宿主明确为该服务端背书后才启用 |
| 描述 | 缺失时回退为工具名 | `AgentTool.description` 是必填 |
| 输入校验 | `parseInput` 原样返回 `JsonObject`；参数合法性由服务端判定 | 本地没有该工具的校验器；审批 UI 仍能看到原始参数 |
| 结果 | 优先 `structuredContent`；否则拼接 text 块；含非文本块时返回完整 `content` 的 JSON | JSON 可表达文本与结构化数据；图片/音频留待消息模型扩展 |
| 错误 | `isError: true` 时抛出错误，文本作为 message；协议层异常原样抛出 | 复用现有 `isError` 回灌路径；模型可以据此纠正 |
| 分页 | 循环 `nextCursor` 直到结束；重复游标或超过 100 页时报错 | 防止服务端缺陷造成死循环 |
| 重名 | 与本地工具的重名由 `Agent` 构造器报错 | 适配器无法知道宿主的本地工具集合 |

### 3.3 切片与测试

| 切片 | 内容 | 测试接缝 |
| --- | --- | --- |
| A0 | 依赖验证（**已完成**，见下方实测结论） | 一次性契约测试 |
| A1 | 只读工具映射、命名空间、结构化结果；模型调用后得到工具结果（**已完成**） | `Agent.stream` + 真实 in-memory 服务端 |
| A2 | 默认审批与 `trustAnnotations`；敌意服务端声称 `readOnlyHint: true` 的写工具仍会暂停（**已完成**） | `Agent.stream` 产生 `tool.approval.requested`，而非直接执行 |
| A3 | `isError`、结构化结果优先级、分页、非法名称、重名（**已完成**） | fake port 单测 + 一个 `Agent.stream` 错误回灌用例 |
| A4 | 工具定义变化：暂停中的 run 在服务端 schema 变化后恢复被拒绝（**已完成**） | `Agent.resume` 发出 `agent.failed`，错误指向工具不匹配 |
| A5 | README 与路线图更新；声明宿主负责鉴权、连接生命周期与服务端行为可信度（**已完成**） | 文档评审 |

**A0 实测结论（2026-11-26，Bun 1.3.14）**

- `@modelcontextprotocol/client@2.4.0` 与 `@modelcontextprotocol/server@2.4.0` 可在 Bun 下加载、连接和调用，`engines.node >= 20` 未构成阻塞。
- `InMemoryTransport.createLinkedPair()` 从 `@modelcontextprotocol/client` 主入口导出；两端分别交给 `Client` 与 `McpServer` 后 `connect` 即可。
- `listTools()` 返回 `{ tools: [{ name, description?, inputSchema, annotations? }], nextCursor? }`，`inputSchema` 是 JSON Schema；省略 schema 的工具返回 `{ type: "object", properties: {} }`。
- `callTool()` 返回 `{ content: [{ type: "text", text }], structuredContent?, isError? }`。参数校验失败与工具自身失败都返回 `isError: true`，不抛异常；只有未知工具等协议错误才抛出（`Tool <name> not found`）。
- 服务端 `registerTool` 的 `inputSchema` 必须是 Zod v4 schema 或 raw shape；测试辅助代码需从 `zod/v4` 导入。

因此适配器只需区分「结果」与「抛出」两条路径：`isError` 结果转为工具错误，抛出的协议错误原样交给 `Agent` 捕获。契约测试可以直接用真实 SDK，无需退回到纯 fake。

**A1–A5 实现结论（2026-11-26）**

- 实现位于 `src/integrations/mcp.ts`，测试位于 `src/integrations/mcp.test.ts`（7 项），全量 46 项测试通过。
- `listTools()` 不传 cursor 时 SDK 自动聚合分页；适配器仍保留游标循环与 100 页上限，以兼容只返回单页的实现和 fake client。
- SDK 的列表结果默认走缓存，服务端 `tools/list_changed` 会让缓存失效；适配器的 `refresh()` 额外传 `cacheMode: "refresh"` 强制拉取。测试通过包装客户端只在 refresh 时改变 schema，证明该参数确实被传递。
- 与计划的偏差：无功能性偏差；命名正则的报错文案改为不含锚点的 `[A-Za-z0-9_-]{1,64}`，便于阅读。

`tool.execution.started`/`completed` 的追踪无需改动，现有收集器自动覆盖；A1 测试顺带断言 span 名称。

---

## 4. 阶段 B：子代理

### 4.1 接口草图

```ts
export interface SubagentToolOptions {
  name: string;
  description: string;
  createAgent: (depth: number) => Agent;
  depth?: number;
  maxDepth?: number;
  maxConcurrency?: number;
  onUsage?: (usage: TokenUsage) => void;
}

export function createSubagentTool(options: SubagentToolOptions): AnyAgentTool;
```

- 内部用 `defineTool` 定义 `{ task: string }` 输入；执行时调用 `createAgent(depth + 1)`，把 `task` 作为唯一 user 消息，透传 `ToolExecutionContext.signal`。
- 只接受以 `agent.completed` 结束的子 run，返回最终 assistant 文本；`agent.stopped`/`agent.failed` 转为工具错误，消息包含 `stopReason`，模型可以决定是否重试。
- `depth >= maxDepth`（默认 3）时直接抛错，不创建子 Agent。
- `maxConcurrency`（默认 2）用进程内信号量限制同一工具实例的并发子 run。
- `onUsage` 上报子 run 的累计 usage，供宿主做成本核算；跨代理预算不在本阶段。
- 子 run 的追踪与父 run 独立：宿主在 `createAgent` 里自行挂 `AgentTraceCollector`；父事件流不会混入子事件。

### 4.2 切片与测试

| 切片 | 内容 | 测试接缝 |
| --- | --- | --- |
| B1 | 单层子代理完成：父模型调用工具，子 Agent 完成，父模型收到摘要 | 父 `Agent.stream` + 确定性父子模型 |
| B2 | 非正常结束：子 run 被取消或失败时工具报错，父 run 仍可完成 | 子 run 的 `stopReason` 出现在工具错误消息中 |
| B3 | 深度上限与并发上限：超深拒绝；并发第三个调用等待 | 计数断言 + 受控 Promise |
| B4 | 取消传播：父 `AbortSignal` 中断时子 run 停止且不再调用模型 | 取消后模型调用次数 |
| B5 | usage 上报与 README 示例 | `onUsage` 收到子 run 累计值 |

---

## 5. 交付顺序与提交粒度

1. `feat: expose MCP client tools as agent tools`（A0–A4 + A5 文档）
2. `feat: run subagents as agent tools`（B1–B5）

每个提交前运行：`bun test`、`bun run tsc --noEmit`、`git diff --check`。新增依赖只进 `devDependencies`；核心不引入运行时依赖。

---

## 6. 风险与待确认

| 风险 | 缓解 |
| --- | --- |
| MCP v2 SDK 声明 `engines.node >= 20` | A0 已在 Bun 1.3.14 实测通过（连接、列工具、调用、`isError`、协议错误均符合预期）；仍只在 devDependencies 中用于契约测试 |
| 服务端可随时改变工具行为，schema 固定不代表行为固定 | 文档明确宿主信任边界；恢复校验只覆盖快照中的定义 |
| `isError` 的完整内容被压缩为错误 message | 首版接受；若宿主需要结构化错误，再扩展 `execute` 返回 `{ result, isError }` |
| 子代理成本放大 | 深度与并发上限先落地；token/美元预算排入下一阶段 |
| 工具副作用不保证 exactly-once | 与暂停恢复文档一致：宿主使用外部幂等键；后续可把 `approvalId` 加入 `ToolExecutionContext` |

需要确认的决策：

1. MCP SDK v2 只作为开发依赖（`@modelcontextprotocol/client`、`@modelcontextprotocol/server`），用于契约测试；核心适配器只依赖结构化 `MCPToolClient` 接口，不引入运行时依赖。实测已确认 Bun 兼容，推荐接受。
2. MCP 工具默认命名空间前缀是否采用 `__` 分隔。推荐采用，冲突时由 `Agent` 构造器显式报错。
3. 子代理 `maxDepth` 默认 3、`maxConcurrency` 默认 2 是否合适。推荐沿用路线图对照值。

---

## 7. 验收标准

- MCP：一个 in-memory 服务端的只读工具可被模型调用并回灌结果；写工具默认触发审批；敌意 `readOnlyHint` 不生效；`isError` 走现有回灌路径；暂停中的 run 在工具定义变化后恢复失败。
- 子代理：父 run 通过工具获得子 run 摘要；子 run 异常不影响父 run 终态；深度与并发上限生效；取消可传播。
- 追踪：MCP 工具自动产生 `execute_tool` span，无需修改收集器。
- 文档：README 增加两节用法与安全边界；路线图阶段 5 标记完成。
