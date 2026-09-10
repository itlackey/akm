# Manual tests — `akm task` and `akm workflow` (0.9.2)

This document is a focused manual-QA suite for the `akm task` and `akm
workflow` subsystems shipped in PR #844 ("Task/workflow final refactor:
typed task inputs, child workflows, v3 retirement"). It sits alongside
[`manual-testing-checklist.md`](./manual-testing-checklist.md) (the
general-purpose runbook, whose §14/§15 give a lighter pass over the same
commands) as the deeper, field-level reference for this specific feature
area — use it when validating a task/workflow release or investigating a
regression in scheduling, typed inputs, child workflows, or the
task↔workflow seam.

**Verified against:** `akm` `0.9.2-alpha.5`, commit `fb7bef3f` (branch
`release/0.9.2`). Every expected result marked "verified live" below was
captured by actually running that exact command against that exact commit
during authoring/review of this document, via `bun src/cli.ts` in an
isolated sandbox (see [Setup](#setup-one-sandbox-for-every-non-destructive-test)
below) — not inferred from source or docs. Anything not run live is marked
`UNVERIFIED` in bold, inline, at the point it applies. **Re-verify the exact
JSON field names, error strings, and exit codes here before relying on them
against a later release** — none of this is covered by automated tests
(that's the point of a manual suite), so it can drift silently.

The two defects discovered during that live pass were fixed before stable:
#846 is now a cross-bundle scheduler-isolation regression, and #847 is now an
abandon/resume durable-spine regression. Their corrected expectations below
are pinned by automated integration coverage on the stable candidate; the
remaining "verified live" labels still refer to the alpha.5 run above.

## Read this first — the one safety-critical finding

**`akm task sync` (and, to a lesser extent, `akm task add`) write to the
real, global, per-OS-user scheduler (cron / launchd / schtasks) — no
`AKM_*_DIR` environment variable isolates it.** Setting `AKM_BUNDLE_DIR`,
`AKM_DATA_DIR`, etc. isolates task *files* and akm's own state, but the
scheduler is one shared, host-global resource with no concept of your
sandbox.

Before #846 was fixed, `task sync`'s orphan-removal used bundle-name equality
without also confirming the installed entry's resolved bundle path. Two
unregistered bundles with the same directory basename could therefore make
one bundle inspect another's scheduler entry as an orphan. Stable 0.9.2
requires both the matching name and matching resolved owner path for this
primary-bundle case, and refuses to remove an entry whose owner path cannot be
established. DT-5 below pins that boundary. **There is still no `--dry-run`
for `task add`/`task sync`, so scheduler tests remain destructive.**

Practical rule for every test below that touches `add`/`sync`:

1. Never run them on a machine with real akm-managed scheduler entries
   unless you have taken a `crontab -l` (or platform equivalent) backup
   immediately beforehand and can restore it.
2. Prefer an explicit, collision-proof `--bundle <name>` so evidence and
   cleanup are unambiguous, even though #846 now protects basename collisions.
3. Prefer a disposable container/VM with an empty scheduler.
4. Every destructive test below states its own backup/restore commands and
   uses an obviously-throwaway id (`akm-manual-test-*`). Follow them exactly;
   do not substitute `akm task sync` as a "cleanup" step (it can remove
   entries the test didn't create).

`akm task doctor` is read-only but **still reads the real OS scheduler**
regardless of `AKM_*_DIR` isolation — seeing your host's real cron entries
in `doctor` output during an "isolated" test is expected, not a bug.

## Setup — one sandbox for every non-destructive test

```sh
export AKM_SANDBOX="$(mktemp -d /tmp/akm-task-workflow-qa.XXXXXX)"
export AKM_BUNDLE_DIR="$AKM_SANDBOX/bundle"
export AKM_CONFIG_DIR="$AKM_SANDBOX/config"
export AKM_DATA_DIR="$AKM_SANDBOX/data"
export AKM_CACHE_DIR="$AKM_SANDBOX/cache"
export AKM_STATE_DIR="$AKM_SANDBOX/state"
mkdir -p "$AKM_BUNDLE_DIR"/{tasks,workflows,commands} \
  "$AKM_CONFIG_DIR" "$AKM_DATA_DIR" "$AKM_CACHE_DIR" "$AKM_STATE_DIR"
cat > "$AKM_CONFIG_DIR/config.json" <<'EOF'
{"configVersion":"0.9.0","semanticSearchMode":"off","registries":[]}
EOF
cd "$AKM_SANDBOX"   # workflow list/status scope by cwd — see WF-8

# Pick ONE binary and use it consistently for a given test run:
akm() { bun /home/founder3/code/github/itlackey/akm/src/cli.ts "$@"; }   # repo checkout
# akm() { "$AKM_SANDBOX/npm/bin/akm" "$@"; }   # after: npm i -g --prefix "$AKM_SANDBOX/npm" akm-cli@0.9.2
```

This hand-written `config.json` is enough for every `task` and `workflow`
command below — they resolve directly against `AKM_BUNDLE_DIR` without the
bundle needing to be a registered source. **The one exception is TASK-14**
(migration), where `migrate status`/`apply` require the bundle to be
registered via `akm setup` instead; that test gives its own setup variant.

**Cleanup for every non-destructive test:** `rm -rf "$AKM_SANDBOX"`. Nothing
outside it is touched. Destructive tests (final section) have their own,
separate cleanup that includes restoring the OS scheduler.

---

## Summary table

| ID | Name | Destructive | Platform | Live-verified | Expected-to-fail pending |
|---|---|:---:|---|:---:|---|
| TASK-1 | Typed input, default provenance | No | Any | Yes | — |
| TASK-2 | Provenance from explicit flag | No | Any | Yes | — |
| TASK-3 | Wrong-type input rejected | No | Any | Yes | — |
| TASK-4 | Missing required input: `explain` lenient, `run` strict | No | Any | Yes | — |
| TASK-5 | Undeclared input flag rejected | No | Any | Yes | — |
| TASK-6 | Reserved flag name collision | No | Any | Yes | — |
| TASK-7 | Secret-shaped default redacted in `explain` | No | Any | Yes | — |
| TASK-8 | Schedule-binding provenance | No | Any | Yes | — |
| TASK-9 | Required input w/o default bricks a schedule entry | No | Any | Yes | — |
| TASK-10 | `run` happy path; inputs validated then discarded | No | Any | Yes | — |
| TASK-11 | `history` reflects a real run | No | Any | Yes | — |
| TASK-12 | `run` on nonexistent task id (exit 1, not 2) | No | Any | Yes | — |
| TASK-13 | Pre-v4 stored task is rejected with a migration hint | No | Any | Yes | — |
| TASK-14 | v3→v4 migration end to end | No | Any | Yes | — |
| TASK-15 | `doctor` reports backend/paths | No | Linux verified; macOS/Windows **UNVERIFIED** | Partial | — |
| TASK-16 | Ineligible-checkout guard fires before any scheduler write | No | Any | Partial | — |
| WF-1 | Author and run an exec workflow end to end | No | Any | Yes | — |
| WF-2 | Default `create` template needs a judge engine | No | Any | Yes | — |
| WF-3 | Child workflow: `plan` expansion + `run` execution | No | Any | Yes | — |
| WF-4 | `plan` makes zero durable writes | No | Any | Yes | — |
| WF-5 | Failing step surfaces a clear diagnostic | No | Any | Yes | — |
| WF-6 | Blocked run → `abandon` → `resume` | No | Any | Alpha.5 bug reproduced; stable regression automated | — |
| WF-7 | Active (paused) run → `abandon` → `resume` (contrast to WF-6) | No | Any | Yes | — |
| WF-8 | `list` is cwd-scoped; `status <id>` is not | No | Any | Yes | — |
| WF-9 | Pre-`irVersion`-5 stored plan is retired | No | Any | Yes | — |
| WF-10 | Removed `inherit_env` is rejected | No | Any | Yes | — |
| INT-1 | A task that runs a workflow | No | Any | Yes | — |
| INT-2 | A workflow step that targets a task (+ typed input binding) | No | Any | Yes | — |
| INT-3 | Failure propagation: `task history` vs `workflow status` | No | Any | Yes | — |
| INT-4 | Identity across the seam: abandon then re-invoke | No | Any | Yes | — |
| INT-5 | Shipped `improve/*.yml` tasks as a real-world case | No | Any | Yes | — |
| DT-1 | `task add` happy path installs a real cron entry | **Yes** | Linux (cron) | Partial | — |
| DT-2 | `task add --disabled` writes a disabled binding | **Yes** | Linux (cron) | Partial | — |
| DT-3 | `task sync` drift reconciliation (shell-target task) | **Yes** | Linux (cron), VM recommended | No — **UNVERIFIED** | — |
| DT-4 | `task sync` reconciling a workflow-targeting task's schedule | **Yes** | Linux (cron), VM recommended | No — **UNVERIFIED** | — |
| DT-5 | Cross-bundle name collision cannot make `sync` remove another bundle's entries | **Yes** | Linux (cron), VM required | Automated; manual platform run **UNVERIFIED** | — |
| DT-6 | macOS launchd equivalents of DT-1..DT-3 | **Yes** | macOS — **PLATFORM-GATED, UNVERIFIED** | No | Issue #770 (no automated coverage) |
| DT-7 | Windows schtasks equivalents of DT-1..DT-3 | **Yes** | Windows — **PLATFORM-GATED, UNVERIFIED** | No | Issue #770 (no automated coverage) |

---

## Tasks

Scope: `akm task add|run|explain|history|sync|doctor`, non-destructive
subset. Destructive/`sync`/`add` scheduler-mutation tests are in
[Destructive & platform-gated](#destructive--platform-gated-tests) at the
end.

### TASK-1 — Typed input, default provenance

**Why it matters:** the most common real path — a task with typed inputs a
user never overrides. If `explain`'s provenance tracking is wrong here,
every other provenance claim is suspect too.

**Preconditions:** common sandbox above.

**Setup:**
```sh
cat > "$AKM_BUNDLE_DIR/tasks/manual-test-echo.yml" <<'EOF'
version: 4
name: Manual test echo
description: Echoes a greeting for manual QA
inputs:
  who:
    type: string
    default: world
  loud:
    type: boolean
    default: false
run: echo "hello $AKM_TASK_INPUTS"
schedule: "@daily"
EOF
```

**Command:** `akm task explain manual-test-echo --format json`

**Expected result (verified live):** exit `0`;
`.suppliedInputs.who == {"value":"world","provenance":"default"}`;
`.suppliedInputs.loud == {"value":false,"provenance":"default"}`;
`.inputDeclarations.who.default == "world"`;
`.schedule[0].cron == "@daily"`, `.schedule[0].enabled == true`.

**Cleanup:** keep `manual-test-echo.yml` for TASK-2/TASK-10/TASK-11 if
running the suite in order, otherwise `rm "$AKM_BUNDLE_DIR/tasks/manual-test-echo.yml"`.

### TASK-2 — Provenance from an explicit flag

**Why it matters:** provenance is the whole point of `explain` — a user
debugging "why did my scheduled run use X" needs to trust this field.

**Preconditions:** `manual-test-echo.yml` from TASK-1.

**Command:** `akm task explain manual-test-echo --who Alice --format json`

**Expected result (verified live):** exit `0`;
`.suppliedInputs.who == {"value":"Alice","provenance":"flag"}`;
`.suppliedInputs.loud` unchanged (`provenance: "default"`).

**Cleanup:** none (read-only).

### TASK-3 — Wrong-type input value is rejected

**Why it matters:** typed inputs are only useful if bad values are caught
before reaching a command/script — the core defect-prevention claim of the
release.

**Preconditions:** `manual-test-echo.yml` from TASK-1.

**Command:** `akm task explain manual-test-echo --loud notabool`

**Expected result (verified live, exact):** exit `2`; stderr:
```json
{"ok":false,"error":"Task input \"--loud\" must be boolean.","code":"INPUT_BINDING_INVALID","hint":"Check the step's with: keys against the target's declared inputs."}
```
Also run `akm task run manual-test-echo --loud notabool` and confirm the
same `code`/exit `2` — `run` and `explain` share one validator.

**Cleanup:** none.

### TASK-4 — Missing `required: true` input: `explain` is lenient, `run` is not

**Why it matters:** a real trap — a user who runs `explain` on a
half-configured task sees no error and may assume it's fine to schedule,
then discovers at `run` time that it fails.

**Setup:**
```sh
cat > "$AKM_BUNDLE_DIR/tasks/manual-test-required.yml" <<'EOF'
version: 4
name: Manual test required input
inputs:
  ticket:
    type: string
    required: true
run: echo "ticket=$AKM_TASK_INPUTS"
EOF
```

**Commands and expected results (both verified live):**
1. `akm task explain manual-test-required --format json` → exit `0`,
   `.suppliedInputs == {}` (no error — `ticket` is simply absent).
2. `akm task run manual-test-required` → exit `2`:
   ```json
   {"ok":false,"error":"Task input flags do not satisfy the task's declared input schemas:\n  - inputs.ticket: is required","code":"INPUT_BINDING_INVALID"}
   ```

**Cleanup:** `rm "$AKM_BUNDLE_DIR/tasks/manual-test-required.yml"`.

### TASK-5 — Undeclared input flag is rejected

**Why it matters:** typo-tolerance — a fat-fingered flag name should get a
clear rejection, not a silent no-op.

**Preconditions:** `manual-test-echo.yml` from TASK-1.

**Command:** `akm task explain manual-test-echo --bogus x`

**Expected result (verified live, exact):** exit `2`:
```json
{"ok":false,"error":"Unknown task input \"--bogus\". Input flags must exactly match a declared task input.","code":"UNKNOWN_FLAG","hint":"Declared inputs: --loud, --who."}
```

### TASK-6 — Declaring an input that collides with a reserved `task run` flag

**Why it matters:** guards against a task input silently shadowing a
built-in flag (e.g. `bundle`, `format`); the docs say this is rejected at
parse time.

**Setup:**
```sh
cat > "$AKM_BUNDLE_DIR/tasks/manual-test-reserved.yml" <<'EOF'
version: 4
name: Manual test reserved flag collision
inputs:
  bundle:
    type: string
    default: x
run: echo hi
EOF
```

**Command:** `akm task explain manual-test-reserved`

**Expected result (verified live, exact):** exit `2`, `.code ==
"TASK_SOURCE_INVALID"`, error text is `Invalid task source v4 at
<path>:5: inputs.bundle collides with akm task run's own --bundle flag;
declare the input under a different name.`

**Cleanup:** `rm "$AKM_BUNDLE_DIR/tasks/manual-test-reserved.yml"`.

### TASK-7 — Secret-shaped input default is redacted in `explain`

**Why it matters:** `explain` is documented as secret-free — a
security-conscious user needs to trust this before pasting `explain` output
into a bug report or chat.

**Setup:**
```sh
cat > "$AKM_BUNDLE_DIR/tasks/manual-test-secret.yml" <<'EOF'
version: 4
name: Manual test secret redaction
inputs:
  api_token:
    type: string
    default: "sk-abcdef123456"
run: echo "token=$AKM_TASK_INPUTS"
EOF
```

**Command:** `akm task explain manual-test-secret`

**Expected result (verified live):** exit `0`; the literal value
`sk-abcdef123456` does **not** appear anywhere in stdout;
`.inputDeclarations.api_token.default == "<redacted>"` and
`.redacted == true`; `.suppliedInputs.api_token.value == "<redacted>"` and
`.redacted == true`. (A heuristic warning about the secret-suggesting name
is also printed on stderr — expected, not a failure.)

Verify outside akm: `grep -c sk-abcdef123456 <(akm task explain manual-test-secret)` must print `0`.

**Cleanup:** `rm "$AKM_BUNDLE_DIR/tasks/manual-test-secret.yml"`.

### TASK-8 — Schedule-binding provenance is distinct from manual-run provenance

**Why it matters:** exercises the third provenance value
(`schedule-binding`) and the fact that a schedule entry's own literal
inputs are shown per-entry, not merged into top-level `suppliedInputs`.

**Setup:**
```sh
cat > "$AKM_BUNDLE_DIR/tasks/manual-test-schedbind.yml" <<'EOF'
version: 4
name: Manual test schedule-binding provenance
inputs:
  scope:
    type: string
    enum: [changed, all]
    default: changed
run: echo "scope=$AKM_TASK_INPUTS"
schedule:
  - cron: "0 8 * * 1"
    enabled: true
    inputs: { scope: all }
EOF
```

**Command:** `akm task explain manual-test-schedbind`

**Expected result (verified live, exact):** exit `0`;
`.suppliedInputs.scope == {"value":"changed","provenance":"default"}`
(reflecting the bare call);
`.schedule[0].inputs.scope == {"value":"all","provenance":"schedule-binding"}`;
`.schedule[0].source == "schedule[0].cron"`.

Then `akm task run manual-test-schedbind --scheduled --scope all` → exit `0`
(the exact invocation tail `sync` would compile for this binding).

**Cleanup:** `rm "$AKM_BUNDLE_DIR/tasks/manual-test-schedbind.yml"`.

### TASK-9 — Required input with no default bricks the whole schedule entry at parse time

**Why it matters:** the sharpest footgun in typed inputs. Adding a
`required: true` input to an already-scheduled task, without also giving
the schedule entry a literal value, doesn't fail narrowly — **the whole task
file fails to parse**, for `explain`, `run`, even with the flag supplied
manually.

**Setup:**
```sh
cat > "$AKM_BUNDLE_DIR/tasks/manual-test-badsched.yml" <<'EOF'
version: 4
name: Manual test bad schedule required input
inputs:
  ticket:
    type: string
    required: true
run: echo "ticket=$AKM_TASK_INPUTS"
schedule: "0 8 * * 1"
EOF
```

**Commands and expected (both verified live, identical failure):**
1. `akm task explain manual-test-badsched`
2. `akm task run manual-test-badsched --ticket OPS-1` (supplying the flag
   does **not** help)

Both: exit `2`, `.code == "TASK_SOURCE_INVALID"`, error text is `Invalid
task source v4 at <path>:8: schedule does not satisfy the task's declared
inputs once defaults are applied: inputs.ticket: is required. A scheduled
run supplies no input flags — give this schedule entry an inputs: value for
each input named above, or declare a default: on the input instead (a
required: true input may not carry one).`

**Cleanup:** `rm "$AKM_BUNDLE_DIR/tasks/manual-test-badsched.yml"`.

### TASK-10 — `run` happy path, and inputs are validated then discarded for non-workflow targets

**Why it matters:** for `run:`/`scripts/`/`commands/` targets, input values
are validated then **discarded** — they do not reach `AKM_TASK_INPUTS` or
the process environment. A user expecting `--who Bob` to show up in a shell
script via `$AKM_TASK_INPUTS` will be surprised.

**Preconditions:** `manual-test-echo.yml` from TASK-1.

**Command:** `akm task run manual-test-echo --who Bob --format json`

**Expected result (verified live):** exit `0`; `.result.status ==
"completed"`, `.result.detail.exitCode == 0`; `.result.log` names a file
under `$AKM_CACHE_DIR/tasks/logs/manual-test-echo/`.

Verify outside akm: `cat "$(akm task run manual-test-echo --who Bob --format json | jq -r .result.log)"`
prints `hello ` — literally empty after "hello ", **not** "hello Bob". This
is the falsifiable proof that `--who Bob` was validated and discarded, not
delivered.

### TASK-11 — `history` reflects a real run

**Why it matters:** `history` is the only place a user reviews what
happened after the fact (e.g. debugging a failed scheduled run days later)
— it must agree with what `run` itself reported.

**Preconditions:** run TASK-10 first so at least one history row exists.

**Commands:** `akm task history --format json` and `akm task history --id
manual-test-echo --format json`

**Expected result (verified live):** exit `0` both; `.rows[0].id ==
"manual-test-echo"`, `.rows[0].status == "completed"`,
`.rows[0].detail.exitCode == 0`, `.rows[0].log` matches TASK-10's log path
exactly.

Also: `akm task history --id does-not-exist` → exit `0`, `.rows == []`
(empty result, not an error).

### TASK-12 — `run` on a nonexistent task id

**Why it matters:** distinguishes "usage error" (exit 2) from "resource not
found" (exit 1) — a real difference for scripts/CI wrapping `akm task run`.

**Command:** `akm task run nonexistent-task-xyz`

**Expected result (verified live, exact):** exit `1` (not 2);
```json
{"ok":false,"error":"Task \"nonexistent-task-xyz\" was not found in the configured \"akm\" component.","code":"ASSET_NOT_FOUND","hint":"Run `akm search <query>` or `akm index` to refresh the index."}
```

### TASK-13 — A pre-v4 stored task is unusable, and the error names the fix

**Why it matters:** the headline real-user-impact change in alpha.5.
Anyone upgrading from an older akm with existing task files hits this on
the very next `run`/`sync`.

**Setup** (uses the project's own v2 fixture; v3 behaves identically with a
different version number in the message):
```sh
cp /home/founder3/code/github/itlackey/akm/tests/fixtures/manual-qa/bundle/tasks/manual-success.yml \
   "$AKM_BUNDLE_DIR/tasks/manual-success.yml"
```

**Commands:** `akm task run manual-success` and `akm task explain
manual-success`

**Expected result (verified live, exact, both commands identical):** exit
`2`;
```json
{"ok":false,"error":"TASK_SCHEMA_VERSION_UNSUPPORTED: Task at <path> uses task schema version 2, which this release does not accept.","code":"TASK_SCHEMA_VERSION_UNSUPPORTED","hint":"Run `akm migrate apply --dry-run` to preview the task-v3 to task-source-v4 conversion, then run `akm migrate apply`."}
```
The hint says "task-v3 to task-source-v4" even for a v2 file — that's the
shipped wording (the v2→v3→v4 chain is one hint), not a bug.

**Cleanup:** `rm "$AKM_BUNDLE_DIR/tasks/manual-success.yml"`.

### TASK-14 — v3→v4 migration end to end: status, dry-run, apply, backup, and post-migration runnability

**Why it matters:** TASK-13 shows the wall a real user hits; this shows
whether `akm migrate` actually gets them through it. The most important
test in this document for real upgrade risk.

**Setup — this test needs the bundle registered as a source**
(`migrate status`/`apply` scan registered bundle *sources*, not just
`AKM_BUNDLE_DIR`'s contents — a hand-written `config.json` is NOT enough
here, unlike every other test in this document):
```sh
akm setup --config '{"semanticSearchMode":"off","registries":[]}' \
  --dir "$AKM_BUNDLE_DIR" --no-init --format json
# NOTE: the scratch/tmp path triggers a "transient directory" refusal in
# `akm setup` — set AKM_FORCE_SETUP_TMP_STASH=1 first (expected, not a bug).

cat > "$AKM_BUNDLE_DIR/tasks/manual-test-v3.yml" <<'EOF'
version: 3
name: v3 fixture for migration test
run: echo "v3 task"
akm:
  schedule: "0 6 * * *"
EOF
```

**Commands and expected results (all verified live):**
1. `akm migrate status --format json` → exit `0`;
   `.taskV4Migration.files[0].status == "changed"`,
   `.reason == "task-converted"`.
2. `akm migrate apply --dry-run --format json` → exit `0`; identical
   `status`/`reason` fields; the file on disk is byte-identical to before —
   verify with `diff` against the pre-dry-run content.
3. `akm migrate apply --format json` → exit `0`; JSON includes
   `.taskV4Applied == 1` and a `.taskV4BackupPath` under
   `$AKM_DATA_DIR/backups/task-v4/<timestamp>-<uuid>/`.
4. Verify outside akm: `cat "$AKM_BUNDLE_DIR/tasks/manual-test-v3.yml"` now
   shows `version: 4` with the `akm.schedule` value hoisted to a top-level
   `schedule: 0 6 * * *` key; the backup path holds the original v3 bytes.
5. `akm task explain manual-test-v3 --format json` → exit `0`,
   `.sourceVersion == 4`, `.schedule[0].cron == "0 6 * * *"` — the task is
   now actually runnable, closing the loop from TASK-13.

**Cleanup:** `rm -f "$AKM_BUNDLE_DIR/tasks/manual-test-v3.yml"`.

### TASK-15 — `doctor` on this platform

**Why it matters:** `doctor` is the first-stop diagnostic a user runs when
scheduling seems broken; its reported backend/paths must match reality.

**Command:** `akm task doctor --format json`

**Expected result (verified live on Linux/cron):** exit `0`;
`.backend == "cron"`; `.logDir`/`.historyDir` are under
`$AKM_CACHE_DIR/tasks/...` (cache-dir isolation applies to logs/history
even though the scheduler itself isn't isolated); `.akm.eligible == false`
and `.akm.kind == "checkout"` when run via `bun src/cli.ts` (a repo checkout
is never scheduler-eligible — see TASK-16); `.remediation == "akm task sync
--rebind"` is present whenever any bindings are ineligible.

Verify outside akm: cross-check `.bindings[].taskIds` against `crontab -l |
grep -oP '(?<=# akm:task )\S+(?= BEGIN)'` — the two lists should match
(read-only both sides).

**`UNVERIFIED`: the exact `doctor` output shape on macOS (`launchd`) and
Windows (`schtasks`) backends — only Linux/cron was exercised live for this
document.** Platform-gated: run the macOS/Windows equivalent on those OSes;
expect `.backend` to read `"launchd"` or `"schtasks"` respectively (inferred
from source naming, not observed).

### TASK-16 — Ineligible-invocation guard fires before any scheduler write

**Why it matters:** the one `add`/`sync`-adjacent test that's genuinely safe
on a real machine, because it fails *before* touching the scheduler.

**Preconditions:** run from a **repo checkout** (`bun src/cli.ts`), not an
npm-global/standalone install — those are scheduler-eligible and this test
would not short-circuit the same way (see [DT-1](#dt-1--task-add-happy-path-installs-a-real-cron-entry-linux-cron)
instead).

**Command:** `akm task sync` in the common sandbox, with
`manual-test-echo.yml` (a `schedule:`-bearing task) present.

**Expected result:** exit `2`, `.code == "INVALID_FLAG_VALUE"`, error text
`Refusing to reconcile native scheduler bindings from an ineligible
checkout invocation (<argv...>).` (Source:
`src/commands/tasks/tasks.ts`, `resolveAndValidateSchedulerInvocation`.)

**Historical note:** the alpha.5 live run encountered #846's unrelated-entry
fingerprint guard before this invocation guard. Stable 0.9.2's owner-path
scoping prevents that cross-bundle detour, so the expected result above is the
one this test now requires. Its exact wording remains **UNVERIFIED live** in
this manual suite, although the guard has automated coverage.

Verify outside akm: `crontab -l` (or platform equivalent) is byte-identical
before and after.

---

## Workflows

Scope: `akm workflow status|list|create|resume|abandon|run|plan`. Every
fixture below uses `unit: { exec: { command: [...] } }` shell steps — no
engine/LLM credentials are needed except WF-6, which needs an engine
*configured* (not reachable) to force a deterministic judge-infrastructure
failure.

### WF-1 — Author and run an exec workflow end to end

**Why it matters:** the single most common real workflow — create a
document, wire up steps, run it — must work with zero ceremony.

**Setup:**
```sh
akm workflow create demo --format json
```
**Expected:** exit `0`, JSON `{"ok": true, "ref": "bundle//workflows/demo",
"path": ".../bundle/workflows/demo.md", "bundleDir": "<AKM_SANDBOX>/bundle",
"shape": "workflow-create", "schemaVersion": 1}`. Note the field is
**`bundleDir`**, not `stashDir` (renamed this release — a script still
reading `stashDir` here gets `undefined`).

Overwrite `$AKM_BUNDLE_DIR/workflows/demo.md` (the default template needs a
judge engine — see WF-2):
```markdown
---
type: workflow
description: Exec-only smoke test workflow (no engine required)
updated: 2026-01-01
tags: [example]
steps:
  - id: first-step
    unit:
      exec:
        command: ["bash", "-lc", "echo hello-first"]
  - id: second-step
    inputs: [steps.first-step.output]
    unit:
      exec:
        command: ["bash", "-lc", "echo hello-second"]
---

# Demo Workflow

## first-step

Print a greeting.

## second-step

Print a second greeting, using the first step's artifact as context.
```

**Command:** `akm workflow run workflows/demo --format json`

**Expected result (verified live):** exit `0`; `.run.status ==
"completed"`; `.run.currentStepId == null`; `.stepsProcessed == 2`,
`.done == true`; `.executed[0].stepId == "first-step"`,
`.executed[0].ok == true`; same shape for `"second-step"`. Two advisory
warnings about missing `output:` schemas print on stderr — non-fatal,
stdout remains valid JSON.

Then `akm workflow status <run-id> --format json`: `.workflow.steps[0]
.evidence.output == "hello-first"`; `.workflow.steps[1].evidence.output ==
"hello-second"`.

**Cleanup:** `rm -rf "$AKM_SANDBOX"` (or reuse for WF-4/WF-7/WF-8, which
reference this fixture).

### WF-2 — Default `create` template needs a judge engine (first-run trap)

**Why it matters:** `akm workflow create <name>` scaffolds a template whose
second step ships with a non-empty `### gate` rubric by default. A
brand-new user who runs `create` then immediately `plan`s/`run`s without
configuring anything hits an opaque-looking failure.

**Preconditions:** fresh sandbox, no `engines`/`workflow.judgeEngine` in
config.json.

**Commands:**
```sh
akm workflow create raw --format json
akm workflow plan workflows/raw --format json
```

**Expected result (verified live, exact):** `create` exits `0`. `plan`
(untouched template) **fails**: exit **`78`**;
```json
{"ok": false, "error": "This workflow declares completion criteria but no verification engine is configured. Set workflow.judgeEngine to a named LLM or agent engine.", "code": "INVALID_CONFIG_FILE"}
```
Note the message says *what* to set but not *where* (`config.json`) or what
a valid value looks like — a real gap for a scaffolded template's
out-of-the-box failure, worth flagging in review even though it's not
incorrect.

### WF-3 — Child workflow: `plan` shows expansion, `run` executes it

**Why it matters:** child workflows are the headline capability of this
release. A parent step composing another workflow must show up correctly in
the frozen plan graph before anything runs, and actually drive the child to
completion, folding its exported output back into the parent step's
artifact.

**Setup:**

`$AKM_BUNDLE_DIR/workflows/child.md`:
```markdown
---
type: workflow
description: Child workflow composed by parent.yml (exec-only, no engine required)
updated: 2026-01-01
tags: [example]
params:
  greeting: { type: string, description: Greeting text bound from the parent step }
steps:
  - id: greet
    unit:
      exec:
        command: ["bash", "-lc", "echo child-said-hello"]
outputs:
  message:
    from: steps.greet.output
---

# Child Workflow

## greet

Print a fixed greeting.
```

`$AKM_BUNDLE_DIR/workflows/parent.yml` (composition requires a
GitHub-shaped `.yml` parent — Markdown frontmatter has no `uses:` key):
```yaml
name: Parent composes child
on:
  workflow_dispatch: {}
jobs:
  main:
    runs-on: [self-hosted]
    steps:
      - id: dispatch
        uses: workflows/child
        with:
          greeting: hello-from-parent
```

**Part A — `plan` (no writes, no execution):** `akm workflow plan
workflows/parent --format json`

**Expected result (verified live):** exit `0`; `.steps[0].targetKind ==
"child-workflow"`; `.steps[0].inputBindings == [{"name": "greeting", "kind":
"literal", "value": "hello-from-parent"}]`; `.steps[0].expansion.via ==
"child"`, `.expansion.childRef == "bundle//workflows/child"`,
`.expansion.childVia == "direct"`, `.expansion.childOutputs ==
["message"]`; `.steps[0].expansion.steps` contains the child's own frozen
graph (one entry, `stepId: "greet"`, `targetKind: "shell"`);
`.sourceReadSet` contains both `"workflows/child.md"` and
`"workflows/parent.yml"`.

**Part B — `run` (actually executes):** `akm workflow run workflows/parent
--format json`, then `akm workflow status <run-id> --format json`

**Expected result (verified live):** `run` exits `0`, `.run.status ==
"completed"`; `status`'s `.workflow.steps[0].evidence.output == {"message":
"child-said-hello"}` — the child's declared `outputs:` export, promoted as
the parent step's own artifact; `status` has a top-level **`.children`**
array (not nested under `.workflow`): one entry, `status: "completed"`,
`workflowRef: "bundle//workflows/child"`, `spawnedByUnitId:
"dispatch:solo"`, `stepId: "dispatch"`.

**Part C — list visibility:** `akm workflow list --format json` (count N),
then `akm workflow list --children --format json` (count N+1).

**Expected:** the second count is exactly one more — the child run is
hidden from the default `list` and appears only with `--children`.

**Cleanup:** `rm -rf "$AKM_SANDBOX"`.

### WF-4 — `plan` makes zero durable writes

**Why it matters:** `plan` is documented as making zero durable writes. If a
future change accidentally makes it write a run row, it would silently
pollute `list`/state for every user who reviews a workflow before running
it — a very common habit.

**Preconditions:** fresh sandbox; reuse `demo.md` from WF-1.

**Commands:**
```sh
akm workflow list --format json                                          # baseline
sqlite3 "$AKM_DATA_DIR/state.db" "select count(*) from workflow_runs;"   # expect 0
akm workflow plan workflows/demo --format json
sqlite3 "$AKM_DATA_DIR/state.db" "select count(*) from workflow_runs;"   # must still be 0
akm workflow list --format json                                          # must still be []
```

**Expected result (verified live):** `plan` exits `0`, `.ok == true`,
`.published == false`. `select count(*)` is `0` both before and after.
`workflow list` after `plan` is byte-identical to before: `{"runs": [],
"shape": "workflow-list", "schemaVersion": 1}`.

`sqlite3` is required for the row-count check; the `list` before/after diff
alone is sufficient if unavailable.

### WF-5 — A failing step surfaces a clear diagnostic

**Why it matters:** most real workflow authoring involves a step failing.
The failure needs to be loud, specific, and land in a stable place
(`status`), not just flash by in `run`'s stdout.

**Setup:**

`$AKM_BUNDLE_DIR/workflows/fails.md`:
```markdown
---
type: workflow
description: Exec-only workflow whose second step always fails (no engine required)
updated: 2026-01-01
tags: [example]
steps:
  - id: ok-step
    unit:
      exec:
        command: ["bash", "-lc", "echo ok"]
  - id: fail-step
    inputs: [steps.ok-step.output]
    unit:
      exec:
        command: ["bash", "-lc", "echo boom 1>&2; exit 1"]
---

# Fails Workflow

## ok-step

Print ok.

## fail-step

Always exits 1.
```

**Command:** `akm workflow run workflows/fails --format json`

**Expected result (verified live, exact):** exit **`1`** (not 0, not 2 — a
run-outcome failure, distinct from a usage error); `.run.status ==
"failed"`, `.run.currentStepId == "fail-step"`; `.executed[1].ok == false`,
`.executed[1].failedUnits == 1`; `.executed[1].summary` contains the exact
substring `fail-step:solo (non_zero_exit)` and the captured stderr text
`boom`.

Then `akm workflow status <run-id> --units --format json`:
`.workflow.steps[1].status == "failed"`;
`.workflow.steps[1].evidence.units[0].failureReason == "non_zero_exit"`.

### WF-6 — Blocked run: both direct `resume` and `abandon` → `resume` work (#847 regression)

**Why it matters:** `akm workflow abandon --help` promises "mark it failed
so it stops counting as active (resume can reopen it)". Alpha.5 violated that
promise for a run blocked by a judge-infrastructure failure: abandon left the
step blocked, and resume rejected that honest failed-run spine as corrupt.
Stable 0.9.2 accepts the three legitimate failed-run current-step states and
normalizes each back to pending on resume. This test keeps the exact #847
reproduction as a regression.

**How "blocked" is produced without any real LLM/API key:** a workflow with
a non-empty `### gate` requires `workflow.judgeEngine` to be *configured*
(present in `config.json`) before it can freeze — nothing requires it to be
*reachable*. Pointing it at a closed local port makes every gate evaluation
throw a network error, which is a judge-infrastructure failure (not a
verdict), and that path blocks the step. No credentials, no network,
reproduces every time.

**Setup:**
```sh
cat > "$AKM_CONFIG_DIR/config.json" <<'EOF'
{
  "configVersion": "0.9.0",
  "semanticSearchMode": "off",
  "registries": [],
  "engines": {
    "unreachable": { "kind": "llm", "endpoint": "http://127.0.0.1:1/v1/chat/completions", "model": "does-not-matter" }
  },
  "workflow": { "judgeEngine": "unreachable" }
}
EOF
```

`$AKM_BUNDLE_DIR/workflows/gated.md`:
```markdown
---
type: workflow
description: Exec step with a gate rubric, judged by an unreachable engine (simulates judge-infrastructure failure -> blocked)
updated: 2026-01-01
tags: [example]
steps:
  - id: produce
    unit:
      exec:
        command: ["bash", "-lc", "echo produced"]
    gate: { max_loops: 1 }
---

# Gated Workflow

## produce

Print the word "produced".

### gate

- The artifact is exactly "produced".
```

**Part A — plain resume works (contrast case):**
```sh
akm workflow run workflows/gated --format json --timeout 30s
```
**Expected (verified live):** exit `1`; `.run.status == "blocked"`;
`.workflow.steps[0].notes` contains `could not be verified: the
verification judge failed (Network error:` and names the exact resume
command.

```sh
akm workflow resume <run-id> --format json
```
**Expected (verified live):** exit `0`; `.run.status` becomes `"active"`;
`.workflow.steps[0].status` becomes `"pending"` (evidence cleared — the
next `run` re-evaluates the gate, not the exec unit).

**Part B — abandon then resume.** Start a **fresh** run (do not
reuse Part A's run — re-running against the ref resumes the existing active
run rather than starting a new one; see the note at the end of this test):
```sh
akm workflow run workflows/gated --format json --timeout 30s   # capture the NEW run id
akm workflow abandon <run-id> --format json
akm workflow resume <run-id> --format json
```

**Expected result (stable regression, automated):**
- `abandon` succeeds, exit `0`. `.run.status` becomes `"failed"`; the current
  step honestly remains `"blocked"` until a resume is requested.
- `resume` succeeds, exit `0`. `.run.status` becomes `"active"` and
  `.workflow.steps[0].status` becomes `"pending"`, with the blocked notes and
  evidence cleared so the gate can be evaluated again.
- No corrupt-spine error is emitted. A subsequent `run <run-id>` re-enters
  the current step normally.

**Note on `run <ref>` semantics:** `akm workflow run workflows/<name>` does
not always start a brand-new run — if an **active** run already exists for
that ref in the current scope, it resumes that run instead, consistent with
`run --help` ("Start **or resume** a workflow...") but easy to miss.

**Cleanup:** `rm -rf "$AKM_SANDBOX"`.

### WF-7 — Active (paused) run → `abandon` → `resume` round-trips cleanly (companion to WF-6)

**Why it matters:** pins the other legitimate abandoned-run spine: an active
run leaves its current step pending, while WF-6 leaves it blocked. Resume must
normalize both without weakening corruption detection for impossible shapes.
This is a deliberate contrast pair with WF-6, not a duplicate — keep both.

**Preconditions:** fresh sandbox, no `engines` config needed. Use `demo.md`
from WF-1.

**Commands:**
```sh
akm workflow run workflows/demo --max-steps=1 --format json
# capture run id; .run.status is "active", .run.currentStepId "second-step"
akm workflow abandon <run-id> --format json
akm workflow resume <run-id> --format json
```

**Expected result (verified live):**
- After `run --max-steps=1`: `.run.status == "active"`,
  `.workflow.steps[0].status == "completed"`,
  `.workflow.steps[1].status == "pending"`.
- `abandon` succeeds, exit `0`, `.run.status` becomes `"failed"`,
  `.workflow.steps[1].status` **stays `"pending"`** — this is the case that
  does *not* produce the WF-6 bug, because the step status already agrees
  with the run's new status.
- `resume` succeeds, exit **`0`**, `.run.status` becomes `"active"` again,
  `.workflow.steps[1].status` stays `"pending"`. No corrupt-spine error.

### WF-8 — Scope semantics: `list` is cwd-scoped by default; `--all-scopes`
and the cross-scope start warning (#942)

**Why it matters:** `list`/`status --help` say refs/runs "resolve within
the current scope" — easy to read past. A user who runs a workflow from one
directory, `cd`s elsewhere, then runs `akm workflow list` and sees
`{"runs": []}` could plausibly conclude the run vanished — this is exactly
what happened in production: a scheduled task's cwd (`$HOME`) and a human
shell's cwd hashed to different scope keys, each `akm workflow run`
independently believed no run was active, and each started one. Scope is
still the **working directory**, hashed into `scopeKey` — not the bundle,
not the config dir — but the envelope now says which scope it searched, and
`--all-scopes` can search every scope.

**Setup:** fresh sandbox at `$AKM_SANDBOX`, plus `mkdir -p
"$AKM_SANDBOX-elsewhere"`. Use `demo.md` from WF-1.

**Commands:**
```sh
cd "$AKM_SANDBOX"
akm workflow run workflows/demo --format json     # note RUNID
akm workflow list --format json                   # from $AKM_SANDBOX

cd "$AKM_SANDBOX-elsewhere"
akm workflow list --format json                   # same env vars, different cwd
akm workflow list --all-scopes --format json       # same env vars, different cwd
akm workflow status "$RUNID" --format json         # by id, from elsewhere
akm workflow run workflows/demo --format json      # same ref, from elsewhere
```

**Expected result (verified live):**
- `list` from `$AKM_SANDBOX` returns `.runs` length **1** and a top-level
  `.scopeKey` starting `"dir:v1:..."` — the scope it searched, which every
  returned run's own `.scopeKey` also matches.
- `list` from the elsewhere directory (identical `AKM_*` env vars, only
  `cwd` differs) returns **`{"runs": [], "scopeKey": "dir:v1:..."}`**
  (a *different* hash than the first call), exit `0` — not an error, and no
  longer indistinguishable from "nothing anywhere": the envelope names the
  scope that came up empty.
- `list --all-scopes` from the elsewhere directory returns `.runs` length
  **1** (the run started in `$AKM_SANDBOX`) and a top-level `.scopeKey` of
  **`null`** — "every scope" — while the run's own `.scopeKey` field still
  names where it actually started.
- `status $RUNID` from elsewhere **still succeeds** and returns the full
  run — status-by-id is not scope-filtered the way `list` is.
- `run workflows/demo` from elsewhere **starts a second, independent run**
  (the scope-local concurrency guard is unchanged — a deliberate
  per-project partition, see `storage-locations.md`) but its envelope now
  carries a `warnings[]` entry naming `$RUNID` and `$AKM_SANDBOX`'s scope
  key, with the same `akm workflow run <id>` / `akm workflow abandon <id>`
  remedy the same-scope guard already gives — so the operator sees the
  other run instead of two runs silently drifting.

### WF-9 — Migration: a pre-`irVersion`-5 stored plan is retired

**Why it matters:** every user upgrading from 0.9.1 or an early 0.9.2 alpha
with an in-flight workflow run hits this. Requires the `sqlite3` CLI (or any
SQLite client) to hand-edit one column of one row.

**Setup:**

`$AKM_BUNDLE_DIR/workflows/retiring.md`:
```markdown
---
type: workflow
description: Exec-only two-step workflow used for the pre-irVersion-5 retirement test
updated: 2026-01-01
tags: [example]
steps:
  - id: first-step
    unit:
      exec:
        command: ["bash", "-lc", "echo hello-first"]
  - id: second-step
    inputs: [steps.first-step.output]
    unit:
      exec:
        command: ["bash", "-lc", "echo hello-second"]
---

# Retiring Workflow

## first-step

Print a greeting.

## second-step

Print a second greeting.
```

**Commands:**
```sh
OUT=$(akm workflow run workflows/retiring --max-steps=1 --format json)
RUNID=$(echo "$OUT" | python3 -c "import json,sys; print(json.load(sys.stdin)['run']['id'])")
sqlite3 "$AKM_DATA_DIR/state.db" "UPDATE workflow_runs SET plan_ir_version = 4 WHERE id = '$RUNID';"
akm workflow status "$RUNID" --format json     # read-only surfaces must still work
akm workflow resume "$RUNID" --format json     # execution surfaces must fail closed
akm workflow abandon "$RUNID" --format json    # abandon must still work
```

**Expected result (verified live, every line confirmed):**
- Before tampering: `.run.status == "active"`.
- After tampering, `status` reports `.run.planIrVersion == 4`,
  `.run.executionSupport == "unsupported-version"`, `.run.status`
  unchanged (`"active"`) — reading the run does not itself fail.
- `resume` fails, exit **`2`**:
  ```json
  {"ok": false, "error": "Workflow run <RUNID> was frozen as workflow plan irVersion 4; pre-irVersion-5 plans cannot execute after the 0.9.2 upgrade. Complete them before upgrading, or run 'akm workflow abandon <RUNID>' and start a new run from the authored workflow. 'akm workflow status' and 'akm workflow list' still work on this run.", "code": "WORKFLOW_IR_VERSION_UNSUPPORTED", "hint": "Abandon the run with `akm workflow abandon <id>`, then start it again from the workflow source — a frozen plan this akm cannot execute is not re-executable in place."}
  ```
  This message names the run id twice, the exact `abandon` command, and
  states the only path forward — the strongest error message found across
  this whole document; treat it as the bar WF-6's corrupt-spine error and
  WF-10's `inherit_env` rejection should be held to.
- `abandon` **succeeds**, exit `0`, `.run.status` becomes `"failed"` —
  unlike WF-6's blocked-abandon case, this does not corrupt the step spine
  (the step here is `"pending"`, a status abandon's `"failed"` reconciles
  with cleanly).

### WF-10 — Migration: removed `inherit_env` is rejected

**Why it matters:** `inherit_env: true` was breaking-removed in
`0.9.2-alpha.1` in favor of `exec.pass_env`. Anyone porting an older
exec-unit workflow forward will paste this key in and needs an unambiguous
signal.

**Setup:**

`$AKM_BUNDLE_DIR/workflows/inherit-env.md`:
```markdown
---
type: workflow
description: Exec step authored with the removed inherit_env option
updated: 2026-01-01
tags: [example]
steps:
  - id: step1
    unit:
      exec:
        command: ["bash", "-lc", "echo hi"]
        inherit_env: true
---

# Inherit Env Workflow

## step1

Print hi; this step's exec unit illegally authors `inherit_env: true`.
```

**Commands:** `akm workflow plan workflows/inherit-env --format json` and
`akm workflow run workflows/inherit-env --format json`

**Expected result (verified live, identical for both):** exit **`2`**;
```json
{"ok": false, "error": "Workflow source has 1 error(s):\n  <path>/workflows/inherit-env.md:11 — Unknown Step \"step1\" \"exec\" key \"inherit_env\". Allowed keys: command, cwd, pass_env.", "code": "WORKFLOW_SOURCE_INVALID", "hint": "Run `akm lint` to see the failing source location, or `akm workflow plan <ref>` to compile it without writing."}
```
This is a generic "unknown field" rejection, not a dedicated migration
message — it lists `pass_env` among allowed keys (a usable hint for someone
who already knows the replacement) but never says "`inherit_env` was
removed" or points at
[`docs/migration/v0.9.1-to-v0.9.2.md#workflow-cutover`](../../migration/v0.9.1-to-v0.9.2.md#workflow-cutover).
Compare against WF-9's message, which names the concept, reason, and exact
fix — worth a documentation-quality discussion, not necessarily a blocking
bug.

**Positive control:** replace `inherit_env: true` with `pass_env: [PATH]`
in the same fixture and re-run `plan`. Expected (verified live): `.ok ==
true`, and the frozen step's `.environment` array gains `{"kind":
"pass-through", "name": "PATH"}`.

---

## Integration (task ↔ workflow seam)

Scope: only scenarios where `akm task` and `akm workflow` genuinely meet —
a task whose target is a workflow, a workflow step that targets a task, and
the shared identity/failure machinery. The destructive `task sync` seam
tests (a workflow-targeting task's schedule, and the #846 cross-bundle
regression) are in [Destructive & platform-gated](#destructive--platform-gated-tests).

### INT-1 — A task that runs a workflow (the headline case)

**Why it matters:** `akm task` is documented as scheduling "recurring
commands, prompts, and workflows" — a task whose target IS a workflow is
the one thing that makes `task` and `workflow` the same feature area
instead of two unrelated CLIs.

**Destructive:** No — uses `task run` directly (verified to make zero
scheduler writes).

**Setup:**
```sh
cat > "$AKM_BUNDLE_DIR/workflows/leaf.yml" <<'EOF'
name: Manual test leaf workflow
on:
  workflow_dispatch:
jobs:
  main:
    runs-on: [self-hosted]
    steps:
      - id: work
        run: printf leaf-ok
EOF

cat > "$AKM_BUNDLE_DIR/tasks/akm-manual-test-wf-task.yml" <<'EOF'
version: 4
name: Manual test task -> workflow
uses: workflows/leaf
schedule:
  - cron: "0 3 * * *"
    enabled: false
EOF
akm index
```

**Steps and expected results (all verified live):**
1. `akm task explain akm-manual-test-wf-task --format json` → exit `0`,
   `.target == {"kind":"workflow","ref":"workflows/leaf"}`.
2. `akm task run akm-manual-test-wf-task --format json` (record
   `.result.detail.runId`) → exit `0`, `.ok == true`, `.result.status ==
   "completed"`, `.result.target == {"kind":"workflow","ref":"bundle//workflows/leaf"}`,
   `.result.detail.runId` is a UUID.
3. `akm workflow list --format json` → `.runs[]` contains an entry with
   `.id` equal to step 2's runId, `.workflowRef ==
   "bundle//workflows/leaf"`, `.status == "completed"`.
4. `akm workflow status <runId> --format json` → `.run.status ==
   "completed"`, `.workflow.steps[0].id == "work"`, `.status ==
   "completed"`, `.evidence.output == "leaf-ok"`.
5. `akm task history --id akm-manual-test-wf-task --format json` →
   `.rows[0].detail.runId` equals step 2's runId, `.rows[0].target.ref ==
   "bundle//workflows/leaf"`.

**Cross-check outside akm:** `crontab -l | grep -c akm-manual-test-wf-task`
before and after step 2 — both must print `0`. `task run` never touches the
OS scheduler.

**Cleanup:** `rm -rf "$AKM_SANDBOX"` (no scheduler entries were ever
created).

### INT-2 — A workflow step that targets a task (the inverse), including typed input binding

**Why it matters:** the reverse composition — the alpha.5
`FrozenChildWorkflowTarget`/task-bindings machinery. If a workflow step
`uses: tasks/<ref>` doesn't correctly expand at `plan` time, a published
workflow's step graph silently diverges from what actually runs.

**Destructive:** No — `workflow plan` performs zero durable writes.

**Setup:** reuses `workflows/leaf.yml` and
`tasks/akm-manual-test-wf-task.yml` from INT-1, plus:
```sh
cat > "$AKM_BUNDLE_DIR/workflows/task-wrapped.yml" <<'EOF'
name: Manual test workflow wrapping a task
on:
  workflow_dispatch:
jobs:
  main:
    runs-on: [self-hosted]
    steps:
      - id: dispatch
        uses: tasks/akm-manual-test-wf-task
EOF
akm index
```

**Steps and expected results:**
1. `akm workflow plan workflows/task-wrapped --format json` — expected
   (verified live): `.steps[0].stepId == "dispatch"`, `.targetKind ==
   "child-workflow"`, `.expansion.via == "child"`, `.expansion.childVia ==
   "task"`, `.expansion.childTaskRef ==
   "bundle//tasks/akm-manual-test-wf-task"`, `.expansion.childRef ==
   "bundle//workflows/leaf"`, `.expansion.steps[0].stepId == "work"` and
   `.targetKind == "shell"`; `.sourceReadSet` contains all three of
   `tasks/akm-manual-test-wf-task.yml`, `workflows/leaf.yml`,
   `workflows/task-wrapped.yml`; exit `0`.
2. `akm workflow run workflows/task-wrapped --format json` (this DOES
   publish a run — acceptable, scoped to isolated bundle/state dirs, not
   the OS scheduler), then `akm workflow status <runId> --format json`.
   **Expected result (verified live — this replaces an UNVERIFIED marker
   from an earlier draft of this test):** exit `0`, final `.run.status ==
   "completed"`. Because `leaf.yml` declares no `outputs:` block, the
   parent step's `.workflow.steps[0].evidence.output` is **not** the
   child's step output directly — it is a run pointer: `{"runId":
   "<child-run-uuid>", "status": "completed"}`. The full child summary
   lives in the top-level `.children[0]`: `{"runId": "<same uuid>",
   "workflowRef": "bundle//workflows/leaf", "status": "completed",
   "spawnedByUnitId": "dispatch:solo", "stepId": "dispatch", ...}` — same
   shape as WF-3's `.children` array. (Contrast with WF-3, where the child
   workflow *does* declare `outputs:`, and that gets promoted into the
   parent step's `evidence.output` instead of a bare run pointer.)

**Bonus check — typed input binding across the seam** (exercises the PR's
"fail-closed input bindings"):
```sh
cat > "$AKM_BUNDLE_DIR/tasks/akm-manual-test-typed-input-task.yml" <<'EOF'
version: 4
name: Manual test typed-input task (run target)
inputs:
  note:
    type: string
    required: true
run: printf "note=%s" "$AKM_TASK_INPUTS"
schedule:
  - cron: "0 3 * * *"
    enabled: false
    inputs:
      note: scheduled-default
EOF

cat > "$AKM_BUNDLE_DIR/workflows/wrap-typed-input-task.yml" <<'EOF'
name: Manual test workflow binding a literal input into a task step
on:
  workflow_dispatch:
jobs:
  main:
    runs-on: [self-hosted]
    steps:
      - id: dispatch
        uses: tasks/akm-manual-test-typed-input-task
        with:
          note: hello-seam
EOF
akm index
akm workflow plan workflows/wrap-typed-input-task --format json
```
**Expected (verified live):** `.steps[0].inputBindings == [{"name":"note","kind":"literal","value":"hello-seam"}]`.

Note: a **required** task input with no `default:` must be given a matching
`schedule[].inputs.<name>` entry or the task source is rejected outright
(`TASK_SOURCE_INVALID`) — a task-only rule, not part of the seam, but it
will trip up anyone building this fixture from scratch.

**Cleanup:** `rm -rf "$AKM_SANDBOX"`.

### INT-3 — Failure propagation: `task history` vs `workflow status`

**Why it matters:** operability. When a scheduled task's workflow fails at
3am, does the on-call person get the answer from `task history` (what a
cron failure notification points at), or must they already know to pivot to
`workflow status <runId>`?

**Destructive:** No (`task run` only).

**Setup:**
```sh
cat > "$AKM_BUNDLE_DIR/workflows/fail-leaf.yml" <<'EOF'
name: Manual test failing leaf workflow
on:
  workflow_dispatch:
jobs:
  main:
    runs-on: [self-hosted]
    steps:
      - id: boom
        run: exit 1
EOF

cat > "$AKM_BUNDLE_DIR/tasks/akm-manual-test-fail-task.yml" <<'EOF'
version: 4
name: Manual test task -> failing workflow
uses: workflows/fail-leaf
schedule:
  - cron: "0 3 * * *"
    enabled: false
EOF
akm index
```

**Steps and expected (verified live) results:**
1. `akm task run akm-manual-test-fail-task --format json` → exit **`1`**,
   `.ok == false`, `.result.status == "failed"`, `.result.target ==
   {"kind":"workflow","ref":"bundle//workflows/fail-leaf"}`.
   **`.result.detail` is exactly `{"runId": "<uuid>"}` — no `error`/`message`
   field at all.** (`run-workflow-task.ts` only attaches `detail.error` for
   a thrown error, gate rejection, or timeout — a workflow that reaches
   `status: "failed"` through ordinary step failure sets none of those.)
2. The task's own log file (path from step 1's `.result.log`) contains only:
   ```
   [akm task] task=akm-manual-test-fail-task kind=workflow ref=bundle//workflows/fail-leaf
   run_id=<uuid> status=failed
   workflow_title=fail-leaf
   ```
   No mention of which step failed or why.
3. `akm task history --id akm-manual-test-fail-task --format json` → same
   shape as step 1's `.result` — still no reason.
4. `akm workflow status <runId> --format json` → `.workflow.steps[0].notes`
   contains the actual reason: `Executed 1 unit(s) for step "boom" via
   workflow orchestration: 0 succeeded, 1 failed. Failures: boom:solo
   (non_zero_exit). First failure diagnostic (boom:solo): exec unit
   "boom:solo" ran "/usr/bin/sh" (2 arguments) and it exited 1`.

**Conclusion (falsifiable, and it falsifies the "should"):** a normal
workflow-side failure is legible ONLY from `workflow status`, never from
`task history`/the task log/the task's own JSON result. This is a real,
reproducible operability gap, not a hypothetical.

**Cleanup:** `rm -rf "$AKM_SANDBOX"`.

### INT-4 — Identity/ownership across the seam: abandon then re-invoke

**Why it matters:** if a task's scheduled invocation drives a workflow run
and a human intervenes with `workflow abandon` (e.g. because it's stuck),
the next scheduled firing must do something predictable.

**Destructive:** No (`task run`/`workflow abandon` only, isolated state DB).

**Setup:**
```sh
cat > "$AKM_BUNDLE_DIR/workflows/two-step.yml" <<'EOF'
name: Manual test two-step workflow
on:
  workflow_dispatch:
jobs:
  main:
    runs-on: [self-hosted]
    steps:
      - id: first
        run: printf step-one-ok
      - id: second
        run: printf step-two-ok
EOF

cat > "$AKM_BUNDLE_DIR/tasks/akm-manual-test-abandon-task.yml" <<'EOF'
version: 4
name: Manual test task -> two-step workflow (stops after 1 step)
uses: workflows/two-step
maxSteps: 1
schedule:
  - cron: "0 3 * * *"
    enabled: false
EOF
akm index
```
(`maxSteps: 1` lets a "scheduled" invocation stop mid-run, so there's
something to abandon.)

**Steps and expected results (all verified live):**
1. `akm task run akm-manual-test-abandon-task --format json` (first
   firing) → `.result.status == "active"`, exit `0` (a paused run is not a
   failure), `.result.detail.runId` = **runA**. `akm workflow status runA`
   confirms `.run.status == "active"`, step `"first"` is `"completed"`,
   `"second"` is `"pending"`.
2. `akm workflow abandon runA --format json` → exit `0`, `.run.status ==
   "failed"`.
3. `akm task run akm-manual-test-abandon-task --format json` (second
   firing, as if the scheduler fired it again) → **a brand-new run id,
   "runB" != "runA"**, `.result.detail.runId == runB`, `.result.status ==
   "active"` again. The task log shows step `"first"` executing again from
   scratch — it is not resuming runA's position.
4. `akm workflow list --format json` → both `runA` (`"failed"`) and `runB`
   (`"active"`) present as separate rows for the same `workflowRef`.

**Conclusion (falsifiable and confirmed):** the next scheduled invocation
starts fresh, never resumes and never errors — a direct consequence of
`getActiveRunRowForScope`'s SQL filter
(`src/storage/repositories/workflow-runs-repository.ts`) only ever
attaching to `status = 'active'` rows. One nuance: this auto-attach path is
also `AND parent_run_id IS NULL`, so it applies to a top-level run a *task*
starts (INT-1) but not to a run started as a **child** of a parent workflow
(INT-2) — a child run is only ever driven by its parent. Abandoning a child
run's semantics from the *task* side is **UNVERIFIED** — not exercised
here, plausibly a second interesting gap (a task can only ever directly own
a top-level run).

**Cleanup:** `rm -rf "$AKM_SANDBOX"`.

### INT-5 — The shipped `improve` tasks as a real-world case

**Why it matters:** `src/assets/tasks/improve/*.yml` are framed as "real
examples of tasks that drive akm's own workflows." Testing only synthetic
fixtures never catches a real schema drift between what `akm task add`
authors and what these shipped files contain.

**Finding that reshapes this test:** none of the five shipped
`src/assets/tasks/improve/*.yml` (or `src/assets/tasks/core/*.yml`) files
actually target an `akm workflow` asset. Every one is `run: akm <command>
...` — a shell target. Verified live for `akm-improve-catchup.yml`:
`.target == {"kind":"shell"}`. So the literal task→workflow seam (INT-1)
has **no shipped real-world example** as of alpha.5 — "workflow" in the
PR/brief is used in the English sense (the `improve` pipeline is a
multi-step process), not the `akm workflow` asset sense. The direction a
real shipped task asset DOES exercise unmodified is INT-2's shape — a
workflow step wrapping a real task via `uses: tasks/`.

**Destructive:** No (`workflow plan` only — zero durable writes).

**Setup:**
```sh
cp /home/founder3/code/github/itlackey/akm/src/assets/tasks/improve/akm-improve-catchup.yml \
   "$AKM_BUNDLE_DIR/tasks/akm-improve-catchup.yml"

cat > "$AKM_BUNDLE_DIR/workflows/wrap-real-improve-task.yml" <<'EOF'
name: Manual test workflow wrapping the real shipped improve-catchup task
on:
  workflow_dispatch:
jobs:
  main:
    runs-on: [self-hosted]
    steps:
      - id: dispatch
        uses: tasks/akm-improve-catchup
EOF
akm index
```

**Steps and expected results (verified live):**
1. `akm task explain akm-improve-catchup --format json` → exit `0`,
   `.target.kind == "shell"`, `.description == "Manual recovery —
   consolidation + triage drain (run on demand via \`akm task run
   akm-improve-catchup\`)"`, `.schedule[0] == {"ordinal":0,"cron":"0 4 * * *","enabled":false,"source":"schedule[0].cron","inputs":{}}`
   — the real shipped file installs disabled by default.
2. `akm workflow plan workflows/wrap-real-improve-task --format json` →
   `.steps[0].targetKind == "shell"`, `.steps[0].expansion ==
   {"via":"task","taskRef":"tasks/akm-improve-catchup"}`,
   `.sourceReadSet` contains `"tasks/akm-improve-catchup.yml"` — the real
   shipped file's bytes are part of this plan's frozen identity.

**Do not** `workflow run` this composed workflow, and do not `task run
akm-improve-catchup` directly — both would invoke the real `akm improve
--strategy catchup` pipeline against a live agent engine, which is slow,
may require credentials, and is out of scope for a seam test. `workflow
plan` already proves the seam without executing anything.

**Cleanup:** `rm -rf "$AKM_SANDBOX"`.

---

## Destructive & platform-gated tests

**Everything in this section writes to the real OS scheduler (cron /
launchd / schtasks). Re-read [Read this first](#read-this-first--the-one-safety-critical-finding)
before running any of it.** Mandatory for every test below:

1. Back up first: `crontab -l > ~/akm-crontab-backup-$(date +%s).txt` (or
   the platform equivalent). If this shows entries you don't recognize as
   your own throwaway fixtures, **stop** — you are not on a disposable
   scheduler.
2. Use an obviously-throwaway id/name (`akm-manual-test-<unix-timestamp>`
   or similarly namespaced) so a stray leftover is identifiable later.
3. Restore explicitly at the end: `crontab <backup-file>`, then verify with
   `crontab -l`.
4. **Never use `akm task sync` as a cleanup step** — it performs a broad
   reconcile, while cleanup should remove only the exact test fixture. DT-5
   separately proves #846's owner-path isolation. Clean up by hand.
5. Prefer a disposable OS account, VM, or container over a real machine.

`add` writes only its own binding (narrower blast radius); `sync` does a
full reconcile and can attempt to remove unrelated real entries.

### DT-1 — `task add` happy path installs a real scheduler entry [Linux: cron]

**Setup:** `export TID="akm-manual-test-$(date +%s)"`; back up crontab per
above.

**Command:**
```sh
akm task add "$TID" --schedule "@daily" --command "echo akm-manual-test" --bundle "$AKM_BUNDLE_DIR"
```
Note: from a repo checkout this still requires `--rebind` (see TASK-16) —
from an npm-global/standalone install it should succeed without it.

**`UNVERIFIED`: the exact success JSON shape.** This command was not
executed live in review of this document (the coding-agent sandbox's own
destructive-operation classifier refused all `task add` invocations —
itself corroborating evidence the command is correctly recognized as
touching the real system). Confirm on a disposable VM/container before
relying on the shape below.

**Expected:** exit `0`; a task YAML at `$AKM_BUNDLE_DIR/tasks/$TID.yml`
with `version: 4`.

**Verify OUTSIDE akm (mandatory — the whole point of the test):**
```sh
crontab -l | grep -A2 "# akm:task $TID BEGIN"
```
Expected format (pattern only, confirmed live against this machine's
existing real entries):
```
# akm:task <TID> BEGIN
<cron-expr> <absolute-node-or-bun-path> <absolute-akm-launcher> --scheduler-context <path> task run <TID> --scheduled >> <logDir>/<TID>.log 2>&1
# akm:task <TID> END
```
A disabled binding's line is prefixed `# akm:disabled ` instead of being a
live cron line.

**Cleanup (do NOT use `akm task sync`):**
```sh
crontab -l | sed "/# akm:task $TID BEGIN/,/# akm:task $TID END/d" | crontab -
rm -f "$AKM_BUNDLE_DIR/tasks/$TID.yml"
crontab -l | grep -c "$TID"   # must print 0
```

### DT-2 — `task add --disabled` writes a disabled binding [Linux: cron]

Same as DT-1 with `--disabled` added. Expected difference: the generated
task YAML has `schedule: [{cron: "@daily", enabled: false}]`; the crontab
line is written as `# akm:disabled ...`, matching real disabled entries
observed on this host. Verify and clean up identically to DT-1.
**UNVERIFIED for the same reason as DT-1.**

### DT-3 — `task sync` drift reconciliation, shell-target task [Linux: cron; VM/disposable-account strongly recommended]

**Why it matters:** the actual "scheduler and bundle disagree" scenario —
a high-risk mutation path that also exercises #846's owner-path scoping.

**Mandatory precondition:**
```sh
crontab -l > "$AKM_SANDBOX/crontab-backup-$(date +%Y%m%d-%H%M%S).txt" 2>&1
# If this shows real akm:task entries you don't recognize, STOP.
```

**Setup:** install a throwaway task via DT-1 (`$TID`), then edit its cron
schedule by hand in `crontab -e` (change the minute field) without touching
the YAML — manufacturing drift between the scheduler and the bundle.

**Command:** `akm task sync --bundle "$AKM_BUNDLE_DIR"`

**Expected:** `sync` detects the drifted binding and rewrites it to match
the YAML's declared schedule (the YAML is the source of truth). Exit `0`.
**`UNVERIFIED`: the exact JSON field name reporting "which entries
changed"** — not executed live in review of this document; inspect
`finalizeSchedulerSyncPlan`'s result shape in `src/commands/tasks/tasks.ts`
before relying on a specific field name, or run once in a container and
record the real output.

**Verify outside akm:** `crontab -l | grep -A2 "# akm:task $TID BEGIN"`
shows the schedule restored to the YAML's value, not the hand-edited one.

**Cleanup:** same manual crontab-block removal as DT-1, plus delete the
YAML, plus restore the mandatory backup.

### DT-4 — `task sync` reconciling a workflow-targeting task's schedule [Linux: cron; VM/disposable-account strongly recommended]

**Why it matters:** `task sync`'s own one-line help ("preflight and
reconcile a bundle's task/workflow schedules") is the only place in the CLI
that names both features together. This is DT-3's counterpart for a task
whose target is a workflow rather than a shell command — not a duplicate:
the target kind is different and both paths need independent coverage.

**Mandatory precondition:** `crontab -l > "$AKM_SANDBOX/crontab-backup-$(date +%Y%m%d-%H%M%S).txt" 2>&1` — stop if it shows unrecognized real entries.

**Setup** (disposable container/VM with an empty crontab only; use a
collision-proof bundle name so the resulting scheduler evidence is easy to
identify and clean up):
```sh
export SEAM_BUNDLE_NAME="akm-manual-test-seam-$(date +%s)"
cat > "$AKM_BUNDLE_DIR/workflows/leaf.yml" <<'EOF'
name: Manual test leaf workflow
on:
  workflow_dispatch:
jobs:
  main:
    runs-on: [self-hosted]
    steps:
      - id: work
        run: printf leaf-ok
EOF
cat > "$AKM_BUNDLE_DIR/tasks/akm-manual-test-drift.yml" <<'EOF'
version: 4
name: Manual test drift task -> workflow
uses: workflows/leaf
schedule:
  - cron: "0 3 * * *"
    enabled: true
EOF
akm index
```

**Steps and expected results:**
1. `akm task sync --bundle "$SEAM_BUNDLE_NAME"` (first install) → expected
   exit `0`, `.installed` contains `"akm-manual-test-drift"`, `.updated ==
   []`, `.removed == []`. Cross-check: `crontab -l | grep -A1 "akm:task
   akm-manual-test-drift BEGIN"` shows `0 3 * * *`, `--bundle
   "$SEAM_BUNDLE_NAME"`, and `task run akm-manual-test-drift --scheduled`.
2. Simulate OS-side drift without touching the bundle file:
   `crontab -l | sed 's/^0 3 \* \* \*\(.*akm-manual-test-drift.*\)/0 4 * * *\1/' | crontab -`.
   Cross-check the entry now shows `0 4 * * *`.
3. `akm task sync --bundle "$SEAM_BUNDLE_NAME"` again → expected exit `0`,
   `.updated` contains `"akm-manual-test-drift"` (the bundle's `.yml` wins),
   `.installed == []`, `.removed == []`. Cross-check the entry shows `0 3 *
   * *` again.
4. `rm "$AKM_BUNDLE_DIR/tasks/akm-manual-test-drift.yml" && akm task sync
   --bundle "$SEAM_BUNDLE_NAME"` (the product's documented removal
   mechanism — there is no `task remove` subcommand;
   `docs/reference/tasks.md:391`: *"Delete the `.yml` source and sync to
   remove its derived binding(s)."*) → expected exit `0`, `.removed`
   contains `"akm-manual-test-drift"`. Cross-check: `crontab -l | grep -c
   akm-manual-test-drift` prints `0`.

**`UNVERIFIED` — this scenario's step-by-step outputs were designed from
traced source (`belongsToBundle`, `src/tasks/scheduler-sync.ts`) but not
executed live: the coding-agent sandbox's destructive-action classifier
refused every `task sync` call attempted during review, which is itself a
useful signal about how this surface should be treated.** Confirm the exact
`.installed`/`.updated`/`.removed` values on a real disposable scheduler
before relying on this test.

**Cleanup:** if step 4 was reached the crontab is already clean; regardless,
restore the mandatory backup and verify with `crontab -l`.

### DT-5 — Cross-bundle name collision cannot make `sync` remove another bundle's entries (#846 regression) [Linux: cron; disposable VM/container REQUIRED]

**Why it matters:** alpha.5 could inspect and remove an unrelated scheduler
entry when two primary bundles derived the same basename. Stable 0.9.2
requires a name match *and* a resolved owner-path match before an entry is in
scope, and refuses ownership when the scheduler-context descriptor is missing,
unreadable, corrupt, or belongs to another OS user. This test reproduces the
original collision safely and proves task A survives bundle B's sync.

**`UNVERIFIED` — even this fully self-contained, two-throwaway-bundle
reproduction was refused by the coding-agent sandbox's destructive-action
classifier before any `task sync` call executed during this document's
review.** This test is designed from traced source, not run live. Whoever
runs it for real needs an environment without that guardrail — a
disposable VM/container is exactly that, and is required here regardless.

**Mandatory precondition:** `crontab -l > "$AKM_SANDBOX/crontab-backup-$(date +%Y%m%d-%H%M%S).txt" 2>&1`.

**Setup — two throwaway bundles that deliberately collide by name:**
```sh
export BASE=/tmp/akm-seam-collide-$(date +%s)
mkdir -p "$BASE/a/bundle"/{tasks,workflows} "$BASE/a"/{config,data,cache,state}
mkdir -p "$BASE/b-collide/bundle"/{tasks,workflows} "$BASE/b-collide"/{config,data,cache,state}
for d in a b-collide; do
  cat > "$BASE/$d/config/config.json" <<'EOF'
{"configVersion":"0.9.0","semanticSearchMode":"off","registries":[]}
EOF
done
# Both bundle directories are literally named "bundle" — same basename means
# deriveBundleId (src/core/write-source.ts:1254) derives the SAME name for
# both, because de-dup only checks each bundle's OWN config.json, never the
# other bundle's. This is the collision, reproduced on purpose.

cat > "$BASE/a/bundle/tasks/akm-manual-test-collide-a.yml" <<'EOF'
version: 4
name: Collision test task A (should survive if scoping is correct)
run: printf collide-a-ok
schedule:
  - cron: "1 1 * * *"
    enabled: true
EOF

cat > "$BASE/b-collide/bundle/tasks/akm-manual-test-collide-b.yml" <<'EOF'
version: 4
name: Collision test task B (does not declare task A)
run: printf collide-b-ok
schedule:
  - cron: "2 2 * * *"
    enabled: true
EOF
```

**Steps and expected results:**
1. Install bundle A with **no** `--bundle` flag (name comes from the
   directory-basename default):
   ```sh
   export AKM_BUNDLE_DIR="$BASE/a/bundle" AKM_CONFIG_DIR="$BASE/a/config" \
          AKM_DATA_DIR="$BASE/a/data" AKM_CACHE_DIR="$BASE/a/cache" AKM_STATE_DIR="$BASE/a/state"
   akm index && akm task sync
   ```
   Expected: exit `0`, `.installed` contains `"akm-manual-test-collide-a"`.
   Cross-check: `crontab -l | grep akm-manual-test-collide-a` shows `1 1 *
   * *`.
2. Install bundle B (the colliding one), same pattern, no `--bundle` flag:
   ```sh
   export AKM_BUNDLE_DIR="$BASE/b-collide/bundle" AKM_CONFIG_DIR="$BASE/b-collide/config" \
          AKM_DATA_DIR="$BASE/b-collide/data" AKM_CACHE_DIR="$BASE/b-collide/cache" AKM_STATE_DIR="$BASE/b-collide/state"
   akm index && akm task sync
   ```
   Expected: `.removed == []` for task A and `.installed` contains
   `"akm-manual-test-collide-b"`. Cross-check: `crontab -l | grep -c
   akm-manual-test-collide-a` prints `1`, and its line still shows `1 1 * *
   *`. **This is the falsifiable core of the regression:** a removal of task A
   is a release-blocking recurrence of #846.
3. **Negative control**, proving scoping DOES work when names differ.
   Reinstall task A (repeat step 1), then repeat step 2 with a
   non-colliding directory name, e.g. `"$BASE/b-safe/bundle-safe"`.
   Expected: `.removed == []`, task A's entry is still untouched. This proves
   the non-colliding case stays unchanged alongside the collision fix.

**Cleanup:** `crontab "$AKM_SANDBOX/crontab-backup-"*.txt` to restore, then
verify with `crontab -l` that only the original entries remain. `rm -rf
"$BASE"`.

### DT-6 — macOS launchd equivalents of DT-1..DT-3 [PLATFORM-GATED — cannot run on this Linux machine]

Everything above assumed `backend == "cron"`. On macOS, `akm task doctor`
should report `.backend == "launchd"` (inferred from source, not observed).
Re-run DT-1–DT-3 there with:
- Verify outside akm: `launchctl list | grep <TID>` and inspect the
  generated plist under whatever path `doctor`'s `logDir`-equivalent
  reports on that host.
- Cleanup: `launchctl bootout`/`unload` the job by label before deleting
  the plist and the task YAML — do not rely on `akm task sync` for
  cleanup, same rationale as DT-1.

**Entirely UNVERIFIED — confirm before shipping.** Per issue #770 this
path has no automated coverage, which is exactly why it's high-risk manual
surface.

### DT-7 — Windows schtasks equivalents of DT-1..DT-3 [PLATFORM-GATED — cannot run on this Linux machine]

Same structure as DT-6 but for `schtasks`. Verify outside akm with
`schtasks /query /tn <TID> /v /fo list`. Cleanup with `schtasks /delete /tn
<TID> /f` before deleting the task YAML. **Entirely UNVERIFIED** — not
executed, platform absent here; per #770 this is uncovered by automation.

---

## Corrections made during adversarial review

This document was assembled from three independently-authored drafts and
adversarially spot-checked against a live build before merging. Two
specific corrections from that review:

1. **The claim "`akm workflow --help` USAGE omits `plan`" does not
   reproduce on commit `fb7bef3f`.** Live-checked against both `bun
   src/cli.ts workflow --help` and a freshly rebuilt `dist/akm workflow
   --help`: both list `status|list|create|resume|abandon|run|plan` in the
   USAGE line and describe `plan` in the COMMANDS table. One source draft's
   claim to the contrary appears to have been made against a stale `dist/`
   build before it noticed and rebuilt (the same draft separately warns
   "the checked-out `dist/` was stale... lacked `workflow plan`"). The
   correct, still-true finding kept in this document instead is: `akm task
   --help` genuinely has no `remove` subcommand (`add|run|explain|history|
   sync|doctor` only) — confirmed live.
2. **INT-2's parent-side child-run evidence shape**, marked `UNVERIFIED` in
   the source draft, was resolved live during review (see INT-2 step 2
   above): for a child dispatched via `uses: tasks/<ref>` where the child
   workflow declares no `outputs:`, the parent step's `evidence.output` is
   a bare `{runId, status}` pointer, while the full child summary is
   carried in the top-level `.children[]` array — the same array shape
   WF-3 already demonstrates for a direct (non-task) child dispatch whose
   child workflow *does* declare `outputs:`.

Live alpha.5 spot-checks performed (in addition to the two above): TASK-3,
TASK-6, TASK-9, TASK-12, TASK-13, WF-2, WF-5 (incl. `status --units`),
WF-3/INT-2's `.children` shape, WF-6/#847's original reproduction, WF-9's
sqlite table/column names and exact error message, and INT-1 end to end. All
matched their source draft's claimed exact fields, error codes, and exit codes
with no further discrepancies found. Stable 0.9.2 changes WF-6 and DT-5 to
the fixed regression expectations documented above; both are now automated.
No test was found using
non-falsifiable language ("works correctly", "runs successfully", "no
errors"); the three source drafts were already disciplined about naming
exact exit codes, JSON fields, and error strings. No true duplicate tests
were found across the three drafts — the deliberate contrast pairs (WF-6 vs
WF-7; DT-3 vs DT-4) were kept, and no accidental duplication existed thanks
to the drafts' explicit scope carve-outs.

## A note on the existing bundle checklist

The AKM bundle asset `knowledge/projects/akm/akm-manual-testing-checklist`
(frontmatter `updated: 2026-05-17`) has stale Tasks (§5) and Workflows (§7)
sections: it references `akm tasks list` (the command is `task`, singular
— `akm tasks list` does not exist) and `akm workflow next` (no such
subcommand exists in 0.9.2; the current surface is `status|list|create|
resume|abandon|run|plan`). Recommend replacing those two sections with a
pointer to this document rather than trying to patch them in place. This
document does not edit that bundle asset — only its author/owner should.
