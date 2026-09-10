# Saved workflows

Scripts in this directory are resolved by name by the Workflow tool
(`Workflow({ name: "batch", args: {...} })`). They are plain JavaScript in the
workflow runtime's dialect: top-level `await` and `return`, and the globals
`agent`, `pipeline`, `parallel`, `phase`, `log`, `args`.

## `batch` — the template for implement-and-review work

Base every new implementation workflow on `batch.js`. Its shape is what makes it
cheap:

| Stage | Who | Parallelism |
| --- | --- | --- |
| Implement one item | Sonnet, in its own worktree `.claude/worktrees/<batch>-<key>` on `wt/<batch>/<key>` | all items at once, up to the runtime's agent cap |
| Review that item, one fix round | Sonnet | starts the moment its item lands (pipelined, no barrier) |
| Integrate and gate | Sonnet merges every item branch `--no-ff` into `wt/<batch>`, regenerates the schema, runs the gate ONCE | the one barrier |
| Final review | Opus (or Fable via `finalReviewModel`) over the whole `baseSha..head` diff | one agent |

If the final review finds anything that must change, it writes
`<brief dir>/<batch>-iter<N+1>.md` (findings, files, recommended fixes, how to
test) and the loop starts again from the integrated head with those items, up
to `maxIterations` (default 2). A red gate becomes an extra item on the next
iteration. Anything left open at the cap is returned as `needs-human`.

Rules the template enforces on every agent: one commit per logical change
(test with the code it pins; docs with their CHANGELOG bullet; a schema change
with its regenerated output); focused tests, lint and typecheck inside item
agents, never the full suites; no edits outside the agent's own worktree; no
pushes. The coordinator reviews the integrated branch and pushes.

### Args

```jsonc
{
  "batch": "field-F4",                      // names the branch wt/<batch> and worktree
  "baseSha": "673eb83f",                    // where every item branch starts
  "brief": "/abs/path/briefs/field-F4.md",  // what to implement; next-iteration briefs land beside it
  "items": [                                // independent work items
    { "key": "F4a", "title": "…", "issue": 955, "scope": "src/…, tests/…" }
  ],
  "repoRoot": "/home/user/akm",             // optional
  "rules": ["/abs/path/COMMON.md"],         // optional extra rule files every agent reads
  "gate": "TMPDIR=/tmp bun run check",      // optional; use the release check for a release candidate
  "finalReviewModel": "opus",               // optional: "opus" | "fable"
  "maxIterations": 2                        // optional
}
```

Items must be independent of each other (different files, or at least
different logic): they are merged after the fact, and a conflict costs an
integrator round. Split a brief along those lines before invoking.

### What not to copy from older runs

- One worktree for the whole batch with items implemented one after another.
- Two Sonnet review rounds per item; the final review is the second pair of eyes.
- A gate that runs `test:unit` and `test:integration` and then a release check
  that runs both again.
- Long pasted rule text in every prompt; point agents at the files instead.
