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

**Wall-clock budget**:
The maximum active execution time allowed for an Agent run and its descendants, excluding time spent paused for a Tool approval.
_Avoid_: Timeout, deadline

**Tool timeout**:
The maximum duration one attempt of a Tool execution may take before it is reported as a failed Tool call.
_Avoid_: Wall-clock budget, cancellation

**Trace record**:
The serializable timing record of one Agent run segment, covering its turns, Model calls, Tool executions, approvals and outcome.
_Avoid_: Span, log entry

**Span**:
An OpenTelemetry unit of work that a Trace record is exported into, carrying a name, kind, timing, attributes and status.
_Avoid_: Trace record, event

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

**Run checkpoint**:
An Agent run state that an Agent writes to a run store while the run is still executing, so that a crashed process can continue it.
_Avoid_: Session, backup

**Resume point**:
Where a checkpoint says the run continues: before the next Model turn, or before a pending Tool batch.
_Avoid_: Step

**Replay window**:
The work a recovery re-executes, either one Model turn or one pending Tool batch.
_Avoid_: Retry

**Idempotency key**:
A stable identifier for one logical action that a destination uses to reject duplicate execution; for a replayed Tool call it is the Tool call id.
_Avoid_: Approval

**Adapter**:
A concrete `LanguageModel` implementation that translates between one vendor SDK's messages and stream events and the core types. Adapters are published on subpath exports so the core entry point stays free of vendor SDK types.
_Avoid_: Provider, plugin

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

**Model request retry**:
Repeating a model request that failed before it emitted any output.
_Avoid_: Tool retry, run resume

**Eval observation**:
The observable result of one Agent run reduced for assertions: stop reason, tool trajectory, text, structured output, and usage.
_Avoid_: Trace

**Eval case**:
A named input with the expectations an eval observation must satisfy.
_Avoid_: Test

**Tool annotation**:
A declaration about a Tool's expected behavior, such as whether it reads data, changes state, or can be repeated safely.
_Avoid_: Permission

**Tool approval**:
A decision by the host or a person to allow a Tool call to execute.
_Avoid_: Tool result

**Approval request**:
One Tool call waiting for a Tool approval, recorded with the Tool, its parsed input, and the decision once made.
_Avoid_: Checkpoint

**Approval queue**:
A store of Approval requests that a host reads and decides outside the process that paused the Agent run.
_Avoid_: Run store

**Approval cursor**:
An opaque marker naming a position in the queue's order, used to fetch the page after it without skipping or repeating requests.
_Avoid_: Offset, page number

**Approval retention**:
The policy for when decided Approval requests stop being kept, expressed as the age past which they are pruned.
_Avoid_: Cleanup job, TTL

**Subagent**:
An Agent run started on behalf of a parent Agent run, exposed to that parent as a Tool whose result is the child run's final text.
_Avoid_: Agent run, handoff

**Structured output**:
A final answer that an Agent validates against a host-provided schema before the run completes.
_Avoid_: JSON mode, response format

**Output tool**:
The implicit Tool an Agent exposes to a model so that a final structured answer arrives as a Tool call.
_Avoid_: Final answer

**Fake model**:
A LanguageModel whose responses come from a host-written script instead of a provider, so Agent behavior can be tested without a network or an API key.
_Avoid_: Mock, stub

**Scripted turn**:
One entry in a Fake model's script describing what the model replies on a single Model turn, including text, Tool calls, usage, or a scripted failure.
_Avoid_: Fixture, response
