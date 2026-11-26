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

**Context budget**:
The maximum estimated input context allowed for one Model turn in an Agent run.
_Avoid_: Output limit

**Context compaction**:
Reducing the active conversation context by removing older complete interactions while preserving instructions and the current request.
_Avoid_: Summarization

**Model turn**:
One request to a language model and its response within an Agent run.
_Avoid_: Agent run

**Session**:
A conversation history that can be continued across multiple Agent runs.
_Avoid_: Agent run

**Agent run state**:
A snapshot of an unfinished Agent run that can continue from a supported pause point.
_Avoid_: Session

**Tool**:
A named capability that an Agent can make available to a language model for execution.
_Avoid_: Function, plugin

**Tool call**:
A language model's request to execute a named Tool with structured input.
_Avoid_: Tool execution

**Tool result**:
The structured outcome of a Tool call, including an error when execution fails.
_Avoid_: Tool response

**Tool retry**:
Repeating a failed Tool execution under a policy declared by the Tool definition.
_Avoid_: Model retry, run resume

**Tool annotation**:
A declaration about a Tool's expected behavior, such as whether it reads data, changes state, or can be repeated safely.
_Avoid_: Permission

**Tool approval**:
A decision by the host or a person to allow a Tool call to execute.
_Avoid_: Tool result

**Subagent**:
An Agent run started on behalf of a parent Agent run, exposed to that parent as a Tool whose result is the child run's final text.
_Avoid_: Agent run, handoff

**Structured output**:
A final answer that an Agent validates against a host-provided schema before the run completes.
_Avoid_: JSON mode, response format

**Output tool**:
The implicit Tool an Agent exposes to a model so that a final structured answer arrives as a Tool call.
_Avoid_: Final answer
