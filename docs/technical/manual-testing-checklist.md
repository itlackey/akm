# Manual Testing Checklist

Use this checklist to exercise akm v0.6.0 in a sandbox against known fixtures
before cutting a release. Pair it with the automated suites described in
`testing-workflow.md` and `test-coverage-guide.md` — manual coverage focuses
on end-to-end UX (output formatting, prompt flows, error messages) that the
unit tests don't fully cover.

Time budget: ~30 minutes for a full pass on a fresh sandbox.

This document was rebuilt against actual v0.6.0-rc1 behavior on 2026-04-25.
Any phantom subcommands listed in earlier revisions (`akm config show`,
`akm vault add`, `akm workflow run --dry-run`, `akm registry add-kit`,
`akm clone --to`, `akm config edit`, `akm config sources remove`) were
removed — see `manual-qa-2026-04-25.md` for the audit.

---

## 1. Sandbox Setup

Every section below assumes an isolated environment. Never run manual tests
against your real config — they will mutate the working stash.

```sh
# 1.1 Build a fresh binary from the current branch
bun install
bun run build       # or use `bun run src/cli.ts ...` directly below

# 1.2 Create an isolated sandbox
export AKM_SANDBOX="$(mktemp -d /tmp/akm-sandbox.XXXXXX)"
export XDG_CONFIG_HOME="$AKM_SANDBOX/config"
export XDG_CACHE_HOME="$AKM_SANDBOX/cache"
export XDG_DATA_HOME="$AKM_SANDBOX/data"
export AKM_STASH_DIR="$AKM_SANDBOX/stash"
mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$AKM_STASH_DIR"

# 1.3 Convenience alias for this session
alias akm='bun run /home/founder3/code/github/itlackey/agentikit/src/cli.ts'

# 1.4 Verify the sandbox is wired up
akm init | jq '.stashDir, .configPath'
# expect both paths to live under $AKM_SANDBOX
```

To tear down: `rm -rf "$AKM_SANDBOX"` and `unset AKM_SANDBOX XDG_CONFIG_HOME
XDG_CACHE_HOME XDG_DATA_HOME AKM_STASH_DIR`.

> Note: `akm info` does not currently surface `stashDir` or `configPath` —
> use `akm init` (idempotent) for that.

---

## 2. Fixtures

The repo ships pre-built ranking fixtures at `tests/fixtures/stashes/ranking-baseline/`.
Use them as a synthetic stash so search/show output is deterministic.

```sh
# 2.1 Mirror the fixture stash into the sandbox
cp -r tests/fixtures/stashes/ranking-baseline/* "$AKM_STASH_DIR/"
ls "$AKM_STASH_DIR"
# expect: agents commands knowledge memories scripts skills vaults wikis workflows
```

Fixture inventory you can search/show against:

| Type      | Ref                                     |
|-----------|-----------------------------------------|
| skill     | `skill:code-review-skill`               |
| skill     | `skill:k8s-deploy`                      |
| skill     | `skill:docker-homelab`                  |
| skill     | `skill:svelte-components`               |
| knowledge | `knowledge:skill-library-evolution`     |
| knowledge | `knowledge:incident-response-runbook`   |
| agent     | `agent:code-reviewer`                   |
| agent     | `agent:svelte-expert`                   |
| command   | `command:release-manager`               |
| command   | `command:security-review`               |

For migration scenarios (§13) you'll also seed extra config files; those are
introduced inline.

---

## 3. Init and First Run

- [ ] `akm init` — runs without prompting in a fresh sandbox; succeeds and
      reports `stashDir`, `configPath`, and `ripgrep.installed`.
- [ ] `akm info` — emits JSON with `schemaVersion`, `assetTypes`,
      `searchModes`, `semanticSearch`, `registries`, `indexStats`. The
      `sourceProviders` field is currently empty `[]` until at least one
      source is configured.
- [ ] `akm config list` — emits config; key is `sources` (not `stashes`).
- [ ] `akm hints` — prints non-empty agent hint text, no errors.
- [ ] `akm --help` — top-level help lists exactly the locked CLI surface
      (`add`, `remove`, `list`, `update`, `search`, `show`, `clone`, `index`,
      `setup`, `remember`, `import`, `feedback`, `registry`, plus `info`,
      `curate`, `workflow`, `vault`, `wiki`, `enable`, `disable`,
      `completions`, `upgrade`, `save`, `help`, `hints`).
- [ ] `akm enable --help` mentions `(skills.sh)` only — `context-hub` is
      not a separate component (it's just a git source).

---

## 4. Index and Search

- [ ] `akm index --full` — reports a non-zero entry count; mentions
      `semantic-search` mode in the verification summary.
- [ ] `akm search docker` — returns at least one hit; result is in
      `hits[]`, never `registryHits[]`.
- [ ] `akm search docker --format json | jq '.hits | length'` — matches the
      visible count.
- [ ] `akm search "code review" --type skill` — at least one result; all
      results have `type: "skill"`.
- [ ] `akm search code --source registry` — does NOT mix in stash hits;
      `hits[]` is empty if no registry is configured, `registryHits[]`
      carries any matches. Default config ships two registries (`official`,
      `skills.sh`) so expect non-empty `registryHits[]`.
- [ ] `akm search code --source both` — emits both `hits[]` and
      `registryHits[]`.
- [ ] Re-run `akm index` (no flag) — incremental mode; entry count stable;
      faster than the `--full` run.

> Known issue: a clearly nonsense query (e.g. `akm search nonexistent-token-9999`)
> currently returns the full fixture set instead of zero hits because the
> semantic ranker has no minimum score floor. Tracked in
> `manual-qa-2026-04-25.md` issue [6]. Don't treat that as a passing case.

---

## 5. Show

- [ ] `akm show skill:k8s-deploy` — renders the skill body with
      `{type, name, origin, action, content}`.
- [ ] `akm show skill:k8s-deploy --format text` — renders the markdown body
      directly.
- [ ] `akm show skill:does-not-exist` — fails with
      `{ok:false, error:"Stash asset not found...", code:"ASSET_NOT_FOUND"}`
      on stderr; non-zero exit. (See known issue [8] / [13] in the QA report:
      no `hint` field today, and exit code is 78 rather than 1.)
- [ ] `akm show knowledge:incident-response-runbook section "Severity Levels"`
      — narrows to the named section. A non-existent heading returns a
      "Section ... not found" message and points at the toc view.
- [ ] `akm show knowledge:incident-response-runbook toc` — prints a table
      of contents (line-numbered headings), not the body.

---

## 6. Source Management

For each kind, perform: add → list → search → update (where applicable) →
remove.

### 6.1 Filesystem source

- [ ] `mkdir -p "$AKM_SANDBOX/extra-stash" && akm add "$AKM_SANDBOX/extra-stash"` —
      succeeds and triggers an incremental index.
- [ ] `akm list --format json | jq '.sources[]'` — entry has
      `kind: "local"` (the v1 spec calls this `filesystem`; tracked as a
      contract drift in QA issue [10]), `path` set, and `writable: false`
      in the rendered output. Writes default to allowed at runtime
      regardless — see §7.
- [ ] `akm remove "$AKM_SANDBOX/extra-stash"` — succeeds; `akm list` no
      longer shows it. (At present, `--name <foo>` on `akm add` is dropped
      for filesystem sources, so remove using the path. Tracked in QA
      issue [9].)

### 6.2 Git source

- [ ] `akm add github:<owner>/<repo>` against any small public skills repo
      you have access to. First run clones; subsequent runs no-op.
- [ ] `akm list` shows `kind: "git"`; `writable` defaults to false.
- [ ] `akm update <name>` — fetches latest; output reports the cache state.
- [ ] `akm search <something-from-the-repo>` — matches surface from the
      cloned content under `$XDG_CACHE_HOME/akm/...`.
- [ ] `akm remove <name>` — succeeds; cache dir cleaned up.

### 6.3 npm source

- [ ] `akm add npm:<small-skills-package>`. Verify install logs and cache
      directory.
- [ ] `akm list` shows `kind: "npm"`; `writable` defaults to false.
- [ ] `akm remove <name>` — succeeds.

### 6.4 Website source

- [ ] `akm add https://example-skills-site.dev --name docs-site` — adds a
      website source. (The `--name` flag IS honored on website/git/npm
      sources today, even though it's dropped for filesystem.)
- [ ] `akm list` shows `kind: "remote"` (spec calls this `website`;
      tracked as contract drift in QA issue [17]); `writable` defaults to
      false.
- [ ] `akm update docs-site` — currently fails with `TARGET_NOT_UPDATABLE`
      because the website provider is treated as live-only. Tracked in QA
      issue [19]; expect this to start re-mirroring once fixed.

### 6.5 Writable rejection

- [ ] Manually edit `$XDG_CONFIG_HOME/akm/config.json`; add a
      `"writable": true` to a `npm` or `website` source.
- [ ] Run `akm list`. Expect a `ConfigError` with hint mentioning
      `writable: true is only supported on filesystem and git sources`.
- [ ] Revert the edit; verify `akm list` succeeds again.

---

## 7. Write Commands

These exercise `core/write-source.ts` (the single dispatch site for
`source.kind` branching).

### 7.1 remember (default target)

- [ ] `akm remember "test memory body" --name test-memory` — writes to
      working stash. `akm show memory:test-memory` finds it.
- [ ] `akm remember "another" --name test-2 --tag foo --tag bar` —
      frontmatter contains both tags. (Note: `--description` is currently
      not persisted; tracked in QA issue [20]. Re-add to this checklist
      once fixed.)
- [ ] `echo "stdin body" | akm remember --name from-stdin` — reads from
      stdin successfully.

### 7.2 remember (--target)

- [ ] Add a second writable filesystem source: `mkdir -p "$AKM_SANDBOX/alt"
      && akm add "$AKM_SANDBOX/alt"`.
- [ ] `akm remember "to alt" --name alt-mem --target "$AKM_SANDBOX/alt"` —
      file appears under `$AKM_SANDBOX/alt/memories/alt-mem.md`. Use the
      full path as `--target` until QA issue [9] (`--name` drop) is fixed.
- [ ] `akm remember "x" --name y --target nonexistent` — fails with
      `INVALID_FLAG_VALUE` and message `--target must reference a source
      name from your config`.
- [ ] Set `"writable": false` on the alt source by hand, run
      `akm remember ... --target "$AKM_SANDBOX/alt"`. Expect a
      `ConfigError` saying `source ... is not writable` with a hint to set
      `writable: true`.

### 7.3 defaultWriteTarget (currently unsupported via CLI)

- The config loader (`src/core/config.ts`) reads `defaultWriteTarget`, but
  `akm config set/get/unset defaultWriteTarget` all fail with
  `Unknown config key`. Tracked in QA issue [21]. Until that lands, set it
  by hand in `config.json` if you need to exercise this path:
  ```sh
  jq '.defaultWriteTarget = "/full/path/to/source"' \
    "$XDG_CONFIG_HOME/akm/config.json" > /tmp/c && \
    mv /tmp/c "$XDG_CONFIG_HOME/akm/config.json"
  ```
- [ ] Confirm `akm remember "via default" --name via-default` lands in the
      configured source.

### 7.4 import

- [ ] Create a markdown file at `$AKM_SANDBOX/incoming.md` with a heading
      and body.
- [ ] `akm import "$AKM_SANDBOX/incoming.md" --type knowledge --name
      imported-doc` — file appears under `knowledge/imported-doc.md` in
      the working stash.
- [ ] `akm import "$AKM_SANDBOX/incoming.md" --type knowledge --name
      to-alt --target "$AKM_SANDBOX/alt"` — lands in alt.
- [ ] `akm import does-not-exist.md ...` — clean error
      (`Knowledge source not found...`); no stack trace.

### 7.5 git-source writes

(Only if you ran §6.2 with a writable git remote you control.)

- [ ] Configure the source with `"writable": true`. `akm remember "git-side"
      --target <git-source-name>` should commit (and optionally push). The
      commit message comes from `writeAssetToSource`.

---

## 8. Curate

- [ ] `akm curate "review this PR for security issues"` — returns a curated
      bundle. Top-level keys are `{items, query, summary}`.
- [ ] `akm curate "..." --format json | jq '.items | length'` — non-zero.
- [ ] An empty string currently does NOT raise — it returns ranked items
      (QA issue [24]). Don't include `akm curate ""` as a passing case
      until that fails as a `UsageError`.

---

## 9. Clone

- [ ] `akm clone skill:k8s-deploy --dest "$AKM_SANDBOX/clone-target"` —
      copies the asset (and any siblings under the same dir) into the
      destination. Note the flag is `--dest`, not `--to`.
- [ ] `akm clone skill:does-not-exist --dest "$AKM_SANDBOX/clone-doomed"` —
      fails with `ASSET_NOT_FOUND` (current message leaks "Stash type
      root", QA issue [27]).

---

## 10. Registry

These need a registry configured. The default config ships
`https://raw.githubusercontent.com/itlackey/akm-registry/main/index.json`
and `https://skills.sh` so `registry list` and `registry search` will work
out of the box (network required).

- [ ] `akm registry list` — shows the configured registries.
- [ ] `akm registry search docker --detail full` — emits `hits[]` from the
      registries; each entry has `type: "registry"`, `installRef`, `score`.
      (Default `--detail brief` currently strips every field — QA issue
      [28]; use `--detail full` until fixed.)
- [ ] `akm registry add https://registry.example/index.json --name test-reg`
      (against any small test registry index URL). Then
      `akm registry list` shows the new registry, and
      `akm registry remove test-reg` cleans up.
- [ ] Install a kit by passing its `installRef` to `akm add`
      (`akm add github:<owner>/<repo>` etc.). `akm registry add-kit` is
      not a real subcommand.

---

## 11. Workflows

Workflows are a state-machine: `start` → `next` → `complete`, with `status`
to inspect and `resume` to unblock. There is no `show` and no
`run --dry-run`.

- [ ] `akm workflow list` — lists any active runs (empty after a fresh
      sandbox).
- [ ] `akm workflow template > "$AKM_STASH_DIR/workflows/test.md"` — drops
      a valid template into the stash. The template includes the required
      `# Workflow:` heading, `## Step:` sections, `Step ID:` lines, plus
      `### Instructions` and `### Completion Criteria`.
- [ ] `akm index --full` so the indexer picks the workflow up.
- [ ] `akm workflow start workflow:test` — starts a run; output includes
      a `run.id`, `run.workflowRef`, and the `workflow.steps[]` array.
- [ ] `akm workflow status <run-id>` — shows current state.
- [ ] `akm workflow next workflow:test` — surfaces the next actionable
      step.

---

## 12. Wiki

- [ ] `akm wiki list` — empty initially.
- [ ] `akm wiki create my-wiki` — creates `wikis/my-wiki/{schema,index,log}.md`
      and a `raw/.gitkeep`.
- [ ] `akm wiki list` — shows `my-wiki` with page/raw counts.
- [ ] Add a markdown page under the wiki dir; `akm wiki lint my-wiki` —
      surfaces structural issues or passes.
- [ ] `akm wiki remove my-wiki --force` — `--force` is required; without
      it the command refuses with a USAGE-style error.

---

## 13. Vault

The vault verbs are `create | set | unset | list | show | load`. There is
no `vault add` / `vault remove` (those are for keys, not vaults). Setting
a key always uses `vault set vault:<name> KEY=VALUE`.

- [ ] `akm vault list` — empty initially.
- [ ] `akm vault create test-vault` — creates `vaults/test-vault.env`.
- [ ] `akm vault set vault:test-vault MY_KEY=secret-value
      --comment "test secret"` — succeeds; output mentions ref, key, path.
      Open the file: comment is written above the key.
- [ ] `akm vault list vault:test-vault` — returns `{keys, comments}`
      arrays. **Values are never printed.**
- [ ] `akm vault list vault:test-vault --format json` — confirm `value`
      key is absent.
- [ ] `akm vault unset vault:test-vault MY_KEY` — removes the key.

---

## 14. Config Edits

Config keys settable via the CLI today (per `src/commands/config-cli.ts`):
`stashDir`, `semanticSearchMode`, `embedding`, `llm`, `registries`,
`sources`, `output.format`, `output.detail`, plus the
`security.installAudit.*` family. Subkeys like `llm.endpoint` and
`defaultWriteTarget` are not whitelisted — pass the whole-section JSON
or edit `config.json` by hand.

- [ ] `akm config list` — reports working state.
- [ ] `akm config set llm '{"endpoint":"http://localhost:1234/v1"}'` —
      persists the whole `llm` section.
- [ ] `akm config get llm` — reads back.
- [ ] `akm config unset llm` — removes.
- [ ] There is no `akm config edit`. To hand-edit, open
      `$XDG_CONFIG_HOME/akm/config.json` directly.

---

## 15. Migration Scenarios

These exercise the v0.5 → v0.6 / v1 migration paths. Recover from any
mid-test breakage by rebuilding the sandbox (§1).

### 15.1 Legacy `stashes[]` config

- [ ] Replace `$XDG_CONFIG_HOME/akm/config.json` with a config that uses
      the legacy key:
      ```json
      {
        "stashDir": "/tmp/akm-sandbox.XXX/stash",
        "stashes": [
          { "type": "filesystem", "path": "/tmp/akm-sandbox.XXX/extra", "name": "extra" }
        ]
      }
      ```
- [ ] `akm list` — succeeds; emits a deprecation warning on stderr that
      mentions `stashes` and points at `sources`. The source is loaded.
- [ ] Run any command that persists config (e.g.
      `akm config set output.format text`). The file is rewritten with
      `sources[]`; no `stashes[]` left behind.

### 15.2 OpenViking removal

- [ ] Inject `{ "type": "openviking", "name": "ov", "url": "..." }` into
      the `sources[]` array.
- [ ] Run any command that loads config (`akm list`). Expect a
      `ConfigError` whose message points at `docs/migration/v1.md` and a
      hint that recommends removing the source. (The current hint text
      references `akm config sources remove ov`, which is not a real
      subcommand — the supported remediation is `akm remove ov` or
      hand-editing `config.json`.)
- [ ] Remove the OpenViking entry; commands work again.

### 15.3 `writable: true` rejection

- [ ] Already covered in §6.5; re-verify with `npm` and `website` kinds in
      turn.

### 15.4 Migration help

- [ ] `akm help migrate 0.6.0` — prints the bundled release notes from
      `docs/migration/release-notes/0.6.0.md`.
- [ ] `akm help migrate latest` — picks the highest numeric release notes
      file.
- [ ] `akm help migrate 9.9.9` — graceful "no dedicated note" message
      that lists the bundled notes and a link to the changelog.

---

## 16. Error Handling

Spot-check that error responses are structured and exit non-zero. Each
should land on stderr as a JSON envelope `{ok:false, error, code, hint?}`
and exit non-zero. The `hint` field is optional and is currently emitted
inconsistently (writable-rejection and OpenViking errors carry one;
not-found errors don't — tracked in QA issue [8]).

- [ ] `akm search` (no query) currently returns hits instead of erroring
      (QA issue [14]). Don't treat as a passing case until it raises.
- [ ] `akm show foo` — bad ref shape — emits
      `Invalid ref "foo". Expected [origin//]type:name` with code
      `INVALID_FLAG_VALUE`, exit non-zero.
- [ ] `akm show skill:does-not-exist` — `ASSET_NOT_FOUND`, exit non-zero.
- [ ] `akm config set sources weird-thing` — emits
      `Invalid value for sources/stashes: expected JSON array...`, exit
      non-zero. Note the current message still references the legacy key
      "stashes" (QA issue [16]).
- [ ] `akm remember --target unknown ...` — `INVALID_FLAG_VALUE` with a
      message naming the invalid target.

If any error reaches the user as a bare stack trace, that's a regression.

---

## 17. Format Round-Trip

For every command emitting structured output, confirm `--format json` is
parseable:

```sh
for cmd in 'list' 'search docker' 'show skill:k8s-deploy' 'info' \
           'config list' 'curate "review code"'; do
  echo "=== $cmd ==="
  akm $cmd --format json | jq -e . > /dev/null && echo OK || echo "BROKEN"
done
```

- [ ] All `OK`, none `BROKEN`.

---

## 18. Sandbox Cleanup

```sh
rm -rf "$AKM_SANDBOX"
unset AKM_SANDBOX XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME AKM_STASH_DIR
unalias akm
```

- [ ] No errors. Real config (`~/.config/akm/`) untouched.

---

## When to Run This

- **Before tagging a release** — full pass.
- **After merging a phase** that touched CLI surface or write
  path — sections 4, 5, 7, 13, 16 minimum.
- **After dependency bumps that affect runtime** (Bun, sqlite-vec,
  transformers) — sections 4, 8 to confirm semantic search still works.

Record run results in `docs/migration/release-notes/<version>.md` under a
"Manual QA" subsection if the release introduces user-visible changes.
