# Manual Testing Checklist

Use this checklist to exercise akm `v0.7.0` in an isolated sandbox before
cutting a release. Pair it with `testing-workflow.md` and
`test-coverage-guide.md`.

This pass focuses on end-to-end CLI behavior that automated suites do not fully
cover:

- output shaping (`json`, `jsonl`, `text`, `yaml`)
- prompt/usage flows
- migration/error envelopes
- file-system side effects
- commands added in `0.7.0` (`history`, `events`, `reflect`, `propose`,
  `proposal`, `distill`)

Time budget:

- ~35 minutes for the core offline/local pass
- +10 to 15 minutes for network-backed source and registry checks
- +10 to 15 minutes for optional agent/LLM-backed `0.7.0` flows

This document was rebuilt against current `0.7.0-rc1` behavior on 2026-04-30.

---

## 1. Safety Rules

Every step below assumes a throwaway environment. Do **not** run this against
your real config, real stash, real shell profile, or a globally installed `akm`
you care about.

- [ ] Use a disposable shell session.
- [ ] Isolate `HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, and
      `AKM_STASH_DIR` under one temp directory.
- [ ] Invoke the CLI from this repo (`bun run ./src/cli.ts` or the freshly built
      binary from this branch), not a previously installed global `akm`.
- [ ] Only add disposable local paths, test registries, and remotes you control.
- [ ] Do **not** run `akm upgrade` as an install action during manual QA.
      Only use `akm upgrade --check`.
- [ ] Do **not** run `akm completions --install` against your real shell setup.
      In this sandbox it is safe because `HOME` and `XDG_DATA_HOME` are
      isolated, but the default coverage path should still prefer stdout-only
      generation.

If any step would mutate something outside `$AKM_SANDBOX`, stop and fix the
environment before proceeding.

---

## 2. Sandbox Setup

```sh
# 2.1 Build from the current branch
bun install
bun run build

# 2.2 Create a fully isolated environment
export AKM_SANDBOX="$(mktemp -d /tmp/akm-sandbox.XXXXXX)"
export HOME="$AKM_SANDBOX/home"
export XDG_CONFIG_HOME="$AKM_SANDBOX/config"
export XDG_CACHE_HOME="$AKM_SANDBOX/cache"
export XDG_DATA_HOME="$AKM_SANDBOX/data"
export AKM_STASH_DIR="$AKM_SANDBOX/stash"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$AKM_STASH_DIR"

# 2.3 Convenience alias for this shell only
alias akm='bun run ./src/cli.ts'

# 2.4 Verify isolation
akm init | jq '.stashDir'
akm config path --all
```

- [ ] `akm init` reports a stash path under `$AKM_SANDBOX`.
- [ ] `akm config path --all` reports config, stash, cache, and index paths
      under `$AKM_SANDBOX`.

---

## 3. Fixtures

The repo ships pre-built ranking fixtures at `tests/fixtures/stashes/ranking-baseline/`.
Use them as a synthetic stash so search/show output is deterministic.

```sh
# 2.1 Mirror the fixture stash into the sandbox
cp -r tests/fixtures/stashes/ranking-baseline/* "$AKM_STASH_DIR/"
ls "$AKM_STASH_DIR"
```

- [ ] Expected top-level dirs exist:
      `agents commands knowledge memories scripts skills vaults wikis workflows`.

Fixture refs worth using throughout this doc:

| Type      | Ref                                   |
|-----------|---------------------------------------|
| skill     | `skill:k8s-deploy`                    |
| skill     | `skill:docker-homelab`                |
| knowledge | `knowledge:incident-response-runbook` |
| agent     | `agent:code-reviewer`                 |
| command   | `command:release-manager`             |

---

## 4. First-Run Surface

- [ ] `akm info` returns JSON with `schemaVersion`, `version`, `assetTypes`,
      `searchModes`, `semanticSearch`, `registries`, `sourceProviders`, and
      `indexStats`.
- [ ] `akm config list` emits `sources`, not legacy `stashes`, for current
      persisted config.
- [ ] `akm config path --all` returns sandbox-local paths only.
- [ ] `akm hints` prints non-empty text.
- [ ] `akm hints --detail full` prints the extended hint text.
- [ ] `akm --help` lists the current command surface:
      `setup`, `init`, `index`, `info`, `add`, `list`, `remove`, `update`,
      `upgrade`, `search`, `curate`, `show`, `workflow`, `remember`, `import`,
      `save`, `clone`, `registry`, `config`, `enable`, `disable`, `feedback`,
      `history`, `events`, `proposal`, `reflect`, `propose`, `distill`, `help`,
      `hints`, `completions`, `vault`, `wiki`.
- [ ] `akm enable --help` and `akm disable --help` mention `skills.sh` only.
- [ ] `akm upgrade --check` returns structured version/install-method info and
      does not modify the sandbox or the host install.
- [ ] `akm completions` prints a bash completion script to stdout.
- [ ] `akm completions --install` writes only inside the sandboxed
      `$XDG_DATA_HOME` / `$HOME` tree.

---

## 5. Index and Search

- [ ] `akm index --full` reports a non-zero `totalEntries` and successful
      verification.
- [ ] `akm index --verbose` prints phase progress to stderr without corrupting
      stdout JSON.
- [ ] `akm search docker` returns hits under `hits[]`.
- [ ] `akm search docker --format json | jq '.hits | length'` matches the
      visible count.
- [ ] `akm search "code review" --type skill` returns only skill hits.
- [ ] `akm search code --source registry` emits `registryHits[]` and does not
      mix local hits into `hits[]`.
- [ ] `akm search code --source both` emits both `hits[]` and `registryHits[]`.
- [ ] `akm search docker --detail full` includes richer hit fields such as
      `ref`, `score`, optional `origin`, and ranking metadata.
- [ ] `akm search docker --detail agent` includes `ref` plus the smaller
      action-oriented field set.
- [ ] `akm search docker --format jsonl` emits one JSON object per line.
- [ ] `akm search docker --format yaml` is valid YAML and preserves the same
      envelope data.
- [ ] Re-run `akm index` with no flags; incremental indexing succeeds and keeps
      entry count stable.

### 5.1 Scoped memory search (`0.7.0`)

- [ ] Create one scoped memory:
      `akm remember "scoped note" --name scoped-note --user alice --agent claude`.
- [ ] `akm search scoped --filter user=alice` returns the scoped memory.
- [ ] `akm search scoped --filter user=bob` excludes it.
- [ ] Repeating `--filter` AND-joins as documented.

---

## 6. Show

- [ ] `akm show skill:k8s-deploy` returns structured content including
      `type`, `name`, `action`, and `content`.
- [ ] `akm show skill:k8s-deploy --format text` renders the markdown body
      directly.
- [ ] `akm show skill:k8s-deploy --detail summary` returns the compact summary
      shape.
- [ ] `akm show skill:k8s-deploy --detail agent` returns the action-oriented
      shape.
- [ ] `akm show knowledge:incident-response-runbook toc` prints the table of
      contents only.
- [ ] `akm show knowledge:incident-response-runbook section "Severity Levels"`
      narrows to that section.
- [ ] `akm show knowledge:incident-response-runbook lines 1 20` returns the
      requested range.
- [ ] `akm show knowledge:incident-response-runbook frontmatter` returns only
      frontmatter.
- [ ] `akm show knowledge:incident-response-runbook full` returns the raw file.
- [ ] `akm show knowledge:incident-response-runbook section "Not Real"` returns
      a friendly section-not-found message that points at `toc`.
- [ ] `akm show skill:does-not-exist` fails with `ASSET_NOT_FOUND`, includes a
      structured JSON envelope on stderr, and exits non-zero.

### 6.1 Scoped show (`0.7.0`)

- [ ] `akm show memory:scoped-note --scope user=alice` resolves the memory.
- [ ] `akm show memory:scoped-note --scope user=bob` fails to resolve it.

---

## 7. Source Management

For each kind, perform add → list → search → update (where applicable) →
remove. Only use disposable targets.

### 7.1 Filesystem source

- [ ] `mkdir -p "$AKM_SANDBOX/extra-stash" && akm add "$AKM_SANDBOX/extra-stash"`
      succeeds and triggers indexing.
- [ ] `akm list --format json | jq '.sources[]'` includes the new source with a
      filesystem/local kind, path, and writable state.
- [ ] `akm remove "$AKM_SANDBOX/extra-stash"` removes it cleanly.

### 7.2 Git source

- [ ] `akm add github:<owner>/<repo>` against a small disposable public repo.
- [ ] `akm list` shows the git source.
- [ ] `akm update <name>` fetches successfully.
- [ ] `akm search <term-from-repo>` surfaces indexed content from the cloned
      source.
- [ ] `akm remove <name>` cleans it up.

### 7.3 npm source

- [ ] `akm add npm:<small-package>` succeeds.
- [ ] `akm list` shows `kind: "npm"` or equivalent rendered npm source info.
- [ ] `akm remove <name>` succeeds.

### 7.4 Website source

- [ ] `akm add https://example-skills-site.dev --name docs-site` adds the
      source.
- [ ] `akm list` shows the remote/website source.
- [ ] `akm update docs-site` either refreshes it successfully or returns a
      structured non-updatable error that matches current behavior.

### 7.5 Writable rejection

- [ ] Edit `$XDG_CONFIG_HOME/akm/config.json` to set `"writable": true` on a
      `npm` or `website` source.
- [ ] `akm list` fails with a `ConfigError` and actionable hint.
- [ ] Revert the edit; `akm list` succeeds again.

---

## 8. Write Commands

These cover the shared write-target path and git-backed save behavior.

### 8.1 remember

- [ ] `akm remember "test memory body" --name test-memory` writes a plain
      memory.
- [ ] `akm show memory:test-memory` resolves it.
- [ ] `akm remember "another" --name test-2 --description "desc" --tag foo --tag bar`
      persists `description` and both tags in frontmatter.
- [ ] `echo "stdin body" | akm remember --name from-stdin` reads from stdin.
- [ ] `akm remember "vpn note" --name expiring --tag ops --expires 30d --source "skill:k8s-deploy"`
      persists frontmatter with `tags`, `expires`, and `source`.
- [ ] `akm remember "Found curl pipe" --name auto-note --auto` succeeds only if
      heuristic tagging derives tags; written frontmatter includes derived data.
- [ ] `akm remember "Long meeting notes" --name enrich-note --enrich` either
      enriches successfully when LLM config exists or fails/soft-fails in the
      documented structured way without a stack trace.
- [ ] `akm remember "scope only" --name scoped-only --user alice --run run-42`
      succeeds without tags and persists scope frontmatter.

### 8.2 remember target resolution

- [ ] Add a second filesystem source:
      `mkdir -p "$AKM_SANDBOX/alt" && akm add "$AKM_SANDBOX/alt"`.
- [ ] Confirm the source name via `akm list --format json`.
- [ ] `akm remember "to alt" --name alt-mem --target <source-name>` writes to
      that source.
- [ ] `akm remember "x" --name y --target nonexistent` fails with
      `INVALID_FLAG_VALUE`.

### 8.3 defaultWriteTarget

- [ ] `akm config set defaultWriteTarget <source-name>` succeeds.
- [ ] `akm config get defaultWriteTarget` reads it back.
- [ ] `akm remember "via default" --name via-default` lands in that target.
- [ ] `akm config unset defaultWriteTarget` removes it.

### 8.4 import

- [ ] Create `$AKM_SANDBOX/incoming.md` with a heading and body.
- [ ] `akm import "$AKM_SANDBOX/incoming.md" --name imported-doc` writes a
      knowledge file into the default write target.
- [ ] `akm import - --name stdin-doc < "$AKM_SANDBOX/incoming.md"` works from
      stdin.
- [ ] `akm import "$AKM_SANDBOX/incoming.md" --name to-alt --target <source-name>`
      lands in the alternate target.
- [ ] `akm import does-not-exist.md --name broken` fails cleanly with a
      structured usage error and no stack trace.

### 8.5 save

- [ ] `akm save --format json` on the primary sandbox stash returns either a
      commit result or a structured `skipped: true` no-op if the stash is not a
      git repo.
- [ ] If `akm init` created a git repo, modify one file in the sandbox stash
      and run `akm save -m "Manual QA save test"`; verify it commits only inside
      the sandbox repo.
- [ ] Do not point `akm save` at any real repo or writable remote outside the
      sandbox.

---

## 9. Curate and Clone

- [ ] `akm curate "review this PR for security issues"` returns
      `{items, query, summary}`.
- [ ] `akm curate "review code" --format json | jq '.items | length'` is
      non-zero.
- [ ] `akm curate ""` now fails with `MISSING_REQUIRED_ARGUMENT` rather than
      returning ranked filler results.
- [ ] `akm clone skill:k8s-deploy --dest "$AKM_SANDBOX/clone-target"` copies the
      asset to the requested destination.
- [ ] `akm clone skill:k8s-deploy --name qa-copy --dest "$AKM_SANDBOX/clone-target"`
      renames the cloned output.
- [ ] `akm clone skill:does-not-exist --dest "$AKM_SANDBOX/clone-doomed"` fails
      with `ASSET_NOT_FOUND`.

---

## 10. Registry

These steps need network access.

- [ ] `akm registry list` shows the configured registries.
- [ ] `akm registry search docker --detail full` returns registry hits with
      `installRef` and score.
- [ ] `akm registry search docker --assets` includes asset-level matches if the
      provider supports them.
- [ ] `akm registry add https://registry.example/index.json --name test-reg`
      adds a test registry, `akm registry list` shows it, and
      `akm registry remove test-reg` removes it.
- [ ] `akm registry add http://registry.example/index.json` fails unless
      `--allow-insecure` is supplied.
- [ ] `akm registry add http://registry.example/index.json --allow-insecure`
      succeeds with a warning on stderr.
- [ ] Installing a hit still happens through `akm add <installRef>`; there is
      no `registry add-kit` subcommand.

`registry build-index` is primarily a publisher/developer flow. Run it only in
an isolated working directory with disposable output paths.

---

## 11. Workflow

Workflows now include authoring, validation, execution, and recovery flows.

- [ ] `akm workflow list` is empty in a fresh sandbox.
- [ ] `akm workflow template > "$AKM_STASH_DIR/workflows/test.md"` prints a valid
      starter document.
- [ ] Insert one short paragraph between `# Workflow:` and the first `## Step:`.
- [ ] `akm workflow validate "$AKM_STASH_DIR/workflows/test.md"` succeeds,
      confirming intro prose is accepted.
- [ ] `akm workflow create test-created --from "$AKM_STASH_DIR/workflows/test.md"`
      writes and indexes the workflow.
- [ ] `akm workflow validate workflow:test-created` succeeds by ref.
- [ ] `akm workflow start workflow:test-created` returns a run with `id`,
      `workflowRef`, and steps.
- [ ] `akm workflow status <run-id>` returns the full run state.
- [ ] `akm workflow status workflow:test-created` resolves the most recent run
      for that ref.
- [ ] `akm workflow next workflow:test-created` returns the current actionable
      step. If no active run exists, it may auto-start one.
- [ ] `akm workflow complete <run-id> --step <step-id> --state blocked --notes "waiting"`
      marks the step blocked.
- [ ] `akm workflow resume <run-id>` flips the blocked run back to active.
- [ ] `akm workflow complete <run-id> --step <step-id> --state completed --notes "done"`
      succeeds after resume.
- [ ] `akm workflow create bad-name!` fails with a structured usage error.
- [ ] `akm workflow create test-created --force` fails unless paired with
      `--from` or `--reset`.

---

## 12. Wiki

- [ ] `akm wiki list` is empty initially.
- [ ] `akm wiki create my-wiki` scaffolds the wiki.
- [ ] `akm wiki list` shows `my-wiki` with counts.
- [ ] `akm wiki show my-wiki` returns path, counts, and recent log entries.
- [ ] Add one markdown page under the wiki dir and confirm `akm wiki pages my-wiki`
      lists it.
- [ ] `akm wiki search my-wiki <term-from-page>` returns only page hits from
      that wiki.
- [ ] `echo "# Raw source" | akm wiki stash my-wiki - --as raw-source` creates a
      raw source file.
- [ ] Re-running the same explicit slug with `--as raw-source` fails rather than
      overwriting.
- [ ] `akm wiki ingest my-wiki` prints the ingest workflow and does not mutate
      content.
- [ ] `akm wiki lint my-wiki` returns deterministic findings or a clean pass.
- [ ] `akm show wiki:my-wiki` returns the same summary class as
      `akm wiki show my-wiki`.
- [ ] `akm wiki remove my-wiki --force` removes the wiki.

`wiki register` should only be tested against disposable paths or repos. Do not
register a real long-lived knowledge repo unless you intend to exercise it.

---

## 13. Vault

The vault surface is intentionally strict about not printing values. Confirm
that guarantee carefully.

- [ ] `akm vault list` is empty initially.
- [ ] `akm vault create test-vault` creates `vaults/test-vault.env`.
- [ ] `akm vault set vault:test-vault MY_KEY=secret-value --comment "test secret"`
      succeeds.
- [ ] `akm vault show vault:test-vault` lists keys/comments only.
- [ ] `akm vault list vault:test-vault --format json` contains no `value` field.
- [ ] `akm vault load vault:test-vault` prints only a shell snippet
      (`. <temp>; rm -f <temp>`), not the secret value.
- [ ] `eval "$(akm vault load vault:test-vault)" && test "$MY_KEY" = "secret-value"`
      loads the value into the current shell in the sandbox session.
- [ ] The temp file path emitted by `vault load` points at a temp location and
      is removed by the emitted shell snippet.
- [ ] `akm vault unset vault:test-vault MY_KEY` removes the key.

---

## 14. Feedback, History, and Events

These are the main auditability additions/expansions to validate in `0.7.0`.

- [ ] `akm feedback skill:k8s-deploy --positive` succeeds.
- [ ] `akm feedback skill:k8s-deploy --negative --note "not specific enough"`
      succeeds.
- [ ] `akm feedback` with no ref fails with `MISSING_REQUIRED_ARGUMENT`.
- [ ] `akm feedback skill:k8s-deploy --positive --negative` fails with a
      structured usage error.
- [ ] `akm history --ref skill:k8s-deploy` returns chronological history entries.
- [ ] `akm history --since 2026-01-01T00:00:00Z --format jsonl` emits one JSON
      object per line.
- [ ] `akm events list` shows appended mutation events.
- [ ] `akm events list --type feedback --ref skill:k8s-deploy` filters correctly.
- [ ] `akm events tail --max-events 2 --format jsonl` streams events and ends
      with a trailer row containing `nextOffset`.
- [ ] `akm events tail --max-events 1 --format text` emits line-oriented events
      on stdout and the trailer on stderr.

---

## 15. Proposal Queue and Agent-Backed `0.7.0` Commands

These require configured external agent profiles and, for `distill`, LLM config.
Run only inside the sandbox.

### 15.1 Proposal queue (no external agent required if seeded by prior steps)

- [ ] `akm proposal list` returns a structured queue view.
- [ ] `akm proposal list --status pending` filters correctly.
- [ ] If any proposal exists, `akm proposal show <id>` renders metadata/body.
- [ ] If any proposal exists, `akm proposal diff <id>` renders the pending delta.
- [ ] If any valid proposal exists, `akm proposal accept <id>` promotes it
      through the normal write-target path and emits the expected mutation
      result without a stack trace.
- [ ] `akm proposal reject <id> --reason "manual qa"` archives it cleanly.

### 15.2 reflect / propose

- [ ] `akm reflect skill:k8s-deploy --task "tighten the description"` either
      queues a proposal successfully or fails with a structured config/usage
      envelope if no agent profile is configured.
- [ ] `akm propose skill qa-generated-skill --task "simple review helper"`
      either queues a proposal successfully or fails structurally if the agent
      runtime is not configured.
- [ ] Any successful `reflect` emits a `reflect_invoked` event.
- [ ] Any successful `propose` emits a `propose_invoked` event.

### 15.3 distill

- [ ] `akm distill skill:k8s-deploy` returns `outcome: "skipped"` when
      `llm.features.feedback_distillation` is disabled, or queues a lesson
      proposal when enabled.
- [ ] `akm distill skill:k8s-deploy --exclude-feedback-from "memory:test-memory"`
      accepts valid refs.
- [ ] `akm distill skill:k8s-deploy --exclude-feedback-from "not-a-ref"` fails
      with `INVALID_FLAG_VALUE`.
- [ ] Any successful `distill` emits a `distill_invoked` event.

---

## 16. Config and Migration

- [ ] `akm config list` reports current state.
- [ ] `akm config set llm '{"endpoint":"http://localhost:1234/v1"}'` persists
      the whole section.
- [ ] `akm config set llm.endpoint http://localhost:1234/v1` updates the subkey.
- [ ] `akm config get llm.endpoint` reads it back.
- [ ] `akm config unset llm.apiKey` removes the subkey cleanly.
- [ ] `akm config set defaultWriteTarget <source-name>` now works.
- [ ] `akm help migrate 0.6.0` prints bundled migration notes.
- [ ] `akm help migrate v0.6.0-rc1` normalizes to the stable note.
- [ ] `akm help migrate latest` picks the newest bundled note.
- [ ] `akm help migrate 9.9.9` prints a graceful fallback listing available
      notes.

### 16.1 Legacy config migration

- [ ] Replace `$XDG_CONFIG_HOME/akm/config.json` with one using legacy
      `stashes[]`.
- [ ] `akm list` succeeds and warns that `stashes` is deprecated in favor of
      `sources`.
- [ ] Running a config write command rewrites persisted config to `sources[]`.

### 16.2 OpenViking rejection

- [ ] Inject an `openviking` source into `sources[]`.
- [ ] `akm list` fails with a structured `ConfigError` that points at migration
      guidance.
- [ ] Remove it; normal commands work again.

---

## 17. Error Handling

Spot-check that failures always arrive as structured JSON on stderr with
`{ok:false, error, code?, hint?}` and exit non-zero.

- [ ] `akm search` with no query fails with `MISSING_REQUIRED_ARGUMENT`.
- [ ] `akm curate ""` fails with `MISSING_REQUIRED_ARGUMENT`.
- [ ] `akm show foo` fails with a ref-parse usage error.
- [ ] `akm config set sources weird-thing` fails with a structured JSON/usage
      error.
- [ ] `akm help migrate` with no version fails with `MISSING_REQUIRED_ARGUMENT`.
- [ ] `akm workflow next definitely-not-a-run-id` fails structurally and does
      not dump a stack trace.
- [ ] `akm vault list missing-vault` fails with `ASSET_NOT_FOUND` or the
      current typed not-found envelope.

If any failure prints a bare stack trace, that is a regression.

---

## 18. Format Round-Trip

Confirm representative commands are parseable as JSON/YAML/JSONL.

```sh
for cmd in \
  'list' \
  'search docker' \
  'show skill:k8s-deploy' \
  'info' \
  'config list' \
  'curate "review code"' \
  'history --ref skill:k8s-deploy' \
  'events list'; do
  akm $cmd --format json | jq -e . > /dev/null || exit 1
done
```

- [ ] All representative `--format json` commands parse successfully.
- [ ] At least one `search`/`history`/`events tail` path is verified with
      `--format jsonl`.
- [ ] At least one `info`/`show` path is verified with `--format yaml`.

---

## 19. Sandbox Cleanup

```sh
rm -rf "$AKM_SANDBOX"
unset AKM_SANDBOX HOME XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME AKM_STASH_DIR
unalias akm
```

- [ ] Cleanup succeeds without errors.
- [ ] Real config (`~/.config/akm`), real shell completion dirs, and any real
      globally installed `akm` remain untouched.

---

## When to Run This

- **Before tagging a release**: full pass.
- **After CLI-surface changes**: sections 4, 5, 6, 17 minimum.
- **After write-path or git-path changes**: sections 7, 8, 11, 12, 13, 15.
- **After runtime/dependency changes**: sections 5, 10, 14, 18.

Record results in `docs/migration/release-notes/<version>.md` under a
"Manual QA" subsection when the release includes user-visible changes.
