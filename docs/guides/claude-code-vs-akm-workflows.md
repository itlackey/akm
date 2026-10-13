# Choosing between a session-native workflow and an AKM workflow

Most coding assistants, Claude Code included, offer a native way to fan work
out inside the current session — an in-context script or tool that spawns
subagents, runs them concurrently, and reports back before the session ends.
AKM workflows are a different thing: a portable procedure that any supported
agent harness can run, with durable state, retries, gates, and resume built
in. A workflow source is Markdown `.md`, lowered to source IR version 1. Every run freezes the durable plan
v4 family's executable `irVersion: 5` before execution; pre-`irVersion`-5
stored plans are rejected.
Neither replaces the other — they solve different problems, and the right
choice depends on whether the work is a one-off inside a session or a
procedure worth keeping. Use the table below to pick.

| Use a session-native workflow when... | Use an AKM workflow when... |
| --- | --- |
| Work is temporary and belongs to one active assistant session | The procedure should survive sessions and be shared |
| The assistant's native orchestration is the main value | Stable inputs, outputs, retries, gates, and resume matter |
| Tool-specific behavior is acceptable | Portability and a durable source definition matter |
| No long-lived run record is needed | Run state and verification need to persist |

For the deep technical dive — representation, execution model, concurrency,
persistence, and where the two approaches overlap and diverge — see the full
comparison at
[docs/architecture/comparisons/claude-code-vs-akm-workflows-full.md](../architecture/comparisons/claude-code-vs-akm-workflows-full.md).

To run an existing AKM workflow, see
[docs/guides/run-workflows.md](run-workflows.md). To author a new one, see
[docs/guides/author-workflows.md](author-workflows.md).
