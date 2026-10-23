# 0003 — The exec unit's child-environment allowlist and provenance

## Context

`src/workflows/exec/exec-unit.ts` is the one place a frozen workflow spawns
a shell command as a unit. A spawned child inherits none of AKM's own
process safety by default — no argv-injection protection, no environment
isolation, no output bound — so every one of those has to be a deliberate
design choice in this one module rather than an accident of whatever
`child_process` defaults to.

## Decision

### The module's invariants

Moved verbatim from `exec-unit.ts`'s module header:

> The `exec` unit runner — the ONE place a frozen workflow spawns a shell
> command as a unit. The invariants it exists to hold:
>
> - ARGV, NEVER A SHELL STRING. `IrExecSpec.command` is an argv ARRAY and
>   the format has no shell-string spelling at all; the child is spawned
>   directly, so `;`, `|`, `&&`, `$(…)`, backticks, `>` and `*` are inert
>   literal argument BYTES. A workflow that wants a pipeline names the
>   interpreter itself (`["bash", "-lc", "a | b"]`), visibly in frontmatter.
> - NON-BLOCKING. Everything on this path is async. A synchronous call here
>   blocks the event loop and with it every concurrently-scheduled unit,
>   the run's lease heartbeat, and abort handling.
> - NO LEAKED CHILDREN. `runManagedSubprocess` spawns DETACHED and runs a
>   SIGTERM→SIGKILL ladder against the whole process group, so `--timeout`
>   and Ctrl-C really do stop a running command and its descendants.
> - NO CONTAINMENT. `exec.cwd` is relative to the run's bundle root or
>   absolute, and nothing checks where it leads: a command can reach any
>   directory anyway, so a directory is not a security boundary.
> - BOUNDED SPEND. A command is arbitrary code with no resource discipline
>   of its own, so each resource it spends on akm's behalf has a ceiling in
>   `workflows/resource-limits.ts`: wall clock (`DEFAULT_EXEC_TIMEOUT_MS` or
>   the authored `timeout:`), retained output
>   (`WORKFLOW_MAX_EXEC_OUTPUT_BYTES` per pipe) and the context environment
>   (`execContextLimits`, checked BEFORE the spawn so an oversized artifact
>   yields an actionable akm error, not a bare `E2BIG`).
> - ALLOWLISTED ENVIRONMENT. The child does NOT inherit akm's environment:
>   it starts EMPTY and receives exactly `EXEC_DEFAULT_ENV_PASSTHROUGH` plus
>   the unit's `exec.passEnv`, then the resolved `env:` bindings, then the
>   engine-authored `AKM_*` context. See `childEnv`.
>
> Secrets: `env` values reaching this module are already resolved from
> `env:` bindings by NAME (`resolveEnvBinding`) — the plan never carries
> inline secrets and the input hash only ever carries names. The caller
> scrubs the outcome with `redactUnitOutcome` BEFORE anything is journaled,
> which is why this module may return raw stdout/stderr diagnostics without
> knowing anything about redaction.
>
> Layering: a LEAF. Node built-ins, `core/spawn-env`, `core/subprocess`,
> `core/warn` and the import-free `workflows/resource-limits` (plus erased
> types) only, so the executor can consume it without opening an import
> cycle.

### The default allowlist and why it is an allowlist

Moved verbatim from `EXEC_DEFAULT_ENV_PASSTHROUGH`'s doc comment and
`childEnv`'s doc comment:

> The DEFAULT environment allowlist for an exec unit's child — the single
> definition of the EXEC list (the docs describe it, the tests assert
> against it, and `exec.passEnv` extends it per unit). The win32
> process-creation names are not re-spelled here: they are spread from
> `WIN32_SPAWN_ENV_FLOOR`, which owns them.
>
> The child starts from an EMPTY environment and receives only these names,
> matching how an agent harness child is already built
> (`profile.envPassthrough` → `collectAllowlistedEnv`) — and literally
> extending the same `COMMON_SPAWN_ENV_PASSTHROUGH` baseline those profiles
> start from, so the two child-spawn allowlists share one floor. Every
> entry earns its place by being load-bearing for ordinary commands on some
> supported platform: `PATH` (command resolution), `HOME` (the config/cache
> root essentially every toolchain reads), `USER`/`LOGNAME` (process
> identity for git/ssh), `SHELL` (tools that re-exec a login shell),
> `LANG`/`LC_ALL`/`LC_CTYPE` (text encoding — without a locale a command
> falls back to the C locale and mangles non-ASCII stdout, which IS this
> unit's artifact), `TERM` (some CLIs abort or emit raw escape bytes with no
> TERM), `TZ` (timestamps a command prints would otherwise silently switch
> to the host default), `TMPDIR` (POSIX scratch space), the win32 spawn
> floor plus `APPDATA`/`LOCALAPPDATA`/`ProgramData`/`ProgramFiles` (Windows
> toolchain roots not on the floor itself), and `AKM_EVENT_SOURCE`
> (provenance, never a secret: an exec unit that calls `akm` must record
> machine traffic rather than user demand, exactly as the agent passthrough
> list does — DRIFT-6).
>
> Deliberately ABSENT and reachable only through `exec.passEnv` / `env:`:
> credentials of every kind, cloud/CI vars, and the proxy family
> (`HTTP_PROXY` & friends) — proxy URLs routinely embed credentials, which
> is why akm's redaction policy already treats URL-shaped passthrough
> values as credential-bearing.
>
> The child's environment resolves in three layers with fixed precedence:
> (1) the BASE — the default allowlist plus the unit's `exec.passEnv`
> names; (2) the unit's resolved `env:` bindings; (3) the engine-authored
> `AKM_*` context, LAST so a workflow-supplied binding can never shadow the
> ids/item the engine is telling the command the truth about.
>
> **Why the default is an allowlist.** Not because it stops an attacker: a
> command that runs at all can read the same credentials off disk that the
> environment would have handed it, and a workflow source is executed code
> either way (`docs/guides/run-workflows.md`, "workflow sources are
> executed code"). The allowlist earns its place for three narrower, real
> reasons: it bounds ACCIDENTAL exposure — the ambient shell of whoever ran
> `akm workflow run` (or the CI job that did) routinely carries tokens for
> unrelated services, and a third-party workflow step that merely prints
> its environment should not get them for free; it makes the environment
> surface EXPLICIT and REVIEWABLE — what a command can see is this constant
> plus lines in the frontmatter diff, rather than "whatever the invoking
> shell happened to export"; and it matches the convention akm already
> applies to spawned children — `profile.envPassthrough` in
> `integrations/agent/spawn.ts` has always built agent-harness children
> this way, and the SAME `collectAllowlistedEnv` does it here, so there is
> one mechanism to review instead of two.

### Capture and overflow semantics

Moved verbatim from `runExecUnit`'s doc comment:

> Run one exec unit and map its process outcome onto the dispatch
> vocabulary: non-zero exit → `non_zero_exit`, wall-clock expiry →
> `timeout`, cancellation → `aborted`, a child that never started →
> `spawn_failed`. All four are pre-existing `AgentFailureReason` members, so
> `retry.on` keeps working unchanged. The out-of-taxonomy
> `exec_output_limit`, `exec_context_too_large` and
> `exec_capture_incomplete` are deliberate: each is a runaway, an
> authoring bug, or work that ALREADY RAN — never a transient — so no
> `retry.on` value can ever re-dispatch one.
>
> **An INCOMPLETE STDOUT capture is a failure, never a partial artifact.**
> `exitCode === 0` is not on its own proof that stdout was fully read: a
> pipe can error, and the stream-drain timeout can fire while the command
> LEADER has already exited 0 because a background descendant still holds
> the stdout fd open. Both leave a PREFIX, and promoting it would hand the
> next step, the gate judge and `steps.<id>.output` a silently truncated
> artifact. So the unit fails instead, through the same shared classifier
> (`streamCaptureFailure`) the agent spawn path uses. Only STDOUT is fatal
> here — stderr is a diagnostic channel that never contributes to the
> artifact, so a stderr drain that did not finish leaves the unit's actual
> result intact. The stdout reason is `exec_capture_incomplete`,
> deliberately OUTSIDE the `retry.on` taxonomy, for the same reason
> `journal_write_failed` is: the command RAN TO COMPLETION and exited 0 —
> what failed is akm's record of it. A retryable reason here would let
> `retry.on: [spawn_failed]` re-dispatch byte-identical argv for a command
> that already deployed, already published, already migrated.
>
> **Output OVERFLOW does not fail a command that passed.** Crossing
> `WORKFLOW_MAX_EXEC_OUTPUT_BYTES` is a different condition: the reader DID
> drain the pipe to its end, it just stopped RETAINING, so the child never
> blocked and its exit code is real. Overflow splits by what the unit
> PROMISED about its output: no declared `output:` schema → success, with
> the artifact carrying a `WORKFLOW_EXEC_OUTPUT_TRUNCATED_MARKER` block
> naming both byte counts; a declared `output:` schema →
> `exec_output_limit`, since a truncated JSON prefix cannot parse and
> promoting it would corrupt every downstream reference to the typed
> artifact. stderr overflow never fails anything.

## Consequences

- Adding a new name to `EXEC_DEFAULT_ENV_PASSTHROUGH` is a real security
  and portability decision, not a drive-by convenience edit — every
  existing entry earns its place with a documented reason above, and a new
  one should be held to the same bar.
- The allowlist mechanism (`collectAllowlistedEnv`) is deliberately the
  SAME one `integrations/agent/spawn.ts` uses for agent-harness children —
  a divergence between the two lists is a drift to catch, not a place to
  special-case exec units.
- The engine-authored `AKM_*` context is applied LAST specifically so no
  authored `env:` binding can ever shadow it; any future third environment
  layer must preserve that ordering guarantee or a workflow step gains the
  ability to spoof its own run/step/unit identity to the engine.
- `exec_capture_incomplete` and `exec_output_limit` must never be added to
  any `retry.on` taxonomy — doing so would let a step's own retry policy
  re-run a command whose side effects already happened.

## Provenance

- Source: `src/workflows/exec/exec-unit.ts` — module header (invariants),
  `EXEC_DEFAULT_ENV_PASSTHROUGH`'s doc comment, `childEnv`'s doc comment,
  `runExecUnit`'s doc comment.
- Related: DRIFT-6 (`AKM_EVENT_SOURCE` provenance parity with the agent
  passthrough list); `docs/guides/run-workflows.md` ("workflow sources are
  executed code").
- Extracted: P4 (`docs/plans/specs/p4-deletions-closeout.md` §4.2), 2026-08-27.
