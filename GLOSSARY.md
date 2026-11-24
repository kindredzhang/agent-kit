# AgentKit

AgentKit coordinates model conversations and executable tools to produce an assistant response.

## Language

**Agent**:
An entity that coordinates model turns and tool execution for one run.
_Avoid_: Assistant, model

**Agent run**:
One request handled by an Agent, from its input messages through completion, a stopped state, or failure.
_Avoid_: Session

**Agent stop reason**:
The run-level outcome that explains whether an Agent completed, stopped, or failed, independent of how its last Model turn ended.
_Avoid_: Finish reason

**Model turn**:
One request to a language model and its response within an Agent run.
_Avoid_: Agent run

**Tool**:
A named capability that an Agent can make available to a language model for execution.
_Avoid_: Function, plugin

**Tool call**:
A language model's request to execute a named Tool with structured input.
_Avoid_: Tool execution

**Tool result**:
The structured outcome of a Tool call, including an error when execution fails.
_Avoid_: Tool response

**Tool annotation**:
A declaration about a Tool's expected behavior, such as whether it reads data, changes state, or can be repeated safely.
_Avoid_: Permission

**Tool approval**:
A decision by the host or a person to allow a Tool call to execute.
_Avoid_: Tool result
