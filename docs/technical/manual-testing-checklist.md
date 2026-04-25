# Manual Testing Checklist

Use this checklist to exercise akm v0.6.0 in a sandbox against known fixtures
before cutting a release. Pair it with the automated suites described in
`testing-workflow.md` and `test-coverage-guide.md` — manual coverage focuses on
end-to-end UX (output formatting, prompt flows, error messages) that the unit
tests don't fully cover.

Time budget: ~30 minutes for a full pass on a fresh sandbox.

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
mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME"

# 1.3 Convenience alias for this session
alias akm='bun run /home/founder3/code/github/itlackey/agentikit/src/cli.ts'

# 1.4 Verify the sandbox is wired up
akm info --format json | jq '.stashDir, .configPath'
# expect both paths to live under $AKM_SANDBOX
```

To tear down: `rm -rf "$AKM_SANDBOX"` and `unset AKM_SANDBOX XDG_CONFIG_HOME
XDG_CACHE_HOME XDG_DATA_HOME AKM_STASH_DIR`.

---

## 2. Fixtures

The repo ships pre-built ranking fixtures at `tests/ranking-fixtures/stash/`.
Use them as a synthetic stash so search/show output is deterministic.

```sh
# 2.1 Mirror the fixture stash into the sandbox
cp -r tests/ranking-fixtures/stash/* "$AKM_STASH_DIR/"
ls "$AKM_STASH_DIR"
# expect: agents/  commands/  knowledge/  scripts/  skills/
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

- [ ] `akm init` — runs without prompting in a fresh sandbox; succeeds.
- [ ] `akm info` — reports `stashDir` under `$AKM_SANDBOX`, lists registered
      `sourceProviders` (includes `filesystem`, `git`, `npm`, `website`), no
      `openviking`.
- [ ] `akm config show` — emits config; key is `sources` (not `stashes`).
- [ ] `akm hints` — prints non-empty agent hint text, no errors.
- [ ] `akm --help` — top-level help lists exactly the locked CLI surface
      (`add`, `remove`, `list`, `update`, `search`, `show`, `clone`, `index`,
      `setup`, `remember`, `import`, `feedback`, `registry`, plus `info`,
      `curate`, `workflow`, `vault`, `wiki`, `enable`, `disable`,
      `completions`, `upgrade`, `save`, `help`, `hints`).

---

## 4. Index and Search

- [ ] `akm index --full` — reports a non-zero entry count; mentions
      `semantic-search` mode in the summary line.
- [ ] `akm search docker` — returns at least one hit; result is in
      `hits[]`, never `registryHits[]`.
- [ ] `akm search docker --format json | jq '.hits | length'` — matches the
      visible count.
- [ ] `akm search nonexistent-token-9999` — returns zero hits and the
      "no matches" tip is rendered (not a stack trace).
- [ ] `akm search "code review" --type skill` — at least one result; all
      results have `type: "skill"`.
- [ ] `akm search code --source registry` — does NOT mix in stash hits;
      `hits[]` is empty if no registry is configured, `registryHits[]` carries
      any matches. Warnings explain missing registries.
- [ ] `akm search code --source both` — emits both `hits[]` and `registryHits[]`.
- [ ] Re-run `akm index` (no flag) — incremental mode; entry count stable;
      faster than the `--full` run.

---

## 5. Show

- [ ] `akm show skill:k8s-deploy` — renders the skill body; footer shows
      `editable: true` (filesystem source).
- [ ] `akm show skill:k8s-deploy --format json` — `path` field points to the
      fixture file under `$AKM_STASH_DIR`.
- [ ] `akm show skill:does-not-exist` — clean `NotFoundError` with hint;
      exit code 1.
- [ ] `akm show knowledge:incident-response-runbook section "Response Steps"`
      — narrows to the named section if present; gracefully empty otherwise.
- [ ] `akm show knowledge:incident-response-runbook toc` — prints a table
      of contents, not the body.

---

## 6. Source Management

For each kind, perform: add → list → search → update → remove.

### 6.1 Filesystem source

- [ ] `mkdir -p "$AKM_SANDBOX/extra-stash" && akm add "$AKM_SANDBOX/extra-stash" --name extra` — succeeds.
- [ ] `akm list --format json | jq '.sources[] | select(.name=="extra")'` —
      kind is `filesystem`, `writable` defaults to `true`.
- [ ] `akm remove extra` — succeeds; `akm list` no longer shows it.

### 6.2 Git source

- [ ] `akm add github:itlackey/akm-skills --name akm-skills` (or any
      small public skills repo). First run clones; subsequent runs no-op.
- [ ] `akm list` shows kind `git`; `writable` defaults to `false`.
- [ ] `akm update akm-skills` — fetches latest; output reports rev change.
- [ ] `akm search <something-from-the-repo>` — matches surface from the
      cloned content under `$XDG_CACHE_HOME/akm/...`.
- [ ] `akm remove akm-skills` — succeeds; cache dir cleaned up.

### 6.3 npm source

- [ ] `akm add npm:agentikit-skills` (or any small skills package). Verify
      install logs and cache directory.
- [ ] `akm list` shows kind `npm`; `writable` defaults to `false`.
- [ ] `akm remove agentikit-skills` — succeeds.

### 6.4 Website source

- [ ] `akm add https://example-skills-site.dev --name docs-site` — adds a
      website source (cache-backed mirror).
- [ ] `akm list` shows kind `website`; `writable` defaults to `false`.
- [ ] `akm update docs-site` — re-mirrors.

### 6.5 Writable rejection

- [ ] Manually edit `$XDG_CONFIG_HOME/akm/config.json`; add a `"writable": true`
      to a `npm` or `website` source.
- [ ] Run `akm list`. Expect `ConfigError` with hint mentioning
      `writable: true is only supported on filesystem and git sources`.
- [ ] Revert the edit; verify `akm list` succeeds again.

---

## 7. Write Commands

These exercise `core/write-source.ts` (the single dispatch site for
`source.kind` branching).

### 7.1 remember (default target)

- [ ] `akm remember "test memory body" --name test-memory` — writes to
      working stash. `akm show memory:test-memory` finds it.
- [ ] `akm remember "another" --name test-2 --tag foo --tag bar
      --description "two-tag memory"` — frontmatter contains both tags and
      the description.
- [ ] `echo "stdin body" | akm remember --name from-stdin` — reads from
      stdin successfully.

### 7.2 remember (--target)

- [ ] Add a second writable filesystem source: `mkdir -p
      "$AKM_SANDBOX/alt" && akm add "$AKM_SANDBOX/alt" --name alt`.
- [ ] `akm remember "to alt" --name alt-mem --target alt` — file appears
      under `$AKM_SANDBOX/alt/memories/alt-mem.md`, NOT under the working
      stash.
- [ ] `akm remember "x" --name y --target nonexistent` — `UsageError`
      with hint `Run \`akm list\` to see available sources`.
- [ ] Mark `alt` as non-writable in config (`"writable": false`); run
      `akm remember "x" --name z --target alt` — `ConfigError` saying
      `source alt is not writable`.

### 7.3 defaultWriteTarget

- [ ] `akm config set defaultWriteTarget alt` (revert writable first).
- [ ] `akm remember "via default" --name via-default` — file lands in
      `alt`, not the working stash.
- [ ] `akm config unset defaultWriteTarget`.

### 7.4 import

- [ ] Create a markdown file at `$AKM_SANDBOX/incoming.md` with a heading
      and body.
- [ ] `akm import "$AKM_SANDBOX/incoming.md" --type knowledge --name
      imported-doc` — file appears under `knowledge/imported-doc.md` in
      the working stash.
- [ ] `akm import "$AKM_SANDBOX/incoming.md" --type knowledge --name
      to-alt --target alt` — lands in `alt`.
- [ ] `akm import does-not-exist.md ...` — clean error, no stack trace.

### 7.5 git-source writes

(Only if you ran §6.2 with a writable git remote you control.)

- [ ] Configure the source with `"writable": true`. `akm remember "git-side"
      --target <git-source-name>` should commit (and optionally push). The
      commit message comes from `writeAssetToSource`.

---

## 8. Curate

- [ ] `akm curate "review this PR for security issues"` — returns a curated
      bundle ranked across types. Output mentions matching skills/agents/
      knowledge.
- [ ] `akm curate "..." --format json | jq '.assets | length'` — non-zero.
- [ ] Pass an empty string — clean `UsageError`.

---

## 9. Clone

- [ ] `akm clone skill:k8s-deploy --to "$AKM_SANDBOX/clone-target"` — copies
      the asset (and any siblings under the same dir) into the destination.
- [ ] `akm clone skill:does-not-exist ...` — clean error.

---

## 10. Registry

These need a registry configured. Use the bundled `static-index` against a
small test registry index URL, or a `skills-sh` mirror if accessible.

- [ ] `akm registry add https://registry.example/index.json --name test-reg` —
      adds a registry entry.
- [ ] `akm registry list` — shows the new registry.
- [ ] `akm registry search docker` — emits `kits[]` from the registry; each
      entry has `type: "registry"` and an `installRef`.
- [ ] `akm registry add-kit <kit-id-from-search>` (or `akm add <installRef>`)
      — installs the kit's referenced source.
- [ ] `akm registry remove test-reg` — clean removal.

---

## 11. Workflows

- [ ] `akm workflow list` — lists any fixture workflows or empty list.
- [ ] Create a simple workflow file under `$AKM_STASH_DIR/workflows/test.md`
      with the `# Workflow: <title>` heading required by the parser.
- [ ] `akm index` to pick it up.
- [ ] `akm workflow show test` — renders the workflow steps.
- [ ] `akm workflow run test --dry-run` — prints planned step execution
      without side effects.

---

## 12. Wiki

- [ ] `akm wiki list` — empty initially.
- [ ] `akm wiki create my-wiki` — creates wiki structure.
- [ ] `akm wiki list` — shows `my-wiki`.
- [ ] Add a markdown page under the wiki dir; `akm wiki lint my-wiki` —
      surfaces or passes.
- [ ] `akm wiki remove my-wiki`.

---

## 13. Vault

- [ ] `akm vault list` — empty initially.
- [ ] `akm vault add MY_KEY --comment "test secret"` — prompts for a value.
- [ ] `akm vault list` — shows `MY_KEY` with the comment; values are NEVER
      printed in any format.
- [ ] `akm vault list --format json` — confirms values absent from JSON
      output.
- [ ] `akm vault remove MY_KEY`.

---

## 14. Config Edits

- [ ] `akm config show` — reports working state.
- [ ] `akm config set llm.endpoint http://localhost:1234/v1` — persists.
- [ ] `akm config get llm.endpoint` — reads back.
- [ ] `akm config unset llm.endpoint` — removes.
- [ ] `akm config edit` — opens `$EDITOR` (or noted if `$EDITOR` unset).

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
- [ ] `akm list` — succeeds; emits a deprecation warning mentioning `stashes`
      and pointing at `sources`. The source is loaded.
- [ ] `akm config set defaultWriteTarget alt` (any write that persists config)
      — config is rewritten with `sources[]`, no `stashes[]` left behind.

### 15.2 OpenViking removal

- [ ] Inject `{ "type": "openviking", "name": "ov", "url": "..." }` into the
      `sources[]` array.
- [ ] Run any command that loads config (`akm list`). Expect `ConfigError`
      pointing at `docs/migration/v1.md` with the remediation hint
      (`akm config sources remove ov` or downgrade).
- [ ] Remove the OpenViking entry; commands work again.

### 15.3 `writable: true` rejection

- [ ] Already covered in §6.5; re-verify with `npm` and `website` kinds in
      turn.

### 15.4 Migration help

- [ ] `akm help migrate 0.6.0` — prints the bundled release notes from
      `docs/migration/release-notes/0.6.0.md`.
- [ ] `akm help migrate latest` — picks the highest numeric release notes
      file.
- [ ] `akm help migrate 9.9.9` — graceful "no dedicated note" message.

---

## 16. Error Hints

Each error class should surface a hint without `--verbose`. Spot-check:

- [ ] `akm search` (no query) — `UsageError`; help mentions the missing arg.
- [ ] `akm show foo` (bad ref shape) — `UsageError`; hint references
      `type:name` form.
- [ ] `akm show skill:does-not-exist` — `NotFoundError` with hint.
- [ ] `akm config set sources weird-thing` — `UsageError` for the JSON
      requirement, with hint.
- [ ] `akm remember --target unknown ...` (covered in §7.2) — `UsageError`
      with `Run \`akm list\`` hint.

If any error reaches the user as a bare stack trace, that's a regression in
the `hint()` chain set up in Phase 7.

---

## 17. Format Round-Trip

For every command emitting structured output, confirm `--format json` is
parseable:

```sh
for cmd in 'list' 'search docker' 'show skill:k8s-deploy' 'info' \
           'config show' 'curate "review code"'; do
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
- **After merging a phase** that touched CLI surface, error chain, or write
  path — sections 4, 5, 7, 13, 16 minimum.
- **After dependency bumps that affect runtime** (Bun, sqlite-vec, transformers) —
  sections 4, 8 to confirm semantic search still works.

Record run results in `docs/migration/release-notes/<version>.md` under a
"Manual QA" subsection if the release introduces user-visible changes.
