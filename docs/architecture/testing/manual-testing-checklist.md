# AKM Manual Testing Runbook

This is the authoritative manual QA document for AKM `0.9.x`. Other testing
documents describe automation and internals; this document owns manual test
scope, setup, expected behavior, evidence, and release-facing gates.

Last audited against the implementation: **2026-08-05** (`0.9.0-rc.15`).

## Table of Contents

- [1. Purpose and Use](#1-purpose-and-use)
- [2. Safety and Prerequisites](#2-safety-and-prerequisites)
- [3. Sandbox Setup](#3-sandbox-setup)
- [4. Fixtures and Local Services](#4-fixtures-and-local-services)
- [5. Fast Offline Pass](#5-fast-offline-pass)
- [6. Startup, Setup, Help, and Config](#6-startup-setup-help-and-config)
- [7. Index, Search, Curate, and Show](#7-index-search-curate-and-show)
- [8. Output, Errors, and Exit Codes](#8-output-errors-and-exit-codes)
- [9. Bundles, Adapters, Sources, and Registries](#9-bundles-adapters-sources-and-registries)
- [10. Writes, Import, Clone, and Sync](#10-writes-import-clone-and-sync)
- [11. Env and Secret](#11-env-and-secret)
- [12. Lint](#12-lint)
- [13. Feedback, Log, and Health](#13-feedback-log-and-health)
- [14. Workflow](#14-workflow)
- [15. Task](#15-task)
- [16. Proposal Queue](#16-proposal-queue)
- [17. Agent, LLM, and Improve](#17-agent-llm-and-improve)
- [18. Semantic Search](#18-semantic-search)
- [19. Migration, Durability, and Concurrency](#19-migration-durability-and-concurrency)
- [20. Security and Adversarial Testing](#20-security-and-adversarial-testing)
- [21. Package, Runtime, Platform, and Release](#21-package-runtime-platform-and-release)
- [22. Evidence and Cleanup](#22-evidence-and-cleanup)
- [23. Change-Based Test Selection](#23-change-based-test-selection)
- [24. Known Constraints and Blocked Gates](#24-known-constraints-and-blocked-gates)

---

## 1. Purpose and Use

### 1.1 Scope

This runbook covers:

- CLI startup, help, setup, config, output shaping, and error classification.
- Indexing, ranking, search, curate, show, refs, fragments, and usage tracking.
- Every built-in bundle adapter and every supported source provider.
- Writes, target precedence, git publication, envs, secrets, and redaction.
- Workflow, task, proposal, agent, LLM, and improve behavior.
- Semantic search, migration, crash recovery, locking, and concurrent processes.
- npm packages, standalone binaries, installers, self-upgrade, schedulers, and
  release artifacts.
- Security boundaries including SSRF, path traversal, symlinks, dangerous env
  keys, malformed input, rollback, and partial publication.

This is a catalog, not an instruction to run every gate for every change. Use
[Change-Based Test Selection](#23-change-based-test-selection) to choose scope.

### 1.2 Test tiers

Every check carries one or more labels.

| Label | Meaning | Typical time | Token/network cost |
| --- | --- | ---: | --- |
| **[CORE]** | Fast deterministic offline gate | 25-35 min | None |
| **[LOCAL]** | Extended local filesystem/process gate | +45-75 min | None |
| **[SERVICE]** | Controlled loopback fixture services | +15-25 min | None |
| **[LIVE]** | Controlled public git/npm/HTTPS service | +15-30 min | Network only |
| **[AI]** | Fake or bounded real agent/LLM checks | +15-30 min | Fake: none; real: bounded |
| **[PLATFORM]** | Native OS/runtime/install checks | Per platform | Runner/VM time |
| **[DESTRUCTIVE]** | Crash, migration, and recovery rehearsal | 1-3 hr | Disposable VM only |
| **[RELEASE]** | Exact package and release-artifact acceptance | 1-3 hr | CI/VM/network |

### 1.3 Result states

Use these states exactly:

| Status | Meaning |
| --- | --- |
| `PASS` | Behavior, exit code, output, and side effects match the stated expectation. |
| `FAIL` | Any observable result differs. |
| `BLOCKED` | A named prerequisite is unavailable. Record it. |
| `N/A` | The target platform genuinely does not support the surface. |

Do not turn an implementation defect into an expected result. Some adversarial
gates below intentionally expose unresolved behavior. A release waiver must name
the issue, impact, owner, and expiry.

### 1.4 Evidence header

Record this once per run:

```text
commit:
package version:
artifact digest (when applicable):
OS / architecture:
Bun / Node versions:
CLI invocation path:
sandbox path:
tiers run:
started / finished UTC:
tester:
```

For every failure retain the command, exit code, stdout, stderr, relevant file
or database diff, and whether a second identical run reproduced it. Never
attach real credentials or unredacted env/secret payloads.

---

## 2. Safety and Prerequisites

### 2.1 Non-negotiable safety rules

- [ ] Use a disposable shell and preferably a disposable clean worktree.
- [ ] Isolate `HOME`, all four `XDG_*_HOME` variables, all four `AKM_*_DIR`
      variables, temp files, GitHub CLI config, Git config, npm config/cache,
      and Hugging Face cache under one sandbox root.
- [ ] Set `AKM_CONFIG_DIR`. It overrides `XDG_CONFIG_HOME`; omitting it can
      overwrite a real config before path verification.
- [ ] Clear inherited AKM debug/registry settings and provider, agent, GitHub,
      LLM, and embedding credentials.
- [ ] Set both `AKM_FORCE_SETUP_TMP_STASH=1` and
      `AKM_FORCE_INIT_TMP_STASH=1`; setup and bundle-create use separate guards.
- [ ] Use `dist/akm` for release-facing checks. Use `bun ./src/cli.ts` only when
      intentionally validating source execution.
- [ ] Never run `akm upgrade`, native scheduler mutation, migration failure
      injection, or kill-point tests on the developer account or host install.
- [ ] Never point `akm sync` at a real writable remote.
- [ ] Never use production secrets as fixtures.
- [ ] Do not use internal migration test-hook variables manually. Run the
      shipped recovery suites or use a dedicated disposable recovery harness.
- [ ] Guard recursive cleanup with the exact sandbox prefix.

The sandbox isolates AKM state. `bun install` and `bun run build` still operate
inside the checkout, so release QA should use a disposable worktree and start
from a clean `git status`.

### 2.2 Prerequisites

**[CORE]** and **[LOCAL]** require Bash, Bun, Node.js 22+, Git, `jq`, standard
POSIX filesystem tools, and the repository checkout.

| Gate | Additional prerequisite |
| --- | --- |
| YAML parsing | Repository `yaml` dependency |
| Git source/sync | Disposable remote or local no-push repository |
| npm source | Disposable package/version or controlled registry |
| Production website | Controlled public HTTPS hostname; loopback is blocked |
| Local semantic model | Cold-download network, disk, isolated `HF_HOME` |
| Docker | Docker/BuildKit and base-image network access |
| Native scheduler | Disposable OS account or VM |
| Release artifact | Exact candidate tarball/binaries/checksums and native runners |

### 2.3 Automated baseline before manual release QA

```sh
git status --short
bun install --frozen-lockfile
bun run check
bun run build
test -x dist/akm
test ! -e dist/tests
```

- [ ] **[RELEASE]** `bun run check` exits `0`.
- [ ] **[RELEASE]** Build exits `0`; `dist/tests` does not exist.
- [ ] **[RELEASE]** Recheck `git status --short`. Only understood generated
      changes are present. Do not format/rewrite the release candidate during
      acceptance.

---

## 3. Sandbox Setup

### 3.1 Create the sandbox

Run from the repository root. The shell function is deliberate; it is more
reliable than an alias in copied scripts.

```sh
set -u
umask 077

export REPO="$(git rev-parse --show-toplevel)"
export AKM_BIN="$REPO/dist/akm"
export AKM_SANDBOX="$(mktemp -d /tmp/akm-sandbox.XXXXXX)"

export HOME="$AKM_SANDBOX/home"
export XDG_CONFIG_HOME="$AKM_SANDBOX/xdg-config"
export XDG_CACHE_HOME="$AKM_SANDBOX/xdg-cache"
export XDG_DATA_HOME="$AKM_SANDBOX/xdg-data"
export XDG_STATE_HOME="$AKM_SANDBOX/xdg-state"
export AKM_CONFIG_DIR="$AKM_SANDBOX/config"
export AKM_CACHE_DIR="$AKM_SANDBOX/cache"
export AKM_DATA_DIR="$AKM_SANDBOX/data"
export AKM_STATE_DIR="$AKM_SANDBOX/state"
export AKM_BUNDLE_DIR="$AKM_SANDBOX/bundle"
export TMPDIR="$AKM_SANDBOX/tmp"
export TMP="$TMPDIR"
export TEMP="$TMPDIR"
export HF_HOME="$AKM_SANDBOX/huggingface"
export GH_CONFIG_DIR="$AKM_SANDBOX/gh"
export GIT_CONFIG_GLOBAL="$AKM_SANDBOX/gitconfig"
export GIT_CONFIG_NOSYSTEM=1
export NPM_CONFIG_USERCONFIG="$AKM_SANDBOX/npmrc"
export npm_config_cache="$AKM_SANDBOX/npm-cache"
export AKM_FORCE_SETUP_TMP_STASH=1
export AKM_FORCE_INIT_TMP_STASH=1

unset AKM_VERBOSE AKM_DEBUG AKM_REGISTRY_URL AKM_NPM_REGISTRY
unset AKM_LLM_API_KEY AKM_EMBED_API_KEY AKM_NO_AUTO_MIGRATE
unset AKM_EMBED_DETERMINISTIC AKM_UPGRADE_SKIP_CHECKSUM
unset GITHUB_TOKEN GH_TOKEN OPENAI_API_KEY ANTHROPIC_API_KEY
unset OPENCODE_API_KEY X_BEARER_TOKEN X_RSS_TEMPLATE

mkdir -p \
  "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" \
  "$XDG_STATE_HOME" "$AKM_CONFIG_DIR" "$AKM_CACHE_DIR" \
  "$AKM_DATA_DIR" "$AKM_STATE_DIR" "$AKM_BUNDLE_DIR" "$TMPDIR" \
  "$HF_HOME" "$GH_CONFIG_DIR" "$npm_config_cache"

akm() { "$AKM_BIN" "$@"; }
```

For source-entrypoint testing only:

```sh
akm() { bun "$REPO/src/cli.ts" "$@"; }
```

### 3.2 Verify isolation before mutation

`config path --all` is a read-only recovery surface and works before config
exists.

```sh
akm config path --all --format json >"$AKM_SANDBOX/paths.json"
jq -e --arg root "$AKM_SANDBOX/" \
  'all(to_entries[]; (.value | tostring | startswith($root)))' \
  "$AKM_SANDBOX/paths.json"
```

- [ ] **[CORE]** Every reported path starts with `$AKM_SANDBOX/`.
- [ ] **[CORE]** `akm --version` matches `jq -r .version package.json`.
- [ ] **[CORE]** No real provider/agent credential remains in `env`.

Stop immediately if a path escapes the sandbox.

### 3.3 Deterministic non-interactive setup

Do not use `setup --yes` to seed ranking checks. It can perform host-dependent
environment/agent detection. Avoid scaffolding so fixture counts remain exact.

```sh
akm setup \
  --config '{"semanticSearchMode":"off","registries":[]}' \
  --dir "$AKM_BUNDLE_DIR" \
  --no-init \
  --format json >"$AKM_SANDBOX/setup.json"

jq -e --arg dir "$AKM_BUNDLE_DIR" \
  '.written == true and .bundleDir == $dir' \
  "$AKM_SANDBOX/setup.json"
test ! -e "$AKM_BUNDLE_DIR/skills"
```

- [ ] **[CORE]** Setup exits `0`, writes only sandbox config, and does not
      scaffold under `--no-init`.
- [ ] **[CORE]** `config list` contains `configVersion: "0.9.0"`, `bundles`, and
      `defaultBundle`; retired root keys are absent.

### 3.4 Classified-error helper

Use this only for thrown/classified failures. `--quiet` keeps stderr to one JSON
envelope.

```sh
expect_error() {
  expected_status="$1"
  expected_code="$2"
  shift 2

  set +e
  akm --quiet "$@" \
    >"$AKM_SANDBOX/error.stdout" \
    2>"$AKM_SANDBOX/error.stderr"
  actual_status=$?
  set -e

  test "$actual_status" -eq "$expected_status"
  test ! -s "$AKM_SANDBOX/error.stdout"
  jq -e --arg code "$expected_code" \
    '.ok == false and .code == $code and (.error | type == "string")' \
    "$AKM_SANDBOX/error.stderr"
}
```

Do not use this helper for health warnings/failures, lint findings,
workflow/task/agent domain failures, or blocked migration plans. Those emit a
normal result on stdout with a nonzero status.

### 3.5 Byte snapshot helper

```sh
snapshot_tree() {
  root="$1"
  output="$2"
  (
    cd "$root"
    find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum
  ) >"$output"
}
```

On platforms without `sha256sum`, use the native SHA-256 utility and record it.
For failed stateful commands, snapshot config, lockfile, bundle, cache, data,
state, and event cursor, not only asset files.

---

## 4. Fixtures and Local Services

### 4.1 Exact ranking baseline

Copy fixture contents, including dotfiles, without setup scaffolding:

```sh
cp -R "$REPO/tests/fixtures/stashes/ranking-baseline/." "$AKM_BUNDLE_DIR/"

for entry in agents commands knowledge skills MANIFEST.json; do
  test -e "$AKM_BUNDLE_DIR/$entry"
done
test ! -e "$AKM_BUNDLE_DIR/scripts"

akm index --full --format json >"$AKM_SANDBOX/index-baseline.json"
jq -e '.totalEntries == 18 and .verification.ok == true' \
  "$AKM_SANDBOX/index-baseline.json"

akm info --format json | jq -e '
  .indexStats.entryCount == 18 and
  .indexStats.byType == {
    "skill": 4,
    "knowledge": 10,
    "command": 2,
    "agent": 2
  }
'
```

- [ ] **[CORE]** The fixture itself has exactly `agents`, `commands`,
      `knowledge`, `skills`, and `MANIFEST.json` at its root.
- [ ] **[CORE]** Full index reports exactly 18 entries and exact type counts.

Stable refs:

| Type | Ref |
| --- | --- |
| skill | `skills/k8s-deploy` |
| skill | `skills/docker-homelab` |
| knowledge | `knowledge/incident-response-runbook` |
| agent | `agents/code-reviewer` |
| command | `commands/release-manager` |

### 4.2 Supplemental manual-QA bundle

Copy this only after exact ranking assertions:

```sh
cp -R "$REPO/tests/fixtures/manual-qa/bundle/." "$AKM_BUNDLE_DIR/"
akm index
akm show knowledge/qa-guide --no-track-usage | jq -e '.name == "qa-guide"'
akm show workflows/typed-route --no-track-usage | jq -e '.type == "workflow"'
akm show tasks/manual-success --no-track-usage | jq -e '.type == "task"'
```

It supplies `.meta`, typed/gated workflows, command tasks, and fake-agent input
assets. It contains no credentials.

### 4.3 Start controlled fixture services

The service binds only to `127.0.0.1`, records route/model/count/presence
metadata, and exposes chat, embedding, registry, and website routes.

```sh
export AKM_QA_SERVICE_META="$AKM_SANDBOX/service.json"
export AKM_QA_SERVICE_LOG="$AKM_SANDBOX/service-requests.jsonl"
export AKM_QA_SITE_VERSION="$AKM_SANDBOX/site-version.txt"
printf 'v1\n' >"$AKM_QA_SITE_VERSION"

bun "$REPO/tests/fixtures/manual-qa/fake-services.ts" \
  "$AKM_QA_SERVICE_META" \
  "$AKM_QA_SERVICE_LOG" \
  "$AKM_QA_SITE_VERSION" \
  >"$AKM_SANDBOX/service.stdout" \
  2>"$AKM_SANDBOX/service.stderr" &
export AKM_QA_SERVICE_PID=$!

for _ in $(seq 1 100); do
  test -s "$AKM_QA_SERVICE_META" && break
  kill -0 "$AKM_QA_SERVICE_PID"
  sleep 0.05
done
test -s "$AKM_QA_SERVICE_META"

export AKM_QA_BASE_URL="$(jq -r .baseUrl "$AKM_QA_SERVICE_META")"
export AKM_QA_CHAT_URL="$(jq -r .chat.ok "$AKM_QA_SERVICE_META")"
export AKM_QA_PROPOSAL_URL="$(jq -r .chat.proposal "$AKM_QA_SERVICE_META")"
export AKM_QA_EMBED_URL="$(jq -r .embeddings "$AKM_QA_SERVICE_META")"
export AKM_QA_REGISTRY_URL="$(jq -r .registry "$AKM_QA_SERVICE_META")"
export AKM_QA_WEBSITE_URL="$(jq -r .website "$AKM_QA_SERVICE_META")"
```

- [ ] **[SERVICE]** Metadata appears within five seconds and all endpoints are
      loopback.
- [ ] **[SERVICE]** Request logs contain no authorization or prompt values.

Loopback website ingestion needs command-scoped `NODE_ENV=test` because
production correctly blocks private hosts. That proves crawler protocol, not
production SSRF behavior.

### 4.4 Configure fake agent engines

```sh
export AKM_QA_BUN="$(command -v bun)"
export AKM_QA_FAKE_AGENT="$REPO/tests/fixtures/manual-qa/fake-agent.ts"

agent_engine_json() {
  mode="$1"
  shift
  extra='[]'
  if test "$#" -gt 0; then
    extra="$(printf '%s\n' "$@" | jq -R . | jq -s .)"
  fi
  jq -nc \
    --arg bin "$AKM_QA_BUN" \
    --arg script "$AKM_QA_FAKE_AGENT" \
    --arg mode "$mode" \
    --argjson extra "$extra" \
    '{kind:"agent",platform:"opencode",bin:$bin,args:([$script,$mode] + $extra)}'
}

akm config set engines.qa-agent "$(agent_engine_json success)" >/dev/null
akm config set engines.qa-agent-fail "$(agent_engine_json fail)" >/dev/null
akm config set engines.qa-agent-capture "$(agent_engine_json capture)" >/dev/null
akm config set engines.qa-agent-secret "$(agent_engine_json echo-secret)" >/dev/null
akm config set engines.qa-judge-pass "$(agent_engine_json judge-pass)" >/dev/null
akm config set engines.qa-judge-reject "$(agent_engine_json judge-reject)" >/dev/null
akm config set defaults.engine qa-agent >/dev/null
akm config set workflow.judgeEngine qa-judge-pass >/dev/null

export AKM_QA_SIGNAL_MARKER="$AKM_SANDBOX/fake-agent.signal"
akm config set engines.qa-agent-sleep \
  "$(agent_engine_json sleep 10000 "$AKM_QA_SIGNAL_MARKER")" >/dev/null
akm config set engines.qa-agent-sleep.timeoutMs 100 >/dev/null
```

### 4.5 Configure fake LLM and embedding engines

Run after starting fixture services:

```sh
export QA_LLM_KEY='manual-qa-not-a-real-secret'

akm config set engines.qa-chat "$(jq -nc \
  --arg endpoint "$AKM_QA_CHAT_URL" \
  '{kind:"llm",endpoint:$endpoint,model:"qa-model",apiKey:"$QA_LLM_KEY",timeoutMs:1000}')" >/dev/null
akm config set defaults.llmEngine qa-chat >/dev/null

akm config set embedding "$(jq -nc \
  --arg endpoint "$AKM_QA_EMBED_URL" \
  '{provider:"openai",endpoint:$endpoint,model:"qa-embedding",dimension:4,batchSize:4}')" >/dev/null
```

### 4.6 Seed proposal cases

```sh
bun "$REPO/tests/fixtures/manual-qa/seed-proposals.ts" \
  "$AKM_BUNDLE_DIR" >"$AKM_SANDBOX/proposals.json"
akm index
jq -e '.update.id and .newAsset.id and .emptyDiff.id and .defer.id' \
  "$AKM_SANDBOX/proposals.json"
```

The seeder creates a fixed update, new asset, empty diff, and deferred candidate.
It is destructive and must target only the sandbox.

---

## 5. Fast Offline Pass

The fast gate uses no network, model download, provider token, agent process,
scheduler, or migration. Run:

| Order | Required coverage |
| ---: | --- |
| 1 | Sections 3.1-3.3: sandbox and deterministic setup |
| 2 | Section 4.1: exact ranking baseline |
| 3 | Section 6.1: version/root/help surface |
| 4 | Sections 7.1-7.4: index/search/curate/show |
| 5 | Sections 8.1-8.5: representative formats and errors |
| 6 | Sections 10.1-10.3: local remember/import writes |
| 7 | Sections 11.1-11.3: env/secret redaction |
| 8 | Section 12.1: lint detect/fix/idempotence |
| 9 | Section 13.1: feedback/log smoke |

Success criteria:

- [ ] Every **[CORE]** check passes.
- [ ] A second index/read pass preserves exact fixture counts and ranking.
- [ ] No secret fixture value appears in output, logs, reports, config, or events.
- [ ] No file outside `$AKM_SANDBOX` changes after setup begins.

---

## 6. Startup, Setup, Help, and Config

### 6.1 Version, root help, and command help

```sh
test "$(akm --version)" = "$(jq -r .version "$REPO/package.json")"
akm --help >"$AKM_SANDBOX/root-help.txt"

for command in \
  setup index health info bundle upgrade search curate show workflow \
  remember import sync clone registry migrate config feedback log agent \
  lint improve proposal help hints completions env secret task; do
  test "$(grep -Ec "^  ${command}[[:space:]]{2,}" "$AKM_SANDBOX/root-help.txt")" -eq 1
```

- [ ] **[CORE]** Version matches `package.json` exactly.
- [ ] **[CORE]** Root help lists every command above exactly once and includes
      `migrate`.
- [ ] **[CORE]** Root help does not list retired top-level `init`, `add`, `list`,
      `remove`, `update`, `wiki`, `mv`, `history`, `graph`, `lessons`, `extract`,
      or `propose`.
- [ ] **[CORE]** Bare `akm` and `akm help` print the sectioned overview without
      reading or rewriting invalid config.
- [ ] **[CORE]** `help agents`, `help agents --full`, `hints`, and
      `hints --detail brief` are nonempty and have the expected relative detail.
- [ ] **[LOCAL]** `help bundle|env|secret|workflow|task|proposal` agrees with the
      corresponding `--help` command tree.
- [ ] **[LOCAL]** Deep usage includes the full prefix, such as `akm task run`.
- [ ] **[LOCAL]** Misspelled command/flag suggestions are concise and contain no
      ANSI controls inside JSON.

### 6.2 Non-interactive setup

- [ ] **[LOCAL]** `setup --yes` in a second sandbox runs without prompts,
      initializes a bundle, and is idempotent on the second run.
- [ ] **[LOCAL]** JSON and YAML passed through `setup --from` normalize to
      equivalent config.
- [ ] **[LOCAL]** `--from ... --yes --dir ... --no-init` writes config but does
      not scaffold.
- [ ] **[LOCAL]** Passing both `--from` and `--config` exits `2` with
      `INVALID_FLAG_VALUE` before write.
- [ ] **[LOCAL]** Malformed JSON/YAML or invalid shape exits `78` with
      `INVALID_CONFIG_FILE`, preserves prior config bytes, and prints no stack.
- [ ] **[SERVICE]** `setup --probe` against the fixture `.chat.probe` endpoint
      verifies connectivity before write and records no credential value.
- [ ] **[LOCAL]** `setup --config '{}' --dir "$HOME" --no-init` rejects the
      unsafe root. `--no-init` must not bypass target safety.
- [ ] **[LOCAL]** Invalid embedding shape is a config error, not exit `70`.

### 6.3 Interactive setup

Use a real TTY in the sandbox.

- [ ] **[LOCAL]** Setup explains semantic download, small-model setup, agent
      engines, registries, sources, and task review.
- [ ] **[LOCAL]** Cancel at each boundary; config/bundle stay byte-identical
      unless final save was confirmed.
- [ ] **[LOCAL]** Redirected stdin without a noninteractive flag exits `2` with
      `NON_INTERACTIVE_REQUIRES_YES` instead of hanging.
- [ ] **[AI]** Detected CLIs/model servers are suggestions only; selecting or
      skipping persists exactly the reviewed choice.

### 6.4 Config management

```sh
akm config list --format json | jq -e '.bundles and .defaultBundle'
akm config get semanticSearchMode | jq -e '. == "off"'
akm config set semanticSearchMode auto --silent >"$AKM_SANDBOX/silent.out"
test ! -s "$AKM_SANDBOX/silent.out"
akm config unset semanticSearchMode --silent >"$AKM_SANDBOX/silent.out"
test ! -s "$AKM_SANDBOX/silent.out"
```

- [ ] **[CORE]** `list|get|set|unset` preserve unrelated keys and return JSON
      values; use `jq -r` for string comparisons.
- [ ] **[CORE]** `--silent` changes config with empty stdout; errors still emit.
- [ ] **[LOCAL]** Objects deep-merge, arrays replace, and `unset` is deletion.
- [ ] **[LOCAL]** Generic walker cannot set/unset `configVersion`.
- [ ] **[LOCAL]** `defaultWriteTarget` rejects unknown/disabled bundles and can
      be set/unset for a configured writable bundle.
- [ ] **[LOCAL]** Retired config roots and defaults fail without rewrite.
- [ ] **[LOCAL]** API key references accept `$VAR`/`${VAR}` only; config/list/info
      never materialize values.
- [ ] **[LOCAL]** Concurrent independent `config set` processes preserve both
      changes or one fails cleanly; JSON stays valid and no temp file remains.
- [ ] **[LOCAL]** `config path --all` honors output formatting. Bare
      `config path` is a raw path primitive; if format/output are ignored it
      must warn explicitly. Silent ignoring is a failure.

### 6.5 Help migration notes

- [ ] **[CORE]** `help migrate 0.6.0`, `v0.6.0-rc1`, and `latest` print bundled
      guidance without config startup.
- [ ] **[CORE]** Unknown version lists available notes gracefully.
- [ ] **[CORE]** Missing version exits `2` with `MISSING_REQUIRED_ARGUMENT`.
- [ ] **[LOCAL]** Global flags do not steal the version positional.

### 6.6 Completions

```sh
akm completions --format yaml \
  >"$AKM_SANDBOX/akm-completion.bash" \
  2>"$AKM_SANDBOX/completion.stderr"
bash -n "$AKM_SANDBOX/akm-completion.bash"
grep -q "'--format' has no effect" "$AKM_SANDBOX/completion.stderr"
```

- [ ] **[CORE]** Generated Bash parses; warning stays on stderr.
- [ ] **[LOCAL]** Dynamically source it and verify each group returns only real
      subcommands. Registry completion is `add list remove`.
- [ ] **[LOCAL]** Unsupported shell exits `2` with structured usage error.
- [ ] **[LOCAL]** `--install` writes only in sandbox completion paths, emits no
      script on stdout, and reports destination on stderr.

### 6.7 Upgrade check

`upgrade --check` is network-backed, not part of first-run/offline coverage.

- [ ] **[LIVE]** With GitHub credentials cleared, check reports current/latest,
      boolean availability, and install method without mutation.
- [ ] **[LIVE]** Repeat with a disposable token and prove redaction.
- [ ] **[LIVE]** Source/dist may report `installMethod: "unknown"`; do not count
      that as standalone-upgrade success.

---

## 7. Index, Search, Curate, and Show

### 7.1 Index

```sh
akm index --full --format json >"$AKM_SANDBOX/index-full.json"
akm index --verbose --format json \
  >"$AKM_SANDBOX/index-verbose.json" \
  2>"$AKM_SANDBOX/index-verbose.stderr"
jq -e . "$AKM_SANDBOX/index-verbose.json"
test -s "$AKM_SANDBOX/index-verbose.stderr"
```

- [ ] **[CORE]** Full index reports 18 baseline entries, successful verification,
      scanned directories, and timings.
- [ ] **[CORE]** Immediate incremental index preserves count and skips unchanged
      directories.
- [ ] **[CORE]** Verbose progress is stderr-only; stdout remains valid JSON.
- [ ] **[LOCAL]** Add, modify, rename, and delete one asset; new bytes appear and
      removed bytes never remain discoverable.
- [ ] **[LOCAL]** Malformed workflow warns/skips only that file.
- [ ] **[LOCAL]** `--clean --dry-run` reports stale refs without deleting them;
      normal clean removes them. Account for normal indexing discovering a
      deletion before clean runs.
- [ ] **[LOCAL]** `--dry-run` without `--clean` exits `2`.
- [ ] **[LOCAL]** Removed `--enrich`/`--re-enrich` exit `2` with guidance.
- [ ] **[LOCAL]** SIGINT/SIGTERM release locks, preserve prior valid index, and
      allow the next index.
- [ ] **[LOCAL]** Two simultaneous full indexes serialize or return typed lock
      failure, never DB corruption/permanent lock.

### 7.2 Search

```sh
akm search k8s-deploy \
  --detail full --no-track-usage --no-project-context --format json |
  jq -e '
    .hits[0].ref == "skills/k8s-deploy" and
    .hits[0].type == "skill" and
    .hits[0].score >= 0 and .hits[0].score <= 1
  '

json_count="$(akm search docker --no-track-usage --no-project-context | jq '.hits | length')"
jsonl_count="$(akm search docker --no-track-usage --no-project-context --format jsonl | jq -s 'length')"
test "$json_count" -gt 0
test "$json_count" -eq "$jsonl_count"
```

- [ ] **[CORE]** Exact/phrase queries rank expected fixtures first.
- [ ] **[CORE]** `--type skill` returns only skills. Unknown free-form type
      returns zero hits, not usage failure.
- [ ] **[CORE]** Empty search browses all 18 baseline entries deterministically.
- [ ] **[CORE]** JSON and JSONL hit counts match.
- [ ] **[CORE]** No-result search exits `0` with empty hits.
- [ ] **[LOCAL]** Prefix queries (`knowledge/`, `memories/projectA/`,
      `<bundle>//`) enforce exact boundaries; `projectAlpha/` does not leak.
- [ ] **[LOCAL]** Named bundle/local/registry/all modes keep local `hits` and
      `registryHits` separate.
- [ ] **[LOCAL]** Repeated valid filters AND-join. Missing/malformed/unknown or
      conflicting filters fail without broadening scope.
- [ ] **[LOCAL]** Scoped memory appears only for matching filters; unscoped
      assets disappear once filters are supplied.
- [ ] **[LOCAL]** Belief current/historical/all partitions state correctly.
- [ ] **[LOCAL]** Proposed quality and sessions are excluded by default and
      included only through explicit flags.
- [ ] **[LOCAL]** `--no-track-usage` leaves event/ranking state unchanged;
      default successful read advances it.
- [ ] **[LOCAL]** `--no-project-context` removes cwd/repository boost.
- [ ] **[LOCAL]** Zero/negative/fractional/prefix numeric limits (`2x`), overflow,
      and conflicting repeats are rejected. `parseInt` prefix acceptance fails.

### 7.3 Curate

```sh
akm curate "docker homelab" --detail full --no-track-usage --format json |
  jq -e '.items[0].ref == "skills/docker-homelab" and (.summary | type == "string")'
```

- [ ] **[CORE]** Returns `{items,query,summary}` and actionable follow-ups.
- [ ] **[CORE]** Empty query exits `2`, `MISSING_REQUIRED_ARGUMENT`.
- [ ] **[LOCAL]** Type, limit, source, detail, agent shape, related refs, and
      family collapse are correct.
- [ ] **[LOCAL]** No-track causes no durable signal; invalid limits match search
      strictness.
- [ ] **[SERVICE]** Registry-only items have install guidance and no local
      path/editability.

### 7.4 Show, fragments, scope, and meta

```sh
akm show skills/k8s-deploy --no-track-usage --format json |
  jq -e '
    .type == "skill" and
    .ref == "skills/k8s-deploy" and
    (.path | startswith("/")) and
    (.content | contains("Kubernetes Deployment"))
  '

akm show 'knowledge/incident-response-runbook#severity-levels' \
  --no-track-usage --format json |
  jq -e '(.content | contains("SEV1")) and ((.content | contains("Escalation Path")) | not)'
```

- [ ] **[CORE]** Default/full/agent/summary retain canonical ref; human/agent
      shapes expose path/editability as documented.
- [ ] **[CORE]** Valid fragment returns only that section. Invalid fragment exits
      `1`, `ASSET_NOT_FOUND`, and lists slugs.
- [ ] **[CORE]** Missing asset exits `1` with structured stderr.
- [ ] **[LOCAL]** `.md` suffix normalization preserves durable identity.
- [ ] **[LOCAL]** Removed `toc`, `--scope`, and type-colon refs fail with useful
      migration guidance.
- [ ] **[LOCAL]** `show meta`, `meta:<name>`, and `<bundle>//meta` direct-read
      `.meta`; those docs never appear in search.
- [ ] **[LOCAL]** Qualified duplicates return selected bundle bytes; unqualified
      follows default then installation precedence.
- [ ] **[LOCAL]** Scope match resolves; mismatch returns not-found without leak.
- [ ] **[LOCAL]** Read-only source reports `editable:false` plus edit hint;
      writable local reports `true`.
- [ ] **[LOCAL]** Show is local-index only and does not remote-fallback.

---

## 8. Output, Errors, and Exit Codes

### 8.1 Exit and channel oracle

| Outcome | Exit | Channel |
| --- | ---: | --- |
| Success | `0` | Normal payload on stdout |
| Not found/general failure | `1` | Classified stderr or domain stdout result |
| Usage/bad input | `2` | Structured JSON stderr |
| Health warning | `4` | Health stdout result |
| Unexpected throw | `70` | Structured internal stderr |
| Config error | `78` | Structured JSON stderr |

Domain-result exceptions:

| Command | Nonzero behavior |
| --- | --- |
| `health` | Warn `4`, fail `1`; result stays on stdout |
| `lint --fail-on-flagged` | Exit `1`; lint result stays on stdout |
| `workflow run` | Failure/rejection/timeout emits workflow stdout result |
| `agent` | Dispatch failure exits `1` with `agent-result` stdout |
| `task run` | Blocked/failed `1`, command config failure `78`; child code in detail |
| `migrate` | Child status preserved; progress can precede final formatted plan |
| `env run` / `secret run` | Raw child streams and exact child status |

### 8.2 Six formats

```sh
akm info --format json | jq -e .
akm info --format jsonl | jq -e .
akm info --format yaml | bun -e '
  import { parse } from "yaml";
  const value = parse(await Bun.stdin.text());
  if (!value?.version) process.exit(1);
'
akm info --format text >"$AKM_SANDBOX/info.txt"
akm info --format md >"$AKM_SANDBOX/info.md"
akm info --format html >"$AKM_SANDBOX/info.html"
grep -qi '<html' "$AKM_SANDBOX/info.html"
```

- [ ] **[CORE]** JSON/JSONL/YAML parse; text is plain; Markdown is not JSON;
      HTML is self-contained.
- [ ] **[LOCAL]** Repeat representative search/show/config/bundle/log/health/task/
      proposal/workflow/setup/migrate commands in supported formats.
- [ ] **[LOCAL]** Global flags work before/after command and with space/equals.
- [ ] **[LOCAL]** Persisted output defaults apply only when CLI flags are absent.

### 8.3 Shape, detail, and output destination

- [ ] **[CORE]** Brief/normal/full increase detail without identity drift.
- [ ] **[CORE]** Summary succeeds only on show; all other commands reject it
      before side effects with exit `2`, `INVALID_SHAPE_VALUE`.
- [ ] **[LOCAL]** Agent shape keeps action fields and strips non-action metadata.
- [ ] **[LOCAL]** `show --format md --output <file>` writes file, empty stdout.
- [ ] **[LOCAL]** Output replacement is atomic; unwritable/directory target does
      not truncate existing content.
- [ ] **[LOCAL]** JSONL stays on stdout and does not create `--output` file.
- [ ] **[LOCAL]** Health report HTML data matches JSON report data.

### 8.4 Format-exempt commands

`completions`, `help`, `help migrate`, `env path`, `env run`, and `secret run`
do not emit normal result envelopes.

- [ ] **[CORE]** Passing format emits one stderr warning and preserves raw
      payload/child streams.
- [ ] **[LOCAL]** Child help/format flags after `--` reach child, not AKM parser.
- [ ] **[LOCAL]** Interactive setup is terminal UI; scripted setup is formatted.

### 8.5 Error gauntlet

```sh
expect_error 2 MISSING_REQUIRED_ARGUMENT curate ""
expect_error 1 ASSET_NOT_FOUND show skills/does-not-exist --no-track-usage
expect_error 2 UNKNOWN_FLAG info --totally-bogus
expect_error 2 INVALID_FORMAT_VALUE info --format xml
expect_error 2 INVALID_DETAIL_VALUE info --detail maximum
expect_error 2 INVALID_SHAPE_VALUE search docker --shape summary
expect_error 2 MISSING_REQUIRED_ARGUMENT help migrate
expect_error 2 INVALID_FLAG_VALUE completions --shell zsh
```

- [ ] **[CORE]** Classified throw leaves stdout empty and emits one stderr JSON
      object with `ok:false`, `error`, `code`, optional hint.
- [ ] **[CORE]** No ordinary failure prints stack, bare `Error:`, ANSI JSON, or
      output-shape registration failure.
- [ ] **[LOCAL]** Errors stay JSON under text/yaml/md/html/output flags; no error
      output file is created.
- [ ] **[LOCAL]** Test-harness unclassified throw exits `70`; `AKM_DEBUG=1` adds
      stack only on stderr.
- [ ] **[LOCAL]** Unknown commands/bare groups exit `2` with concise current hint.

---

## 9. Bundles, Adapters, Sources, and Registries

### 9.1 Bundle create

Use a second sandbox or disposable secondary paths.

- [ ] **[LOCAL]** First create scaffolds canonical dirs/current config/default.
- [ ] **[LOCAL]** `--dir <secondary>` backfills without changing existing
      default; `--set-default` changes it explicitly.
- [ ] **[LOCAL]** Repeat is idempotent and preserves files.
- [ ] **[LOCAL]** `$HOME`, root, config, cache, data, and state roots are rejected
      even if no scaffolding work would occur.
- [ ] **[LOCAL]** Env/secrets paths have owner-only POSIX permissions.
- [ ] **[LOCAL]** Temp authorization uses `AKM_FORCE_INIT_TMP_STASH`, not setup's
      separate variable.

### 9.2 Identity, precedence, and enabled state

```sh
mkdir -p "$AKM_SANDBOX/bundle-a" "$AKM_SANDBOX/bundle-b"
akm bundle add "$AKM_SANDBOX/bundle-a" --name bundle-a
akm bundle add "$AKM_SANDBOX/bundle-b" --name bundle-b
akm remember "body A" --name shared --bundle bundle-a
akm remember "body B" --name shared --bundle bundle-b
akm show bundle-a//memories/shared --no-track-usage | jq -e '.content | contains("body A")'
akm show bundle-b//memories/shared --no-track-usage | jq -e '.content | contains("body B")'
```

- [ ] **[LOCAL]** Qualified identity remains stable through index/search/show.
- [ ] **[LOCAL]** Unqualified resolution follows default then installation
      precedence, never random duplicate.
- [ ] **[LOCAL]** Names obey slug rules; `team/sync-qa` is rejected.
- [ ] **[LOCAL]** Kind filter accepts exact supported kinds; `local`/`managed`
      groupings exit `2`.
- [ ] **[LOCAL]** `bundle show` reports one descriptor/components/effective
      writable state.
- [ ] **[LOCAL]** `enabled:false` removes source from index/search/refresh/write
      selection. Singular update/write must not bypass disabled state.

### 9.3 Built-in adapter matrix

| Adapter | Fixture |
| --- | --- |
| `website-snapshot` | `tests/fixtures/bundles/website-snapshot` |
| `agent-skills` | `tests/fixtures/bundles/agent-skills` |
| `claude` | `tests/fixtures/bundles/claude` |
| `opencode` | `tests/fixtures/bundles/opencode` |
| `dotenv` | `tests/fixtures/bundles/dotenv` |
| `akm-workflow` | `tests/fixtures/bundles/akm-workflow` |
| `akm-task` | `tests/fixtures/bundles/akm-task` |
| `llm-wiki` | `tests/fixtures/bundles/llm-wiki` |
| `akm` | `tests/fixtures/stashes/ranking-baseline` |
| `okf` | `tests/fixtures/bundles/okf-sample-v2` |
| `generic-files` | `tests/fixtures/bundles/generic-files` |

For each adapter:

- [ ] **[LOCAL]** Add copied fixture under unique name; run bundle show, full
      index, search, representative show, and lint.
- [ ] **[LOCAL]** Expected component wins precedence without double indexing.
- [ ] **[LOCAL]** Placement/ref/type/rendering match format-family goldens.
- [ ] **[LOCAL]** Intentional invalid files produce only named lint findings.
- [ ] **[LOCAL]** Read-only adapter rejects write before mutation.

### 9.4 LLM Wiki adapter

```sh
cp -R "$REPO/tests/fixtures/bundles/llm-wiki" "$AKM_SANDBOX/sample-wiki"
akm bundle add "$AKM_SANDBOX/sample-wiki" --name sample-wiki
akm bundle show sample-wiki --format json
akm index --full
akm show sample-wiki//pages/http-caching --no-track-usage
akm show sample-wiki//raw/2026-07-http-rfc --no-track-usage
akm lint --dir "$AKM_SANDBOX/sample-wiki"
```

- [ ] **[LOCAL]** Adapter is `llm-wiki`; pages use `pageKind`, raw is
      `wiki-source`.
- [ ] **[LOCAL]** `schema.md`, `index.md`, `log.md` are not indexed concepts.
- [ ] **[LOCAL]** Intentional broken xref is reported.
- [ ] **[LOCAL]** Removing schema or pages prevents recognition.
- [ ] **[LOCAL]** No network/LLM request occurs.
- [ ] **[LOCAL]** There is no `akm wiki`; agents write normal files.

### 9.5 Filesystem source

```sh
mkdir -p "$AKM_SANDBOX/fs-source/knowledge"
printf '%s\n' '# Filesystem Marker' '' 'qa-filesystem-source-marker' \
  >"$AKM_SANDBOX/fs-source/knowledge/marker.md"
akm bundle add "$AKM_SANDBOX/fs-source" --name fs-source
akm bundle list --kind filesystem
akm search qa-filesystem-source-marker --from fs-source --no-track-usage
```

- [ ] **[LOCAL]** Add indexes in place with kind `filesystem`, writable true.
- [ ] **[LOCAL]** Single update and update-all reconcile current files into the
      index without provider hydration.
- [ ] **[LOCAL]** Non-TTY remove requires `--yes`, removes ownership/index, and
      leaves source files.
- [ ] **[LOCAL]** Real path plus symlink alias does not create ambiguous owner or
      duplicate durable refs.

### 9.6 Git source

Use a small disposable HTTPS/SSH repository. `file://` is rejected by design.

- [ ] **[LIVE]** Inferred add clones/locks/configures/indexes read-only.
- [ ] **[LIVE]** Branch/tag/ref pin resolves exact revision.
- [ ] **[LIVE]** Change unique upstream marker, update by legal name, and prove
      new bytes/revision. Exit zero alone is insufficient.
- [ ] **[LIVE]** Force rematerializes complete content.
- [ ] **[LIVE]** Declarative `--provider git` is config-only; first update
      materializes and runs security audit.
- [ ] **[LIVE]** Writable source pushes only under explicit policy; no-push never
      contacts remote.
- [ ] **[LIVE]** Plain `git+http` cannot bypass insecure transport gate.
- [ ] **[LIVE]** Remove cleans AKM-owned config/lock/index/cache only.

### 9.7 npm source

Use a disposable package/version or controlled registry.

- [ ] **[LIVE]** Inferred add materializes/locks/indexes read-only.
- [ ] **[LIVE]** Scoped/unscoped refs, exact versions, dist-tags, malformed specs,
      missing versions, auth, checksum/tar safety, and oversized archives behave
      structurally.
- [ ] **[LIVE]** Publish second unique marker/version; update proves new bytes.
- [ ] **[LIVE]** Declarative provider is config-only; update makes managed.
- [ ] **[LIVE]** `writable:true` is rejected.
- [ ] **[LIVE]** Remove cleans all AKM-owned extraction roots only.

### 9.8 Website source

Production must reject loopback/private hosts:

```sh
expect_error 78 INVALID_CONFIG_FILE \
  bundle add "$AKM_QA_WEBSITE_URL" --name private-site --allow-insecure
```

Protocol-only fixture:

```sh
NODE_ENV=test akm bundle add "$AKM_QA_WEBSITE_URL" \
  --name qa-site --allow-insecure --max-pages 2 --max-depth 1
NODE_ENV=test akm search qa-site --from qa-site --no-track-usage
```

- [ ] **[SERVICE]** Production blocks private start/redirect hosts;
      `--allow-insecure` accepts transport risk only, not SSRF.
- [ ] **[SERVICE]** Test-seam crawl respects page/depth/robots; request log proves
      private path not fetched.
- [ ] **[SERVICE]** Change site version to `v2`, named-update, and prove v2 bytes.
      Stale-fallback success with v1 fails this gate.
- [ ] **[SERVICE]** Failed first crawl leaves no config/cache/index/lock/success
      event residue.
- [ ] **[SERVICE]** Interrupted publication preserves previous complete snapshot.
- [ ] **[SERVICE]** Update-all skips website; named update refreshes.
- [ ] **[LIVE]** Repeat against controlled public HTTPS in production mode.
- [ ] **[LIVE]** Specialized YouTube/Bluesky/X/feed fetchers use controlled data
      or disposable credentials and retain safe fallback.

### 9.9 Registry

```sh
expect_error 2 INVALID_FLAG_VALUE registry add "$AKM_QA_REGISTRY_URL" --name qa-registry
akm registry add "$AKM_QA_REGISTRY_URL" --name qa-registry --allow-insecure
akm registry list | jq -e '.registries[] | select(.name == "qa-registry")'
akm search kubernetes --from registry --detail full
akm search kubernetes --from registry --assets --detail full
akm registry remove qa-registry --yes
```

- [ ] **[SERVICE]** HTTP requires allow-insecure and warns.
- [ ] **[SERVICE]** Duplicate URL is idempotent `added:false`; unknown remove is
      exit `1`, `SOURCE_NOT_FOUND`.
- [ ] **[SERVICE]** Registry hits remain `registryHits`, not local `hits`.
- [ ] **[SERVICE]** Full hit exposes actionable `installRef`.
- [ ] **[SERVICE]** `--assets` makes asset-level fixture result observable;
      discarding provider asset hits is failure.
- [ ] **[SERVICE]** Scores remain provider-local and may exceed one.
- [ ] **[SERVICE]** Malformed/wrong schema/HTTP/timeout/stale/oversized response
      does not poison other registries.
- [ ] **[SERVICE]** Options require JSON object; malformed/non-object fails before
      config mutation.
- [ ] **[SERVICE]** Install uses `bundle add <installRef>`; no registry install
      subcommand exists.

### 9.10 Source failure atomicity and dangerous env

```sh
before_config="$(sha256sum "$AKM_CONFIG_DIR/config.json")"
set +e
akm bundle add "$REPO/tests/fixtures/manual-qa/dangerous-bundle" \
  --name qa-dangerous </dev/null
status=$?
set -e
test "$status" -eq 1
test "$(sha256sum "$AKM_CONFIG_DIR/config.json")" = "$before_config"
! akm bundle list --format json | jq -e '.sources[] | select(.name == "qa-dangerous")'
```

- [ ] **[LOCAL]** Inferred noninteractive add blocks raw dangerous env, rolls
      back config/lock/cache/index, no success event/envelope.
- [ ] **[LOCAL]** Allow-insecure permits reviewed fixture with warning.
- [ ] **[LOCAL]** Non-`.env` file under env is ignored.
- [ ] **[LOCAL]** Publisher lint suppression does not silently bypass untrusted
      install safety; test suppression fixture separately.
- [ ] **[LOCAL]** Declarative provider and later update receive equivalent audit.
- [ ] **[LOCAL]** New dangerous key on update preserves previous complete source.
- [ ] **[LOCAL]** A held WAL index reader observes only the prior generation
      through a failed update; index/state main, WAL, and SHM inodes are not
      replaced during compensation.
- [ ] **[LOCAL]** Writable Git rejects physical-root/component symlink escapes,
      a changed HEAD or dirty state at publication, and dangerous tracked,
      untracked, ignored, filter-produced, or submodule materialization.
- [ ] **[LOCAL]** Lock publication and rollback fence both exact raw bytes and
      file mode; a concurrent chmod blocks publication without being reverted.
- [ ] **[LOCAL]** A simulated durable index/state split is reported as
      `index-state-generation`; after writers stop, `akm index --full` clears
      the advisory and restores coherent searchable usage links.
- [ ] **[LOCAL]** Corrupt/unreadable lock fails structurally; no managed/plain
      reinterpretation or split state.
- [ ] **[LOCAL]** Failed add/update/remove compare config, lock, cache, index,
      source bytes, and event cursor, not only exit.

---

## 10. Writes, Import, Clone, and Sync

### 10.1 Remember

```sh
akm remember "test memory body" --name test-memory
akm show memories/test-memory --no-track-usage | jq -e '.content | contains("test memory body")'
expect_error 1 RESOURCE_ALREADY_EXISTS remember "duplicate" --name test-memory
akm remember "replacement" --name test-memory --force
printf 'stdin body\n' | akm remember --name from-stdin
```

- [ ] **[CORE]** Plain/stdin/force paths write one valid indexed memory and
      preserve body bytes.
- [ ] **[CORE]** Duplicate without force fails before mutation.
- [ ] **[LOCAL]** Description/repeated tags/expiry/source/auto/nested path/xrefs
      serialize once without nested frontmatter/duplicates.
- [ ] **[LOCAL]** Scope-only memory is valid without tags and uses canonical
      scope fields.
- [ ] **[LOCAL]** Tag-bearing metadata with no resulting tag fails before write.
- [ ] **[LOCAL]** Invalid absolute/traversal name/path, self/unresolved xref,
      unknown bundle, retired target/stash flags fail before all side effects.
- [ ] **[AI]** Enrich success/failure uses fake LLM and never silently writes
      missing required metadata.

### 10.2 Target precedence

- [ ] **[LOCAL]** Explicit bundle wins over default write target, then default
      bundle; no fallback to first writable source.
- [ ] **[LOCAL]** Read-only/disabled/missing/unsupported targets reject before
      write.
- [ ] **[LOCAL]** Writable git target produces one complete boundary commit;
      push requires writable + remote policy.
- [ ] **[LOCAL]** Qualified source cannot redirect to conflicting target.

### 10.3 Import

```sh
cat >"$AKM_SANDBOX/incoming.md" <<'EOF'
---
description: Imported manual QA document
custom:
  nested: preserved
---
# Imported Guide

qa-import-marker
EOF

akm import "$AKM_SANDBOX/incoming.md" --name imported-guide
akm import - --name imported-stdin <"$AKM_SANDBOX/incoming.md"
```

- [ ] **[CORE]** File/stdin import preserve custom frontmatter/body and produce
      deterministic refs.
- [ ] **[LOCAL]** Path/target/force/xref/supersession use same preflight/write
      rules as remember.
- [ ] **[LOCAL]** Malformed frontmatter fails losslessly; missing input/invalid
      name leaves no partial file.
- [ ] **[LOCAL]** Loopback URL production import exits `2` under SSRF policy;
      no allow-insecure bypass exists.
- [ ] **[LIVE]** Controlled public HTTPS import follows bounded redirects,
      converts content, derives URL-path name, blocks private redirect.

### 10.4 Supersession

- [ ] **[LOCAL]** Correction xrefs old asset; old gains superseded state/by ref
      while preserving unrelated metadata/body.
- [ ] **[LOCAL]** Belief-current hides old; all can return both.
- [ ] **[LOCAL]** Unresolved/self supersession changes neither file.
- [ ] **[LOCAL]** Cross-bundle non-applicable demotion is reported explicitly.
- [ ] **[DESTRUCTIVE]** Failure between correction and demotion has pinned
      all-or-nothing behavior; undocumented half-correction fails.

### 10.5 Clone

- [ ] **[CORE]** Clone a skill and single file to unmanaged destination; skill
      references copy recursively, source unchanged.
- [ ] **[LOCAL]** Managed clone follows explicit/default/working target and
      indexes immediately.
- [ ] **[LOCAL]** Destination works without write target and conflicts with
      bundle flag.
- [ ] **[LOCAL]** Existing destination requires force; invalid rename/traversal/
      missing source leaves no partial copy.
- [ ] **[LIVE]** Clone from uninstalled controlled package caches but does not
      register source.

### 10.6 Sync

```sh
git -C "$AKM_BUNDLE_DIR" init
git -C "$AKM_BUNDLE_DIR" config user.name 'AKM Manual QA'
git -C "$AKM_BUNDLE_DIR" config user.email 'manual-qa@example.invalid'
git -C "$AKM_BUNDLE_DIR" add .
git -C "$AKM_BUNDLE_DIR" commit -m 'Manual QA baseline'

akm remember "sync marker" --name sync-marker
akm sync --no-push -m "Manual QA sync"
git -C "$AKM_BUNDLE_DIR" show --stat --oneline -1
```

- [ ] **[LOCAL]** Non-git bundle returns structured skipped/no-op.
- [ ] **[LOCAL]** Git commits sandbox changes/message and never pushes with
      no-push.
- [ ] **[LOCAL]** Named source uses legal slug such as `team-sync-qa`, not slash.
- [ ] **[LOCAL]** Source literally named `json` remains selectable alongside
      format flag.
- [ ] **[LOCAL]** Whole-bundle staging policy is represented honestly; no claim
      that unrelated dirty paths were excluded if they were committed.
- [ ] **[LIVE]** Disposable writable remote pushes; read-only/no-remote commits
      locally only; failed push retains complete local commit.

### 10.7 Write concurrency, atomicity, and paths

- [ ] **[LOCAL]** Two same-name remember creates: exactly one succeeds, one
      already-exists; final is one complete payload.
- [ ] **[LOCAL]** Repeat for import and content-bearing env create.
- [ ] **[LOCAL]** Concurrent different-asset writes both survive/index.
- [ ] **[LOCAL]** Read-only/unwritable/disk-full/path-is-directory failures leave
      old bytes/index intact.
- [ ] **[LOCAL]** Internal symlink resolves consistently; escaping symlink is
      rejected and outside sentinel unchanged.
- [ ] **[DESTRUCTIVE]** Kill replacement at publication boundaries; recovery is
      old or new complete bytes, no temp/stale lock/truncation.

---

## 11. Env and Secret

Use conspicuous dummy values only. AKM keeps env and secret values out of its
structured results, but a child launched by `env run` or `secret run` owns its
raw stdout/stderr and can print injected values.

### 11.1 Create, list, path, and indexing

```sh
export QA_SECRET_VALUE='manual-qa-secret-not-a-credential'

printf '%s\n' \
  'QA_PUBLIC=manual-qa-public' \
  'QA_SECOND=manual-qa-second' \
  'QA_TOKEN=Bearer ${secret:qa-token}' \
  >"$AKM_SANDBOX/qa-runtime.env"

akm env create qa-runtime \
  --from-file "$AKM_SANDBOX/qa-runtime.env" --format json \
  >"$AKM_SANDBOX/env-create.json"
printf '%s\n' "$QA_SECRET_VALUE" |
  akm secret set secrets/qa-token --format json \
    >"$AKM_SANDBOX/secret-set.json"

akm env list --format json >"$AKM_SANDBOX/env-list.json"
akm secret list --format json >"$AKM_SANDBOX/secret-list.json"
akm index
akm show env/qa-runtime --no-track-usage --format json \
  >"$AKM_SANDBOX/env-show.json"
akm show secrets/qa-token --no-track-usage --format json \
  >"$AKM_SANDBOX/secret-show.json"

jq -e 'any(.envs[]; .ref == "env/qa-runtime" and (.keys | index("QA_PUBLIC")))' \
  "$AKM_SANDBOX/env-list.json"
jq -e 'any(.secrets[]; .ref == "secrets/qa-token")' \
  "$AKM_SANDBOX/secret-list.json"

for capture in \
  "$AKM_SANDBOX/env-create.json" \
  "$AKM_SANDBOX/secret-set.json" \
  "$AKM_SANDBOX/env-list.json" \
  "$AKM_SANDBOX/secret-list.json" \
  "$AKM_SANDBOX/env-show.json" \
  "$AKM_SANDBOX/secret-show.json"; do
  ! grep -F "$QA_SECRET_VALUE" "$capture"
  ! grep -F 'manual-qa-public' "$capture"
done
```

- [ ] **[CORE]** Env list exposes refs and key names only; secret list exposes
      refs only. Values, comments, and absolute paths are absent.
- [ ] **[CORE]** Env is searchable by key name, never value/comment. Secret is
      searchable by filename only, never bytes.
- [ ] **[CORE]** `env path env/qa-runtime` emits one absolute path on stdout and
      a do-not-source warning on stderr; `--quiet` suppresses only the warning.
- [ ] **[CORE]** Env/secret directories are `0700` and files are `0600` on
      POSIX. Record the ACL equivalent on Windows.
- [ ] **[CORE]** Empty env create is idempotent. Content-bearing create refuses
      an existing destination with exit `2`, preserving old bytes.
- [ ] **[LOCAL]** `--from-file` and `--from-stdin` conflict. Env stdin over 1 MiB,
      secret stdin/file over 5 MiB, missing input, invalid path, and traversal
      fail before publication.
- [ ] **[LOCAL REGRESSION]** Secret `--from-env` obeys the same 5 MiB cap as
      stdin/file. Current behavior must not be accepted if it bypasses the cap.
- [ ] **[LOCAL]** `--sensitive` and sibling `.sensitive` markers remove an asset
      from list/index/search/show while preserving direct run/path use.
- [ ] **[LOCAL]** Mutations are not automatically reindexed; list reads disk
      immediately, while search/show change only after `akm index`.

### 11.2 Safe value use and raw child channels

```sh
export QA_INHERITED='manual-qa-inherited'

akm env run env/qa-runtime \
  --only QA_PUBLIC,QA_TOKEN --clean --inherit QA_INHERITED \
  -- bun -e '
    if (process.env.QA_PUBLIC !== "manual-qa-public") process.exit(11);
    if (process.env.QA_TOKEN !== "Bearer manual-qa-secret-not-a-credential") process.exit(12);
    if (process.env.QA_INHERITED !== "manual-qa-inherited") process.exit(13);
    if (process.env.QA_SECOND !== undefined) process.exit(14);
  '

akm secret run secrets/qa-token QA_INJECTED --clean \
  -- bun -e '
    if (process.env.QA_INJECTED !== "manual-qa-secret-not-a-credential") process.exit(15);
  '
test -z "${QA_INJECTED+x}"

set +e
akm env run env/qa-runtime -- bun -e 'process.exit(7)'
env_child_status=$?
akm secret run secrets/qa-token QA_INJECTED -- bun -e 'process.exit(9)'
secret_child_status=$?
set -e
test "$env_child_status" -eq 7
test "$secret_child_status" -eq 9
```

- [ ] **[CORE]** Values enter only the child environment and never mutate the
      invoking shell.
- [ ] **[CORE]** `${secret:NAME}` resolves from the env asset's own bundle,
      including embedded/multiple tokens. Missing secret fails before spawn.
- [ ] **[CORE]** `--only` and `--except` are mutually exclusive; filtering occurs
      before dangerous-key policy. Clean mode inherits only the documented
      minimum plus explicit names.
- [ ] **[CORE]** Child stdout/stderr pass through unchanged and exact numeric
      child status is returned. Do not claim those raw streams are redacted.
- [ ] **[LOCAL]** Missing command is usage exit `2`; missing executable is
      `FILE_NOT_FOUND`, exit `1`; non-executable target is config exit `78`.
- [ ] **[LOCAL]** Access events contain only env ref/key names or secret ref/
      target variable. They contain no values and occur only after resolution.
- [ ] **[LOCAL]** Timeout/signal behavior returns a nonzero signal-equivalent
      result and leaves no child. A null child status must not become success.
- [ ] **[LOCAL]** Format flags on `env path`, `env run`, and `secret run` warn on
      stderr and leave the raw payload/child streams unchanged.

### 11.3 Export, overwrite, targets, and removal

```sh
printf 'QA_LITERAL=$(touch %s)\n' "$AKM_SANDBOX/export-payload-ran" \
  >"$AKM_SANDBOX/qa-export.env"
akm env create qa-export --from-file "$AKM_SANDBOX/qa-export.env"
akm env export env/qa-export --out "$AKM_SANDBOX/qa-export.sh" \
  --format json >"$AKM_SANDBOX/env-export.json"

test ! -e "$AKM_SANDBOX/export-payload-ran"
sh -c '. "$1"' sh "$AKM_SANDBOX/qa-export.sh"
test ! -e "$AKM_SANDBOX/export-payload-ran"

printf 'replacement-without-trailing-newline' |
  akm secret set secrets/qa-token
akm env remove env/qa-export --yes
```

- [ ] **[CORE]** Export requires `--out`, prints no values, writes atomically at
      `0600`, and single-quotes substitutions/backticks/dollars/quotes/globs.
- [ ] **[CORE]** Export does not resolve `${secret:...}`. `env run` is the safe
      default for secret substitution.
- [ ] **[CORE]** Secret stdin strips one trailing newline; file input preserves
      bytes exactly. Secret overwrite is atomic and serialized.
- [ ] **[LOCAL]** Explicit target wins over `defaultWriteTarget`, then default
      bundle. Read-only/disabled/unsupported targets fail before mutation.
- [ ] **[LOCAL]** Writable Git target publishes one boundary commit unless the
      files are intentionally ignored and stored as local-only overlays.
- [ ] **[LOCAL]** Env remove needs confirmation, removes the env and marker, and
      leaves unrelated assets unchanged.
- [ ] **[LOCAL]** `secret path` and `secret remove` are removed and exit `2`.
      Locate/delete a secret under the reviewed bundle root, then reindex.
- [ ] **[LOCAL REGRESSION]** Duplicate env refs across bundles resolve to the
      same file for path/run/export/remove. Read/write resolver disagreement is
      a failure.

### 11.4 Dangerous keys and redaction boundary

- [ ] **[CORE]** Secret run rejects dangerous target variables such as `PATH`,
      `LD_PRELOAD`, `NODE_OPTIONS`, and `GIT_CONFIG_*` before spawn/event.
- [ ] **[LOCAL]** First-party env activation warns and proceeds; third-party
      activation blocks exit `2`. Excluding all dangerous keys permits the safe
      subset.
- [ ] **[LOCAL]** `--allow-insecure` can authorize reviewed installation but
      never authorizes later dangerous activation.
- [ ] **[LOCAL REGRESSION]** Lint suppression cannot authorize untrusted install;
      declarative first materialization and every update receive the same audit.
- [ ] **[LOCAL REGRESSION]** Env export applies an equivalent dangerous-key
      warning/gate before producing sourceable output.
- [ ] **[LOCAL]** Search all captured AKM results, events, state/log databases,
      reports, and config for the literal dummy value. Exclude deliberate child
      passthrough evidence from the AKM-redaction claim.

---

## 12. Lint

### 12.1 Detect, gate, fix, and repeat

Create a disposable native-AKM lint root:

```sh
export QA_LINT_DIR="$AKM_SANDBOX/lint-bundle"
mkdir -p "$QA_LINT_DIR/knowledge"
cat >"$QA_LINT_DIR/knowledge/fixable.md" <<'EOF'
---
description: Manual QA: fixable colon
---
# Fixable
EOF

akm lint --dir "$QA_LINT_DIR" --format json \
  >"$AKM_SANDBOX/lint-detect.json"
jq -e '.ok == true and .summary.flagged >= 1' \
  "$AKM_SANDBOX/lint-detect.json"

set +e
akm lint --dir "$QA_LINT_DIR" --fail-on-flagged --format json \
  >"$AKM_SANDBOX/lint-gate.json" \
  2>"$AKM_SANDBOX/lint-gate.stderr"
lint_gate_status=$?
set -e
test "$lint_gate_status" -eq 1
test ! -s "$AKM_SANDBOX/lint-gate.stderr"
jq -e '.ok == true and .summary.flagged >= 1' \
  "$AKM_SANDBOX/lint-gate.json"

akm lint --dir "$QA_LINT_DIR" --fix --format json \
  >"$AKM_SANDBOX/lint-fix.json"
jq -e '.summary.fixed >= 1' "$AKM_SANDBOX/lint-fix.json"

snapshot_tree "$QA_LINT_DIR" "$AKM_SANDBOX/lint-fixed.sha256"
akm lint --dir "$QA_LINT_DIR" --auto-fix --format json \
  >"$AKM_SANDBOX/lint-fix-second.json"
jq -e '.summary.fixed == 0' "$AKM_SANDBOX/lint-fix-second.json"
snapshot_tree "$QA_LINT_DIR" "$AKM_SANDBOX/lint-fixed-again.sha256"
cmp "$AKM_SANDBOX/lint-fixed.sha256" \
  "$AKM_SANDBOX/lint-fixed-again.sha256"
```

- [ ] **[CORE]** Plain lint exits `0` with `ok:true` even when findings exist.
- [ ] **[CORE]** Fail-on-flagged exits `1` but retains the complete successful
      lint result on stdout and leaves stderr empty.
- [ ] **[CORE]** Fix applies only fixable findings, reports failed fixes as
      flagged, and is byte-idempotent on the second run.
- [ ] **[CORE]** Fix plus fail-on-flagged exits `1` only if findings remain.
- [ ] **[CORE]** `--auto-fix` equals `--fix`; single-dash `-auto-fix` is an
      unknown flag, exit `2`.
- [ ] **[CORE]** Each finding has relative file, issue, detail, and tri-state
      fixed status. No absolute bundle path or secret value appears.

### 12.2 Native and adapter scopes

```sh
akm lint --dir "$AKM_BUNDLE_DIR" --type workflows --format json \
  >"$AKM_SANDBOX/lint-workflows.json"
akm lint --dir "$REPO/tests/fixtures/stashes/all-types" --format json \
  >"$AKM_SANDBOX/lint-all-types.json"
akm lint --dir "$REPO/tests/fixtures/bundles/llm-wiki" --format json \
  >"$AKM_SANDBOX/lint-wiki.json"
```

- [ ] **[CORE]** Native sweep covers agents, commands, memories, skills,
      workflows, lessons, tasks, knowledge, and facts, plus a separate dangerous
      `.env` pass.
- [ ] **[LOCAL]** Workflow Markdown compiles structurally; task `.yml` validates
      version/schedule/enabled/target; missing `SKILL.md` is flagged.
- [ ] **[LOCAL]** `--type` accepts exact plural native directories and genuinely
      narrows structural and dangerous-env scanning.
- [ ] **[LOCAL REGRESSION]** Singular/unknown type and missing/unreadable `--dir`
      fail instead of returning a false-clean result.
- [ ] **[LOCAL]** Non-AKM roots dispatch through the detected/configured adapter
      `validate()` implementation and remain read-only even with `--fix`.
- [ ] **[LOCAL]** LLM Wiki reports uncited raw, missing description, broken xref,
      and broken source; dotenv reports dangerous keys without exposing values.
- [ ] **[LOCAL REGRESSION]** `--type` is not silently ignored by non-AKM adapter
      validation.
- [ ] **[CORE]** Unsupported `--profile`, `--category`, `--severity`, and
      `--bundle` flags fail exit `2`; do not invent selector semantics.

### 12.3 Rules, suppressions, and mutation boundaries

Core issue codes include `unquoted-colon`, `missing-updated`, `orphaned-stub`,
`placeholder-stub`, `missing-name-or-type`, `missing-type`, `stale-path`,
`missing-skill-md`, `invalid-task-yaml`, `missing-ref`,
`dangerous-env-key`, `invalid-workflow-structure`, and `missing-category`.
Adapters may add named diagnostics; unknown adapter codes map to
`adapter-diagnostic` while preserving the original code in detail.

- [ ] **[LOCAL]** Only unquoted description, missing updated, orphaned stub, and
      placeholder stub fixes mutate; all structural/security findings remain
      flagged.
- [ ] **[LOCAL]** `lint_skip` scalar/list suppresses only supported base rules,
      exactly and case-sensitively. It cannot suppress dangerous env or per-type
      structure.
- [ ] **[LOCAL]** `# akm-lint-ok: dangerous-env-key` suppresses only the next
      matching dotenv assignment for lint display, never installation/runtime.
- [ ] **[LOCAL REGRESSION]** Suppression also associates with `export KEY=...`;
      malformed task YAML and `.yaml` spelling produce explicit findings rather
      than disappearing.
- [ ] **[LOCAL]** Fenced-code refs are ignored; body refs and refs/xrefs/
      supersededBy/contradictedBy fields are checked across configured bundles.
- [ ] **[LOCAL]** Lint appends no event, performs no reindex, and adapter
      validation never writes.
- [ ] **[LOCAL REGRESSION]** Native fix honors read-only/Git publication
      boundaries and either behaves transactionally or reports partial mutation
      explicitly. Silent direct edits/deletes are a failure.

### 12.4 Advisory channel

Non-fatal workflow compile advisories (a step with no `output:` schema, a
reference to an undeclared param) travel in their own channel so a hint cannot
fail a build.

```sh
akm lint --type workflows --format json > "$AKM_SANDBOX/lint-advisory.json"
jq -e '.warnings | length > 0' "$AKM_SANDBOX/lint-advisory.json"
jq -e '[.flagged[].issue] | index("workflow-warning") == null' "$AKM_SANDBOX/lint-advisory.json"
akm lint --type workflows --fail-on-flagged; echo "exit=$?"
```

- [ ] **[CORE]** A compile advisory appears in `warnings` with issue code
      `workflow-warning`, never in `flagged`, and `summary.warnings` counts it.
- [ ] **[CORE]** `--fail-on-flagged` exits `0` for a bundle whose only findings
      are advisories, and non-zero once a real error is present.
- [ ] **[LOCAL]** Both lint paths agree: the akm sweep and a bundle linted
      through its own adapter classify the same code the same way.
- [ ] **[LOCAL]** A workflow file is parsed and compiled **once** per sweep, not
      once per output channel — check with a large workflow and compare sweep
      time against a bundle with the same file count and no workflows.

### 12.5 Output parity and automated coverage

- [ ] **[CORE]** JSON/JSONL/YAML/text/Markdown/HTML preserve the same finding
      set and summary. Text renders flagged before fixed.
- [ ] **[LOCAL]** Hard usage/config/internal failures use standard structured
      stderr and do not emit a partial lint result.
- [ ] **[LOCAL]** Run focused lint, adapter dispatch, workflow structure,
      dangerous-key, and format-family golden suites after linter changes.

---

## 13. Feedback, Log, and Health

### 13.1 Feedback taxonomy and ranking

```sh
akm feedback skills/k8s-deploy --positive --tag slice:manual --tag team:qa
expect_error 2 MISSING_REQUIRED_ARGUMENT \
  feedback skills/k8s-deploy --negative
akm feedback skills/k8s-deploy --negative \
  --reason "manual QA relevance check" --failure-mode incomplete
```

- [ ] **CORE** Positive and reasoned negative feedback return stable signal/reason fields.
- [ ] **CORE** Negative feedback without reason/failure mode fails by default with `MISSING_REQUIRED_ARGUMENT`, exit `2`.
- [ ] **LOCAL** Both signals, missing/nonexistent ref, unknown/incompatible failure mode, malformed tag, and more than ten tags fail before durable mutation.
- [ ] **LOCAL** Allowed failure modes are `incorrect`, `outdated`, `dangerous`, `incomplete`, and `redundant` unless config narrows them.
- [ ] **LOCAL** `feedback.requireReason:false` produces the documented warning rather than the default hard failure.
- [ ] **LOCAL** User feedback updates ranking immediately and reports `rankingUpdate.applied`; machine-origin signals do not impersonate user demand.
- [ ] **LOCAL** Feedback survives full reindex and contains no credential fixture value.

### 13.2 Durable log and cursors

```sh
akm log --type feedback --ref skills/k8s-deploy --detail full --format json \
  > "$AKM_SANDBOX/feedback-log.json"
event_id="$(jq -r '.events[-1].id' "$AKM_SANDBOX/feedback-log.json")"
akm log --since "@offset:$event_id" --format json
```

- [ ] **CORE** Mutations produce numeric durable ids, normalized refs, type, timestamp, and structured non-secret metadata.
- [ ] **LOCAL** Type/ref/run/since/limit/include-tags/exclude-tags filters compose correctly.
- [ ] **LOCAL** `@offset:<id>` returns only later events across a fresh process and exposes a reusable next offset.
- [ ] **LOCAL** Include-tags requires all requested tags; exclude removes any matching event.
- [ ] **LOCAL** No-track search/show/curate appends no later usage event.
- [ ] **LOCAL** Retired `log list` and `log tail` fail with current `akm log` guidance.
- [ ] **LOCAL** Full rebuild/source update/restart preserve events and monotonic cursors.
- [ ] **LOCAL** Event metadata stores ids/status/counts, not workflow instructions, child output, prompts, env values, or credentials.

### 13.3 Health pass, warn, and fail

```sh
set +e
akm health --format json > "$AKM_SANDBOX/health.json"
health_status=$?
set -e

jq -e --argjson status "$health_status" '
  (.status == "pass" and $status == 0) or
  (.status == "warn" and $status == 4) or
  (.status == "fail" and $status == 1)
' "$AKM_SANDBOX/health.json"
```

- [ ] **CORE** Health status and exit mapping agree; warn remains `ok:true`, hard failure is `ok:false`.
- [ ] **LOCAL** Fresh data dir initializes `state.db`, validates schema/round-trip, and does not call initial absence corruption.
- [ ] **LOCAL** Fake default agent provides deterministic healthy engine evidence.
- [ ] **SERVICE** Semantic config `auto` plus blocked runtime produces nonfatal advisory/exit `4` when hard checks pass.
- [ ] **LOCAL** A copied secondary state DB with a failed hard check returns health stdout result and exit `1`; never corrupt primary evidence DB.
- [ ] **LOCAL** Active/stuck runs, task backing/fail rate, agent failure rate, improve/session metrics, and graph summary are accurate.
- [ ] **LOCAL** Since accepts duration/date/ISO/epoch and rejects invalid/future values predictably.
- [ ] **LOCAL** Up to four repeated windows work; explicit windows and window-compare are mutually exclusive.

### 13.4 Health reports

```sh
akm health --report --format json > "$AKM_SANDBOX/health-report.json"
akm health --report --format html --output "$AKM_SANDBOX/health-report.html"
akm health --group-by run --format md > "$AKM_SANDBOX/health-runs.md"
```

- [ ] **LOCAL** JSON/Markdown/HTML contain the same per-run/trend/proposal/accept-rate data.
- [ ] **LOCAL** Absolute since is not misparsed as implicit duration comparison.
- [ ] **LOCAL** HTML is self-contained, safely escaped, and credential-free.
- [ ] **LOCAL** Report read failure is not overwritten by stale status-derived exit.

---

## 14. Workflow

### 14.1 Authoring and validation

```sh
akm workflow list --format json | jq -e '.runs == []'
akm workflow create qa-template --print > "$AKM_SANDBOX/qa-template.md"
test ! -e "$AKM_BUNDLE_DIR/workflows/qa-template.md"
akm workflow create qa-created --from "$AKM_SANDBOX/qa-template.md"
akm lint --type workflows --fail-on-flagged
```

- [ ] **CORE** Create-print emits raw valid Markdown and writes nothing.
- [ ] **CORE** Create-from writes/indexes valid workflow with preamble and exact sections.
- [ ] **LOCAL** Flat name plus safe path creates hierarchy; slash/traversal/duplicate step/missing section/unknown route/invalid params fail before write.
- [ ] **LOCAL** Existing workflow requires force plus from/reset; force alone fails.
- [ ] **LOCAL** Lint catches structure without rewriting valid prose.
- [ ] **CORE** A schema keyword outside the enforced subset (`format`, `pattern`,
      `$ref`, `const`, `uniqueItems`, `patternProperties`, …) in `output:` or
      `params:` is a **line-anchored parse error naming the keyword**, not a
      silently non-constraining schema. Confirm the same document fails
      `workflow run`, `workflow show`, `workflow create`, and `akm lint`.
- [ ] **LOCAL** `akm index` skips such a workflow with a scan warning rather
      than indexing it — the quietest surface, so check it deliberately.
- [ ] **LOCAL** `allOf`/`anyOf`/`oneOf`/`not` are accepted and **enforced** at
      runtime; a bounded-evaluation overrun is reported as an error, never as a
      truncated pass.
- [ ] **LOCAL** A document-level `defaults.llm` combined with any step on an
      agent engine fails at freeze, naming the step and the engine. Moving the
      `llm:` block onto the LLM step's `unit:` is the documented remedy; `llm: {}`
      is a no-op and `llm: null` is a parse error.

### 14.2 Typed params and partial run without an engine call

The `typed-route` fixture executes a route-only first step. `--max-steps 1`
tests parameter parsing and durable run creation without agent/LLM dispatch.

```sh
akm workflow run workflows/typed-route \
  --include_processes=true --count 2 \
  --labels api --labels worker --max-steps 1 \
  > "$AKM_SANDBOX/typed-run.json"

export QA_RUN_ID="$(jq -r .run.id "$AKM_SANDBOX/typed-run.json")"
jq -e '
  .run.status == "active" and
  .run.currentStepId == "finish" and
  .run.params == {
    "include_processes": true,
    "count": 2,
    "labels": ["api", "worker"]
  }
' "$AKM_SANDBOX/typed-run.json"
```

- [ ] **LOCAL** Boolean/integer/number/string/null/enum/object/repeated array/JSON array coerce to schema types.
- [ ] **LOCAL** Unknown param, underscore-hyphen alias, invalid JSON/enum/range, missing required, duplicate scalar, flags before target, and retired params bag fail exit `2`.
- [ ] **LOCAL** Params supplied to active run fail because creation-only.
- [ ] **LOCAL** Invalid max-steps values fail; bounded partial exits `0`, remains active.
- [ ] **LOCAL** `--max-steps` counts **finished spine steps**: a step's whole
      bounded gate loop counts as one, and a route-skipped step consumes none.
      It does not bound the dispatches inside a single step's gate loop — pair
      it with `budget.max_units` when that is what you need capped.

### 14.3 Status, list, abandon, resume, and scope

```sh
akm workflow status "$QA_RUN_ID"
akm workflow status workflows/typed-route
akm workflow list --active --ref workflows/typed-route
akm workflow status "$QA_RUN_ID" --units
akm workflow abandon "$QA_RUN_ID"
akm workflow resume "$QA_RUN_ID"
```

- [ ] **LOCAL** Direct id status works from another dir; ref status/list remain current-scope only.
- [ ] **LOCAL** Units adds diagnostics without state change.
- [ ] **LOCAL** Abandon marks failed/removes active; resume reopens failed/blocked, never completed.
- [ ] **LOCAL** Run by ref while active resumes it; direct id continues exact run.
- [ ] **LOCAL** Source edit after start does not change frozen plan; new run sees edit.

### 14.4 Deterministic execution and gates

Configure fake engines from section 4.4, then continue the active run:

```sh
akm workflow run "$QA_RUN_ID" --max-steps 1 \
  > "$AKM_SANDBOX/typed-finished.json"
jq -e '.run.status == "completed"' "$AKM_SANDBOX/typed-finished.json"
```

Create separate copies of `gated-agent` for pass/reject/malformed judges so each
run freezes its own judge selection.

- [ ] **AI** Pass verdict completes.
- [ ] **AI** Reject verdict returns missing/feedback evidence and nonzero domain result.
- [ ] **AI** Malformed verdict, agent/HTTP failure, missing judge, and timeout fail closed.
- [ ] **AI** Max loops bounds retries and prior gate feedback enters next unit.
- [ ] **AI** Gate journal distinguishes running/error/pass/reject and survives resume.
- [ ] **AI** Config changes after start do not replace frozen execution/judge engine/model/timeout.

### 14.5 Exec (shell) units

An exec unit spawns a command instead of dispatching to an engine, so run this
whole subsection with **no engine configured** — that is the first assertion,
not a setup shortcut. Author the fixtures first:

```sh
cat > "$AKM_BUNDLE_DIR/workflows/exec-basic.md" <<'EOF'
---
type: workflow
description: Exec unit smoke
steps:
  - id: emit
    unit:
      exec:
        command: ["printf", "hello\n\n"]
---

# Exec Basic

## emit

Print a greeting. Stdout is the promoted artifact; this prose never reaches the
command.
EOF

cat > "$AKM_BUNDLE_DIR/workflows/exec-json.md" <<'EOF'
---
type: workflow
description: Exec unit with a typed artifact
steps:
  - id: emit
    unit:
      exec:
        command: ["echo", '{"verdict":"pass"}']
      output: { type: object, required: [verdict], properties: { verdict: { type: string } } }
---

# Exec JSON

## emit

Emit exactly one JSON value.
EOF

akm index
akm lint --type workflows --fail-on-flagged
akm workflow run workflows/exec-basic --format json > "$AKM_SANDBOX/exec-basic.json"
jq -e '.run.status == "completed"' "$AKM_SANDBOX/exec-basic.json"
akm workflow status "$(jq -r .run.id "$AKM_SANDBOX/exec-basic.json")" --units
```

Authoring and dispatch:

- [ ] **CORE** A workflow of only exec steps freezes and completes with **no
      engine configured at all**; the run spends no tokens.
- [ ] **CORE** Without `output:`, the artifact is stdout with trailing newlines
      stripped (`hello`, not `hello\n\n`); empty stdout is *no output*.
- [ ] **CORE** With `output:`, stdout must be exactly one JSON value — leading
      and trailing whitespace tolerated, any other trailing text fails the unit
      — and the value is validated against the schema.
- [ ] **CORE** `engine`, `model`, or `llm` alongside `exec:` fails at parse,
      naming the conflict.
- [ ] **LOCAL** `command` is argv, never a shell string: an argument containing
      `;`, `|`, `&&`, `$(…)`, backticks, `>`, or `*` reaches the child as those
      literal bytes. `["bash", "-lc", "…"]` is the supported way to get a shell.
- [ ] **LOCAL** Argv bounds hold: 1–64 entries, each non-empty and at most 4096
      bytes; violations fail at parse and at frozen-plan decode.
- [ ] **LOCAL** A step body is still required and is **not** passed to the
      command.
- [ ] **LOCAL** stderr is a diagnostic channel only — it never becomes the
      artifact, and a passing command that writes to stderr still succeeds.

Failure taxonomy — each reason, and whether `retry.on` may name it:

- [ ] **CORE** Non-zero exit is `non_zero_exit` and, under the default
      `on_error: fail`, fails the step and the run (this is what makes a `test`
      step a gate). `on_error: continue` records it in evidence instead.
- [ ] **LOCAL** Wall-clock expiry is `timeout`; run cancellation is `aborted`; a
      missing binary or unusable working directory is `spawn_failed`. All three
      are retryable via `retry.on`.
- [ ] **LOCAL** `exec_output_limit`, `exec_context_too_large`, `exec_cwd_escape`
      and `exec_capture_incomplete` are **rejected** in a `retry.on` list —
      each is deterministic, an authoring problem, or work that already ran.
- [ ] **LOCAL** On timeout or cancellation the child's whole **process group**
      takes the SIGTERM→SIGKILL ladder; no orphaned grandchildren survive.

Capture and retention:

- [ ] **LOCAL** Past the 8 MiB per-stream retention cap akm keeps draining the
      pipe, so the command never blocks: with no `output:` schema the unit
      **succeeds** with the artifact marked truncated; with a schema it fails
      `exec_output_limit`.
- [ ] **LOCAL** A command that backgrounds a descendant inheriting **stderr**
      (`sh -c 'daemon 2>&1 & echo ok'` shapes) and exits 0 **succeeds** with its
      complete stdout artifact, and warns that the stderr tail may be missing.
      Only an incomplete **stdout** capture fails the unit.
- [ ] **LOCAL** That same unit settles promptly after its leader exits — it does
      **not** sit until its declared timeout expires.
- [ ] **LOCAL** `timeout: none` is genuinely unbounded: a command that runs well
      past an hour still completes and promotes its artifact.

Environment scope and context:

- [ ] **LOCAL** The child gets the default allowlist only: credentials and cloud
      or CI variables present in akm's own environment are **absent** unless
      named. `pass_env:` widens it by name; exact named `env:` bindings provide
      fixed or secret values.
- [ ] **CORE** A new durable-v4-family (`irVersion: 5`) start containing
      `inherit_env: true` is rejected before dispatch and directs the author to
      named env bindings. A pre-`irVersion`-5 stored plan is also rejected and
      directs the user to start a new run.
- [ ] **LOCAL** `env:` bindings inject resolved values, and the `AKM_*` context
      is applied *after* them, so a binding cannot shadow it.
- [ ] **LOCAL** `AKM_RUN_ID`, `AKM_STEP_ID`, `AKM_UNIT_ID`, `AKM_PARAMS`,
      `AKM_INPUTS`, and (in a `map`) `AKM_ITEM` / `AKM_ITEM_INDEX` reach the
      command with the documented shapes.
- [ ] **LOCAL** An oversized `AKM_*` context fails `exec_context_too_large`
      **before** the spawn, naming the variable, rather than surfacing a raw
      `E2BIG`.

`cwd` and isolation:

- [ ] **LOCAL** `cwd` is relative and contained: absolute paths, drive letters,
      `~`, and `..` **segments** are rejected by the parser *and* the
      frozen-plan decoder, and containment is re-checked against the resolved
      base (symlinks included) immediately before the spawn.
- [ ] **LOCAL** A directory whose *name* merely begins with dots (`..data`) is a
      legal contained `cwd` and must **not** fail `exec_cwd_escape`.
- [ ] **LOCAL** Under `isolation: worktree` each unit gets a fresh detached
      worktree; a clean one is gone once the step resolves, a dirty one is
      retained and its path logged.
- [ ] **LOCAL** When a dirty leftover is moved aside and the worktree then fails
      to mint, the failure still reports **where the preserved work went**.
- [ ] **DESTRUCTIVE** The stale-worktree sweep removes abandoned trees after
      seven days but leaves a tree that is still in use by a live run.

Gates, retry, and reuse:

- [ ] **LOCAL** A `### gate` rubric on an exec step **evaluates** — a rejection
      still fails the step — but never loops: the command runs exactly **once**
      regardless of `gate.max_loops`, because a frozen argv cannot answer
      feedback. Verify with a command that appends to a file.
- [ ] **LOCAL** A declared `retry:` re-runs the command only for reasons it
      names; a schema miss is never re-prompted (re-running could deploy twice).
- [ ] **LOCAL** A completed exec unit is reused on resume, never re-executed —
      confirm with a command whose side effect is observable.
- [ ] **LOCAL** `map` fan-out over exec units respects the frozen concurrency
      width, and each unit sees its own `AKM_ITEM`.

### 14.6 Failure, interruption, concurrency, and events

- [ ] **LOCAL** Execution nonzero returns workflow stdout result, exit `1`.
- [ ] **LOCAL** Whole-run timeout leaves current step resumable and records evidence.
- [ ] **LOCAL** A run that **completes** after its `--timeout` deadline landed is
      reported as completed, not as timed out.
- [ ] **LOCAL** SIGINT/SIGTERM map to `130`/`143`, release claims, leave recoverable run.
- [ ] **LOCAL** Concurrent same-ref/scope starts create one active run; second driver loses lease safely.
- [ ] **LOCAL** Map fan-out respects workflow and frozen engine concurrency caps.
- [ ] **LOCAL** Log by run correlates start/unit/gate/step/finish only.
- [ ] **DESTRUCTIVE** Kill before unit, after unit, after judge; resume reclaims only unfinished work, no duplicate unit.
- [ ] **DESTRUCTIVE** Run focused lease/crash/contention/publication suites.

### 14.7 Step artifacts, bounds, and evidence

A step's promoted artifact is bounded for *persistence* only. The distinction
between what the running invocation sees and what the row keeps is the point.

- [ ] **LOCAL** A step promoting an artifact larger than the 1 MiB persistence
      cap still hands the **complete** value to the next step of the same run —
      both a whole-value `inputs:` reference and a path reference into it.
- [ ] **LOCAL** The persisted row for that step carries a truncation marker, and
      **resuming** into the truncated artifact fails loudly, naming truncation
      as the cause rather than reporting a missing property.
- [ ] **LOCAL** Over-cap evidence sacrifices the byte-largest values first, and
      the persisted row is never left over cap.

### 14.8 Retired surfaces and fallback

- [ ] **CORE** Start/next/complete/brief/report fail `UNKNOWN_COMMAND` with run/status guidance.
- [ ] **LOCAL** No template/validate/watch; replacements are create-print/lint/log.
- [ ] **AI** No defaults engine plus actual opencode binary enables announced SDK fallback; SDK package alone does not.
- [ ] **AI** Binary absent fails `78`, names both remedies; no arbitrary first-engine fallback.
- [ ] **LOCAL** Secret-shaped param names warn because params persist; use dummy values only.

---

## 15. Task

### 15.1 Surface and schema

The current group has only `add`, `run`, `history`, `sync`, and `doctor`.
Inspection uses generic search/show. Enable/disable is YAML edit plus sync;
removal is file deletion plus sync.

- [ ] **CORE** Task help shows those five; bare task exits `2`; doctor is diagnostic.
- [ ] **CORE** Search `tasks/` and show `tasks/manual-success` expose fixtures.
- [ ] **LOCAL** Task list/show/remove/enable/disable and plural top-level tasks fail with guidance.
- [ ] **LOCAL** Version `2` and schedule are required; enabled default correct; exactly one target.
- [ ] **LOCAL** Command arrays preserve argv. String commands whitespace-split without shell quote semantics.
- [ ] **LOCAL** Old Markdown task is not indexed; YAML is canonical; legacy same-id blocks add unless force.

### 15.2 Doctor and manual execution without scheduler mutation

```sh
akm task doctor --format json > "$AKM_SANDBOX/task-doctor.json"
akm task run manual-success --format json > "$AKM_SANDBOX/task-success.json"

set +e
akm task run manual-failure --format json > "$AKM_SANDBOX/task-failure.json"
task_failure_status=$?
set -e

test "$task_failure_status" -eq 1
jq -e '.result.detail.exitCode == 7' "$AKM_SANDBOX/task-failure.json"
akm task history --id manual-failure --limit 1
```

- [ ] **CORE** Doctor reports backend/executable/log dir/schedule subset without scheduler mutation.
- [ ] **CORE** Manual run executes disabled success task; scheduled marker skips disabled task.
- [ ] **LOCAL** Failure is stdout result/CLI `1`, with child `7` retained in detail/history.
- [ ] **LOCAL** Command child `78` maps CLI `78`; other failed status maps `1`.
- [ ] **LOCAL** Missing/malformed task, invalid id, prompt/workflow failure, timeout, and signal record bounded history.
- [ ] **LOCAL** Flat log and logs DB agree and redact credentials.
- [ ] **LOCAL** A **workflow** task that declares no `timeoutMs:` gets the
      6-hour unattended default: the log records `timed_out=true` with the
      applied `timeout_ms`, the attempt is `failed` so the scheduler sees a
      non-zero exit, and the aborted run is left **resumable** with the error
      naming `akm workflow resume <id>`.
- [ ] **LOCAL** `timeoutMs: null` opts a workflow task out entirely and arms no
      timer; an explicit number overrides the default.
- [ ] **LOCAL** A workflow task whose run **completes** as the deadline lands is
      recorded `completed` with no timeout error and no resume hint.

### 15.3 Scheduler binding and native lifecycle

- [ ] **LOCAL** Source/dist scheduler write without rebind rejects ineligible executable before task/scheduler mutation.
- [ ] **LOCAL** Explicit rebind records reviewed invocation and warns not release-eligible.
- [ ] **PLATFORM** Use installed npm/standalone candidate in disposable account.
- [ ] **PLATFORM** Add disabled command/prompt/workflow; inspect native entry; edit enabled/schedule/target + sync; execute; inspect history/log; delete YAML + sync removes entry.
- [ ] **PLATFORM** Existing binding remains unless rebind; upgrade behavior is explicit.

| Platform | Evidence |
| --- | --- |
| Linux cron | Before/after crontab, generated line, execution log, history, removal |
| macOS launchd | Plist, launchctl state, execution log, history, unload/removal |
| Windows schtasks | XML, scheduler query, execution result, history, deletion |

```sh
AKM_NATIVE_SCHEDULER_TESTS=1 bun test tests/integration/native-scheduler.test.ts
```

- [ ] **PLATFORM** Native test actually runs rather than skips and all changes are removed from the disposable account.

---

## 16. Proposal Queue

### 16.1 Seed, list, show, diff, and resolution

Run the deterministic seeder from section 4.6.

```sh
update_id="$(jq -r .update.id "$AKM_SANDBOX/proposals.json")"
new_id="$(jq -r .newAsset.id "$AKM_SANDBOX/proposals.json")"

akm proposal list --status pending --format json
akm proposal show "$update_id" --format json
akm proposal show 11111111 --format json
akm proposal show memories/qa-proposal-update --format json
akm proposal diff "$update_id" --format text
```

- [ ] **LOCAL** List filters queue/status/ref/type without mutation; bare proposal is a usage error.
- [ ] **LOCAL** Pending proposal resolves by full UUID, unique prefix, and canonical asset ref.
- [ ] **LOCAL** Ambiguous prefix `33333333` fails with an ambiguity error and candidate guidance.
- [ ] **LOCAL** Missing proposal is `PROPOSAL_NOT_FOUND`, exit `1`.
- [ ] **LOCAL** Show includes payload, provenance, target, validation, status, and no credential values.
- [ ] **LOCAL** Diff distinguishes create/update/empty diff and renders all supported formats.
- [ ] **LOCAL** Queue/target selectors that conflict with recorded target fail before mutation.

### 16.2 Accept and revert exact bytes

```sh
cp "$AKM_BUNDLE_DIR/memories/qa-proposal-update.md" \
  "$AKM_SANDBOX/qa-proposal-update.before"

akm proposal accept "$update_id" --format json
grep -q 'qa-proposal-after' "$AKM_BUNDLE_DIR/memories/qa-proposal-update.md"

akm proposal revert "$update_id" --format json
cmp "$AKM_SANDBOX/qa-proposal-update.before" \
  "$AKM_BUNDLE_DIR/memories/qa-proposal-update.md"
```

- [ ] **LOCAL** Accept validates/publishes/indexes one proposal and archives it accepted with backup metadata.
- [ ] **LOCAL** Update revert accepts full archived UUID or asset ref, restores exact prior bytes, reindexes, and marks reverted.
- [ ] **LOCAL** Archived UUID prefixes are not supported by revert; use full UUID.
- [ ] **LOCAL** Accepting new asset succeeds, but reverting it fails with usage exit `2` because no prior-content backup exists.
- [ ] **LOCAL** Reverting pending/rejected/reverted/missing proposal has the correct usage/not-found classification and changes no bytes.
- [ ] **LOCAL** Stale before-hash, read-only/disabled target, lint blocker, adapter precommit failure, git commit/push failure, and publication interruption preserve coherent queue/asset state.

### 16.3 Reject and bulk dry-runs

```sh
akm proposal reject "$new_id" --reason "manual QA" --yes
akm proposal accept --generator reflect --dry-run --format json
akm proposal reject --generator distill \
  --reason "manual QA dry-run" --dry-run --format json
```

- [ ] **LOCAL** Single reject requires nonempty reason and `--yes` in non-TTY mode; it archives one row and preserves payload/audit.
- [ ] **LOCAL** Bulk dry-run needs no prompt, reports matching proposals, and leaves statuses/assets unchanged.
- [ ] **LOCAL** Max-diff-lines and older-than strictly validate integers/ranges and select exact rows.
- [ ] **LOCAL** Dry-run does not create backups, commits, or asset/index mutations.

### 16.4 Drain policy and observability

```sh
before_event_id="$(akm log --format json | jq -r '.events[-1].id // 0')"
akm proposal drain --policy manual --dry-run --format json \
  > "$AKM_SANDBOX/drain-dry-run.json"
after_event_id="$(akm log --format json | jq -r '.events[-1].id // 0')"
```

- [ ] **LOCAL** Manual policy deterministically rejects empty diff and defers nonempty proposals; it never accepts by itself.
- [ ] **LOCAL** Dry-run leaves assets/statuses unchanged but appends the documented `triage_drained` observability event. It is not globally side-effect-free.
- [ ] **LOCAL** Max accepts, max diff lines, older-than, queue mode versus `--promote`, and hard cap buckets are exact.
- [ ] **AI** Judgment-enabled policy uses selected frozen engine and fails closed on malformed/failed judgment.
- [ ] **LOCAL** Invalid policy/path and noninteractive promotion without `--yes` fail before writes.

### 16.5 Proposal generation and crash recovery

- [ ] **AI** `proposal new` with the fake/controlled agent either queues one valid proposal with provenance or returns a structured engine failure; use one tiny asset/task.
- [ ] **AI** `proposal extract --type <harness>` and `--auto` use disposable session fixtures, bounded since/limit, and never ingest real session secrets.
- [ ] **LOCAL** Generated proposal source/sourceRun/model/target attribution is complete and queryable.
- [ ] **DESTRUCTIVE** Kill accept/reject/revert at each durable transaction phase; retry converges with one archive status and old/new complete bytes.
- [ ] **LOCAL** Run `tests/integration/proposal-durable-recovery.test.ts`, proposal storage/target-binding suites, and proposal stuck-repair before release changes to queue transactions.

---

## 17. Agent, LLM, and Improve

### 17.1 Fake agent success, failure, capture, timeout, and redaction

Configure fake engines from section 4.4.

```sh
akm agent agents/qa-reviewer \
  --engine qa-agent --prompt "Return the fixture marker" --format json \
  > "$AKM_SANDBOX/agent-success.json"
jq -e '.ok == true and .shape == "agent-result" and (.stdout | contains("qa-agent-success"))' \
  "$AKM_SANDBOX/agent-success.json"

akm agent --engine qa-agent-capture \
  --prompt "capture prompt" --cwd "$AKM_SANDBOX" --format json \
  > "$AKM_SANDBOX/agent-capture.json"

set +e
akm agent --engine qa-agent-fail --prompt "fail" --format json \
  > "$AKM_SANDBOX/agent-failure.json"
agent_failure_status=$?
set -e
test "$agent_failure_status" -eq 1
jq -e '.ok == false and .exitCode == 7' "$AKM_SANDBOX/agent-failure.json"
```

- [ ] **AI** Agent asset contributes system prompt/model/tool policy; CLI model override wins.
- [ ] **AI** Prompt, prompt-stdin, cwd, and interactive no-prompt paths are each covered; stored commands and workflows use their canonical commands.
- [ ] **AI** Capture proves exact argv/prompt/cwd and credential-presence boolean without logging credential value.
- [ ] **AI** Nonzero child returns `agent-result` on stdout, CLI exit `1`, child code/reason/stderr retained and redacted.
- [ ] **AI** Missing executable is a bounded spawn failure; timeout kills process group and writes the fake signal marker with no orphan.
- [ ] **AI** `OPENCODE_API_KEY=manual-qa-credential-value` plus echo-secret mode produces no literal value in AKM result, stderr, event, or logs.
- [ ] **AI REGRESSION** Prompt-stdin remains mutually exclusive with `--prompt`; removed aliases such as agent `--command` are absent from help.
- [ ] **AI** Named LLM engine is rejected where agent-only dispatch is required; invalid platform/kind fails before spawn.
- [ ] **AI** Default-engine fallback is announced exactly once when used and never rescues an explicitly invalid named engine.

### 17.2 Fake OpenAI-compatible service

Start/configure sections 4.3 and 4.5.

```sh
: >"$AKM_QA_SERVICE_LOG"

akm remember "Observed manual QA on 2026-08-05" \
  --name qa-enriched --tag manual-qa-seed --enrich --format json \
  > "$AKM_SANDBOX/enriched.json"

grep -q 'manual-qa' "$AKM_BUNDLE_DIR/memories/qa-enriched.md"

akm config set engines.qa-chat.endpoint "$AKM_QA_PROPOSAL_URL" --silent
akm proposal new lesson qa-llm-proposal \
  --task "Create the controlled manual QA lesson" \
  --engine qa-chat --format json >"$AKM_SANDBOX/llm-proposal-default.json"
jq -e '.ok == true and (.ref | endswith("//lessons/qa-llm-proposal"))' \
  "$AKM_SANDBOX/llm-proposal-default.json"

akm config set engines.qa-chat.maxTokens 32 --silent
akm proposal new lesson qa-llm-proposal \
  --task "Repeat the controlled manual QA lesson with an engine cap" \
  --engine qa-chat --format json >"$AKM_SANDBOX/llm-proposal-capped.json"
akm config unset engines.qa-chat.maxTokens --silent
akm config set engines.qa-chat.endpoint "$AKM_QA_CHAT_URL" --silent

jq -s -e '
  ([.[] | select(.pathname == "/ok/chat/completions")]) as $enrich |
  ([.[] | select(.pathname == "/proposal/chat/completions")]) as $proposal |
  ($enrich | length) == 1 and
  $enrich[0].authorizationPresent == true and
  $enrich[0].maxTokensPresent == true and
  ($proposal | length) == 2 and
  all($proposal[]; .authorizationPresent == true) and
  $proposal[0].maxTokensPresent == false and
  $proposal[1].maxTokensPresent == true and
  all(.[]; .responseFormatPresent == false)
' \
  "$AKM_QA_SERVICE_LOG"
```

- [ ] **AI** The seed tag forces the structured remember path; valid response enriches tags/description/date with one bounded request.
- [ ] **AI REGRESSION** `remember --enrich` without another structured argument must still dispatch enrichment. A zero-request raw write is a failure.
- [ ] **AI** HTTP 500, invalid envelope, malformed content, connection refused, and slow endpoint produce typed/fail-soft behavior with no stack/hang/partial write.
- [ ] **AI** Timeout honors engine `timeoutMs`; no removed feature-gate timeout is used.
- [ ] **AI** Explicit symbolic credential is required and authoritative; missing value fails config/dispatch without trying another secret.
- [ ] **AI** Echo-auth 500 response cannot leak the Authorization value into error, log, event, or persisted run result.
- [ ] **AI** Remember's enrichment call sends its intentional caller cap; default proposal chat omits `max_tokens`; configured engine `maxTokens` sends it.
- [ ] **AI** Local endpoint work defaults to one concurrent request on indexing paths; remote defaults remain bounded.
- [ ] **AI** Probe route exercises capability setup using tiny fixed responses only.

Run the standalone enrichment regression separately. It currently fails because
the command takes the raw-write path and makes no request:

```sh
before_requests="$(wc -l <"$AKM_QA_SERVICE_LOG")"
akm remember "Standalone enrichment dispatch oracle" \
  --name qa-enrich-only --enrich --format json \
  >"$AKM_SANDBOX/enrich-only.json"
after_requests="$(wc -l <"$AKM_QA_SERVICE_LOG")"

test "$after_requests" -eq "$((before_requests + 1))"
grep -q 'manual-qa' "$AKM_BUNDLE_DIR/memories/qa-enrich-only.md"
```

### 17.3 Improve dry-run invariants

Dry-run still preflights enabled model-backed processes, so configure the fake
LLM first. It must not call the model or mutate any durable surface.

```sh
snapshot_tree "$AKM_SANDBOX" "$AKM_SANDBOX/before-improve.sha256"
before_requests="$(wc -l < "$AKM_QA_SERVICE_LOG")"

akm improve skills/k8s-deploy \
  --strategy quick --limit 1 --dry-run --no-sync --no-push \
  --format json > "$AKM_SANDBOX/improve-dry-run.json"

after_requests="$(wc -l < "$AKM_QA_SERVICE_LOG")"
test "$before_requests" -eq "$after_requests"
jq -e '
  .schemaVersion == 2 and
  .shape == "improve" and
  .dryRun == true and
  .strategy == "quick"
' "$AKM_SANDBOX/improve-dry-run.json"
```

Do not compare the snapshot file against itself. Produce before/after manifests
outside the hashed tree or exclude those evidence files, then compare config,
bundle, data, state, and cache independently.

- [ ] **AI** Dry-run emits schema-v2 improve result, performs zero model requests, creates no proposal/event/run/lock/log/asset/config/index/git change.
- [ ] **AI** Scope by type/ref, task guidance, bundle validation, limit, strategy, require-feedback-signal, and format shaping are represented in plan.
- [ ] **AI** Retired `--target`, `canary`, and removed auto-accept behavior produce current errors/warnings without poisoned scope.
- [ ] **AI** Unknown strategy/engine/incompatible process fails during preflight before logging/locks/mutation.

### 17.4 Bounded live improve and lock behavior

Use a controlled test-capable model, one asset, and explicit no-sync/no-push:

```sh
akm improve skills/k8s-deploy \
  --task "tighten the description" \
  --strategy quick --limit 1 --no-sync --no-push --json-to-stdout
```

- [ ] **AI** Successful live run persists exactly one `improve_runs` row, emits expected process/proposal events, and queues reviewable changes with provenance.
- [ ] **AI** Default live mode emits progress on stderr and no stdout; json-to-stdout returns the same persisted result.
- [ ] **AI** Lock contention without skip is config exit `78`; `--skip-if-locked` exits `0`, reports `skipped.reason:"lock-held"`, and emits no `improve_invoked`.
- [ ] **AI** Stale lock is reclaimed with an observable recovery event; active lock is never stolen.
- [ ] **AI** Timeout/SIGINT/SIGTERM/SIGHUP persist one terminated run with redacted reason and release locks/children.
- [ ] **AI** Default/frequent/reflect-distill/consolidate/memory/proactive strategies enable exactly documented processes. Autonomy-gated mutations remain off without explicit experimental opt-in.
- [ ] **AI** No sync/push occurs under explicit flags; git publication is tested separately only against disposable remote.
- [ ] **AI** Credential/prompt/session values are absent from improve result, state DB, proposal provenance, health report, event stream, and logs.

---

## 18. Semantic Search

Semantic intent (`off`/`auto`) and runtime readiness are separate. Use a fresh
data/cache/state tier for each case because vectors, fingerprints, and blocked
status are durable.

### 18.1 Isolated semantic tiers and state oracle

```sh
export AKM_QA_BASE_DATA_DIR="$AKM_DATA_DIR"
export AKM_QA_BASE_CACHE_DIR="$AKM_CACHE_DIR"
export AKM_QA_BASE_STATE_DIR="$AKM_STATE_DIR"

use_semantic_tier() {
  tier="$1"
  export AKM_DATA_DIR="$AKM_SANDBOX/semantic/$tier/data"
  export AKM_CACHE_DIR="$AKM_SANDBOX/semantic/$tier/cache"
  export AKM_STATE_DIR="$AKM_SANDBOX/semantic/$tier/state"
  mkdir -p "$AKM_DATA_DIR" "$AKM_CACHE_DIR" "$AKM_STATE_DIR"
}

restore_semantic_dirs() {
  export AKM_DATA_DIR="$AKM_QA_BASE_DATA_DIR"
  export AKM_CACHE_DIR="$AKM_QA_BASE_CACHE_DIR"
  export AKM_STATE_DIR="$AKM_QA_BASE_STATE_DIR"
}
```

| Effective state | Meaning | Search behavior |
| --- | --- | --- |
| `disabled` | Mode is `off` | FTS only, no embedding request |
| `pending` | Enabled but not verified/current fingerprint changed | FTS fallback with advisory |
| `ready-js` | Complete vectors, JavaScript cosine path | Hybrid/vector search |
| `ready-vec` | Complete vectors, sqlite-vec fast path ready | Hybrid/vector search |
| `blocked` | Recent embedding failure | FTS fallback until retry/expiry |

- [ ] **[CORE]** With mode off, full index reports disabled, stores zero
      embeddings, and search remains exact FTS with no model/network request.
- [ ] **[LOCAL]** Info, index verification, health advisory, and search event
      agree on effective state. Config intent remains `auto` after transient
      failure.
- [ ] **[LOCAL]** A blocked status expires to pending after its documented TTL;
      a fingerprint change also returns to pending without deleting keyword data.

### 18.2 Deterministic model-free path

`AKM_EMBED_DETERMINISTIC=1` is a test-only stable hash embedder, not a production
model or relevance-quality claim.

```sh
use_semantic_tier deterministic
akm config unset embedding --silent
akm config set semanticSearchMode auto --silent
export AKM_EMBED_DETERMINISTIC=1

akm index --full --format json \
  >"$AKM_SANDBOX/semantic-deterministic-index.json"
jq -e '
  .verification.ok == true and
  (.verification.semanticStatus == "ready-js" or
   .verification.semanticStatus == "ready-vec") and
  .verification.embeddingCount == .verification.entryCount
' "$AKM_SANDBOX/semantic-deterministic-index.json"

akm search "deploy docker compose in a homelab" \
  --detail full --no-project-context --format json \
  >"$AKM_SANDBOX/semantic-deterministic-search.json"
akm log --type search --limit 1 --detail full --format json \
  >"$AKM_SANDBOX/semantic-deterministic-log.json"
jq -e '.events[-1].metadata.mode == "semantic"' \
  "$AKM_SANDBOX/semantic-deterministic-log.json"

unset AKM_EMBED_DETERMINISTIC
```

- [ ] **[LOCAL]** Index/search make no network or model request.
- [ ] **[LOCAL]** Every embeddable entry has one vector; repeated full index
      yields stable vectors and relevant result set.
- [ ] **[LOCAL]** Full-detail hit explains hybrid/semantic matching and durable
      search telemetry records actual semantic mode. Timing alone is not proof.

### 18.3 Controlled remote embedding service

Start section 4.3 first. The fixture proves transport, batching, persistence,
readiness, and activation, not natural-language relevance.

```sh
use_semantic_tier fake-remote
unset AKM_EMBED_DETERMINISTIC AKM_EMBED_API_KEY
: >"$AKM_QA_SERVICE_LOG"

akm config set embedding "$(jq -nc \
  --arg endpoint "$AKM_QA_EMBED_URL" \
  '{provider:"openai",endpoint:$endpoint,model:"qa-embedding",dimension:4,batchSize:4}')" \
  --silent
akm config set semanticSearchMode auto --silent

akm index --full --format json >"$AKM_SANDBOX/semantic-remote-index.json"
jq -e '
  .verification.ok == true and
  .verification.embeddingProvider == "remote" and
  .verification.embeddingCount == .verification.entryCount and
  (.verification.semanticStatus == "ready-js" or
   .verification.semanticStatus == "ready-vec")
' "$AKM_SANDBOX/semantic-remote-index.json"

akm search deploy --detail full --no-project-context --format json \
  >"$AKM_SANDBOX/semantic-remote-search.json"
jq -s -e '
  [.[] | select(.pathname == "/v1/embeddings")] as $requests |
  ($requests | length) > 0 and
  all($requests[];
    .model == "qa-embedding" and
    .authorizationPresent == false and
    .inputCount >= 1 and .inputCount <= 4)
' "$AKM_QA_SERVICE_LOG"
```

- [ ] **[SERVICE]** Batch/model/auth metadata is exact; request log contains no
      input text or credential value.
- [ ] **[SERVICE]** Query creates one additional embedding request and records
      semantic execution.
- [ ] **[SERVICE]** Wrong envelope, wrong vector count/dimension, HTTP failure,
      slow response, cancellation, and connection refusal are bounded and do not
      invalidate the FTS index.
- [ ] **[SERVICE]** Changing `embedding.dimension` invalidates old vectors and
      an ordinary index regenerates them. Changing indexed text regenerates
      exactly that asset's vector.
- [ ] **[SERVICE]** Changing `embedding.model` to a string that still resolves
      to a compatible model (same dimension, near-identical vectors on
      re-embedding a sample) is verified and KEPT — no purge, the stored
      vectors survive, and `akm index --format json` reports the same
      `embeddingCount` as before. `akm index --reembed` bypasses this check
      and forces a purge + rebuild regardless.
- [ ] **[SERVICE REGRESSION]** A provider-returned vector dimension mismatch is
      rejected rather than stored as ready.

### 18.4 Blocked indexing and query-time fallback

```sh
use_semantic_tier blocked
akm config set embedding "$(jq -nc \
  --arg endpoint "$AKM_QA_BASE_URL/error/embeddings" \
  '{provider:"openai",endpoint:$endpoint,model:"qa-failing",dimension:4,batchSize:4}')" \
  --silent
akm config set semanticSearchMode auto --silent

set +e
akm index --full --format json \
  >"$AKM_SANDBOX/semantic-blocked-index.json" \
  2>"$AKM_SANDBOX/semantic-blocked-index.stderr"
blocked_index_status=$?
set -e

test "$blocked_index_status" -eq 0
jq -e '
  .verification.ok == false and
  .verification.semanticStatus == "blocked"
' "$AKM_SANDBOX/semantic-blocked-index.json"

akm search deploy --detail full --no-project-context --format json \
  >"$AKM_SANDBOX/semantic-blocked-search.json"
jq -e '(.hits | length) > 0 and (.warnings | length) > 0' \
  "$AKM_SANDBOX/semantic-blocked-search.json"
```

- [ ] **[SERVICE]** Index exits `0` because keyword indexing succeeded, but
      semantic verification is explicitly false/blocked and warns.
- [ ] **[SERVICE]** Search exits `0`, returns FTS hits, and records keyword mode.
- [ ] **[SERVICE]** If hard health checks pass, blocked semantic readiness is a
      health warning on stdout with exit `4`, not a hard failure.
- [ ] **[SERVICE REGRESSION]** Query-time provider failure updates durable
      readiness and structured warnings, not stderr only while status stays ready.
- [ ] **[LOCAL REGRESSION]** Targeted writes that skip embeddings cannot leave a
      misleading complete/ready count; next index converges deterministically.

### 18.5 Real local and bounded live gates

```sh
use_semantic_tier local-model
unset AKM_EMBED_DETERMINISTIC AKM_EMBED_API_KEY
akm config unset embedding --silent
akm config set semanticSearchMode auto --silent
akm index --full --verbose --format json \
  >"$AKM_SANDBOX/semantic-local-index.json"
```

- [ ] **[AI]** Package install loads the default local model, keeps all model
      files under isolated `HF_HOME`, reaches ready, and passes a paraphrase
      query through an actual CLI subprocess.
- [ ] **[AI]** Record cold download and warm offline reuse separately. A model
      download failure blocks semantic only and leaves FTS usable.
- [ ] **[AI]** Optional remote provider uses a non-production symbolic key,
      exact model/dimension, batch at most four, bounded spend, and redaction.
- [ ] **[PLATFORM]** Standalone release binary cannot load the externalized local
      transformer dependency; use remote embeddings or mark local gate `N/A`.

Automated real-model gate:

```sh
AKM_SEMANTIC_TESTS=1 \
  bun test --timeout=120000 tests/integration/semantic-search-e2e.test.ts
```

Restore the primary tier after semantic checks:

```sh
restore_semantic_dirs
unset AKM_EMBED_DETERMINISTIC
akm config set semanticSearchMode off --silent
akm config unset embedding --silent
```

---

## 19. Migration, Durability, and Concurrency

### 19.1 Task migration boundary

`akm migrate` has exactly one responsibility: explicit task migration, run as
two generations in one pass — task-v2 to task-v3 source conversion, then
task-v3 to task source v4 conversion against the resulting files. It never
rewrites config or databases.

| Operation | Classification |
| --- | --- |
| `akm migrate status` | Read-only task inventory, both generations |
| `akm migrate apply --dry-run` | Read-only validated conversion plan, both generations |
| `akm migrate apply` | Per-file backup plus atomic task-source replacement, both generations |

- [ ] **[LOCAL]** Status and dry-run report the same generation for each pass
      and change no source, config, database, lock, scheduler, event, or usage
      row.
- [ ] **[LOCAL]** Apply validates complete v3 bytes before replacement,
      preserves mode, and creates the backup immediately before the write; the
      v3-to-v4 generation then runs the same way against the resulting files.
- [ ] **[LOCAL]** A changed generation, ambiguous argv array, unwritable source,
      invalid YAML, or unsafe shell translation is blocked with original bytes
      intact.
- [ ] **[LOCAL]** Normal run/sync/doctor rejects task v2 and task v3 and never
      invokes the migrator as a side effect.

### 19.2 Automatic current database upgrades

Managed `state.db` opens validate the exact migration-ledger prefix and apply
known pending additive migrations automatically. Unknown or reordered ledger
entries fail closed. There is no external storage migration command.

- [ ] **[LOCAL]** A fresh database applies the complete current registry.
- [ ] **[LOCAL]** A database with an exact older prefix advances on open without
      dropping or rewriting durable rows.
- [ ] **[LOCAL]** A newer/unknown or inconsistent ledger is rejected before a
      write.
- [ ] **[LOCAL]** Concurrent first opens serialize each migration exactly once.
- [ ] **[LOCAL]** `index.db` remains regenerable; `state.db` is never deleted as
      a generic recovery step.

### 19.3 Package upgrade boundary

`akm upgrade` updates executable code only. A 0.8 installation moves its old
config/state aside, creates current config/state, and selectively brings
authored assets forward. The explicit task migrator can then convert task-v2
sources through to task source v4. No current runtime loads old
config/storage layouts.

- [ ] **[LIVE DISPOSABLE]** `akm upgrade --check` is nonmutating and the chosen
      npm/Bun/pnpm or standalone path installs the expected version.
- [ ] **[LIVE DISPOSABLE]** A standalone replacement verifies its checksum and
      preflights the staged binary before atomic replacement.
- [ ] **[LIVE DISPOSABLE]** Old and current data sets stay separate; rollback
      restores executable code together with its matching archived data.

### 19.4 Concurrent writers and readers

```sh
akm config set semanticSearchMode off --silent

set +e
akm index --full --format json \
  >"$AKM_SANDBOX/index-race-1.json" 2>"$AKM_SANDBOX/index-race-1.stderr" &
index_pid_1=$!
akm index --full --format json \
  >"$AKM_SANDBOX/index-race-2.json" 2>"$AKM_SANDBOX/index-race-2.stderr" &
index_pid_2=$!
wait "$index_pid_1"; index_status_1=$?
wait "$index_pid_2"; index_status_2=$?
set -e

test "$index_status_1" -eq 0
test "$index_status_2" -eq 0
! grep -qi 'database is locked' "$AKM_SANDBOX"/index-race-*.stderr
test ! -e "$AKM_DATA_DIR/index.db.write.lock"

akm config set search.graphBoost.directBoostPerEntity 0.11 --silent &
config_pid_1=$!
akm config set search.graphBoost.directBoostCap 1.25 --silent &
config_pid_2=$!
wait "$config_pid_1"
wait "$config_pid_2"
jq -e '
  .search.graphBoost.directBoostPerEntity == 0.11 and
  .search.graphBoost.directBoostCap == 1.25
' "$AKM_CONFIG_DIR/config.json"
```

- [ ] **[LOCAL]** Index contender waits/serializes; both complete, verification
      passes, no SQLite lock error or stale writer lease remains.
- [ ] **[LOCAL]** Concurrent independent config writes both survive or one fails
      cleanly after the bounded lock wait; config remains complete JSON.
- [ ] **[LOCAL]** Same-name create races produce one asset/one already-exists;
      different names both survive. Repeat for remember/import/env/secret.
- [ ] **[LOCAL]** Reader during full index sees old or finalized new generation,
      never an empty/intermediate FTS generation.
- [ ] **[LOCAL REGRESSION]** A live writer is never reclaimed solely because a
      wall-clock stale threshold elapsed.
- [ ] **[DESTRUCTIVE]** Sync cannot commit an intermediate multi-file write;
      source update/website/npm refresh are old-or-new complete after kill.

### 19.5 Database and artifact recovery matrix

| Artifact | Recovery rule |
| --- | --- |
| `config.json` | Corruption exits `78`; preserve bytes and restore manually from verified backup |
| `akm.lock` | Preserve corrupt bytes; mutation fails before config/cache/index changes |
| `index.db` | Regenerable after evidence capture: remove/quarantine, then full index |
| `state.db` | Non-regenerable; never delete as repair; restore verified backup |
| transaction journal | Stop writers, retain evidence, use domain recovery |
| Git source cache | Staged swap for read-only sources; writable checkout policy is explicit |
| npm/website cache | Must preserve prior complete generation or report a known failing gate |

- [ ] **[LOCAL]** WAL is default; explicit DELETE/TRUNCATE works; detected network
      filesystems fall back safely; managed connections use bounded busy timeout.
- [ ] **[LOCAL]** State writes use immediate transactions and nested same-
      connection calls join the outer transaction.
- [ ] **[LOCAL]** Atomic write failure yields complete old or new bytes. A parent
      directory fsync failure after rename may report failure with new bytes;
      record that ambiguity rather than claiming rollback.
- [ ] **[LOCAL]** Full rebuild preserves state/events/proposals/workflow history;
      only derived index data is disposable.

### 19.6 Focused automated gates

```sh
bun test --timeout=120000 \
  tests/integration/migrate-format.test.ts \
  tests/migrate/task-v2-to-v3-files.test.ts \
  tests/tasks/migrate-v2-to-v3.test.ts \
  tests/integration/config-recovery-concurrency.test.ts \
  tests/integration/file-lock.test.ts \
  tests/integration/index-writer-lock.test.ts \
  tests/integration/index-writer-lock-crossproc.test.ts \
  tests/integration/proposal-durable-recovery.test.ts
```

---

## 20. Security and Adversarial Testing

Security gates are fail-closed. A green regression suite proves only represented
cases; it does not waive an uncovered boundary. Never turn a known vulnerability
into expected behavior. Hostile archives, DNS/rebinding, kill points, and native
process tests run only in a bounded disposable container or VM.

### 20.1 Failure and evidence oracle

- [ ] Use only dummy credentials, controlled loopback services, local archives,
      and outside-sandbox sentinels. Never contact metadata services, a LAN host,
      production registry, or private infrastructure.
- [ ] Rejected usage normally exits `2`, invalid configuration `78`, dangerous
      install `1`, and health warning `4`. Exit `70`, signal death, resource
      exhaustion, partial publication, or silent success is a failure.
- [ ] For stateful rejection compare config, lock, cache, index, source bytes,
      databases, event cursor, process/listener set, stdout, and stderr.
- [ ] Capture terminal-control fixtures to files and inspect bytes through a
      non-rendering program. Never print them directly to a terminal.
- [ ] Security `FAIL` or `BLOCKED` blocks release unless the release record has a
      named issue, impact, owner, mitigation, approver, and expiry.

### 20.2 Filesystem containment and links

```sh
outside="$AKM_SANDBOX/outside-sentinel"
mkdir -p "$outside"
printf 'outside-must-not-change\n' >"$outside/sentinel"
ln -s "$outside" "$AKM_BUNDLE_DIR/memories/qa-link"

set +e
akm remember 'must not escape' --name escaped --path qa-link \
  >"$AKM_SANDBOX/link-write.stdout" \
  2>"$AKM_SANDBOX/link-write.stderr"
link_status=$?
set -e

test "$link_status" -eq 2
test ! -e "$outside/escaped.md"
test "$(cat "$outside/sentinel")" = outside-must-not-change
rm "$AKM_BUNDLE_DIR/memories/qa-link"
```

- [ ] **[LOCAL]** Remember/import/env/secret/workflow/task/proposal writes reject
      absolute, parent, mixed-separator, NUL, drive/device, and descendant-
      symlink escapes before mutation.
- [ ] **[LOCAL]** Manual and Git-backed walkers skip escaping file/directory
      symlinks, including tracked and untracked Git links. Outside marker never
      enters search/show/snippets/embeddings/model prompts/index DB.
- [ ] **[LOCAL]** Internal links follow one documented containment rule; hardlink,
      FIFO/device, unreadable, disappearing, and rename-race cases stay bounded.
- [ ] **[LOCAL REGRESSION]** Direct write primitives and Git-listed asset reads
      enforce the same realpath boundary. Any outside read/write blocks release.
- [ ] **[LOCAL]** Archive extraction rejects absolute/traversing names, unsafe
      strip results, escaping symlink/hardlink targets, duplicate/type-conflict
      members, devices/FIFOs/sockets, and unsupported types before publication.

### 20.3 SSRF, redirects, DNS, and network budgets

Section 9.8's `NODE_ENV=test` crawl is a protocol seam only. Prove an ordinary
installed CLI cannot activate that seam merely through ambient environment:

```sh
before_requests="$(wc -l <"$AKM_QA_SERVICE_LOG")"
set +e
NODE_ENV=test akm bundle add "$AKM_QA_WEBSITE_URL" \
  --name qa-ambient-bypass --allow-insecure \
  >"$AKM_SANDBOX/ambient-bypass.stdout" \
  2>"$AKM_SANDBOX/ambient-bypass.stderr" </dev/null
ambient_status=$?
set -e

installed="$(akm bundle list --format json |
  jq '[.sources[]? | select(.name == "qa-ambient-bypass")] | length')"
if test "$installed" -ne 0; then
  akm bundle remove qa-ambient-bypass --yes >/dev/null 2>&1 || true
fi

test "$ambient_status" -eq 78
test "$installed" -eq 0
test "$(wc -l <"$AKM_QA_SERVICE_LOG")" -eq "$before_requests"
```

- [ ] **[SERVICE REGRESSION]** Ambient `NODE_ENV=test`/`BUN_TEST=1` cannot bypass
      production private-host policy. Current failure requires a fix, not PASS.
- [ ] **[SERVICE]** Reject loopback/private/link-local/metadata/CGNAT/multicast/
      reserved/documentation IPv4, IPv6, mapped IPv6, NAT64, 6to4, userinfo, and
      non-HTTP schemes.
- [ ] **[SERVICE]** Mixed public/private, empty, and failed DNS results fail
      closed. Validate and constrain every redirect hop, not only the first URL.
- [ ] **[DESTRUCTIVE]** Rebinding fixture proves the connection uses the approved
      address or equivalent enforcement; a second unpinned DNS lookup fails.
- [ ] **[SERVICE]** Strip auth/cookie/proxy-auth on cross-origin redirect and
      bound redirects, DNS, headers/body, bytes, rate-limit wait, and total time.
- [ ] **[SERVICE REGRESSION]** Equivalent egress policy covers website pages/
      robots/feeds, response-derived media URLs, URL health checks, registries,
      npm metadata/tarballs, setup recommendations, and self-update downloads.
- [ ] Request logs prove no forbidden destination was contacted; error text alone
      is not evidence.

### 20.4 Registry, package, Git, and archive trust

- [ ] **[LOCAL]** Git source/ref rejects option-shaped refs, control chars,
      `ext::`, `fd::`, `file:`, unknown/insecure schemes, and revision mismatch.
      Subprocesses use argv, bounded time, and noninteractive auth.
- [ ] **[SERVICE]** npm honors strong SRI before SHA-1, requires integrity,
      validates every redirect host, and executes no package lifecycle script
      while materializing a bundle.
- [ ] **[DESTRUCTIVE]** Archive budgets cover compressed/expanded bytes, member
      count, per-member size, depth, compression ratio, listing/extraction time,
      and partial staging cleanup.
- [ ] **[SERVICE]** Registry response size/count/depth/string limits apply to
      static and skills providers before parse/cache/render. Malformed/control-
      character data cannot poison another registry.
- [ ] **[SERVICE REGRESSION]** Registry list/config/info/search never expose
      literal option credentials or credential-bearing URLs; install guidance is
      inert and safely quoted.
- [ ] **[SERVICE]** Setup binds an official recommendation ID to its expected
      authenticated install ref; an arbitrary configured registry cannot replace
      that ref under the same display ID.
- [ ] **[LOCAL REGRESSION]** Failed add/update/remove restores prior config,
      lock, cache, root, index, and event cursor, including re-add of an existing
      source. No success event precedes security audit.

### 20.5 Dangerous env, secrets, output, and permissions

```sh
before_event="$(akm log --format json | jq -r '.events[-1].id // 0')"
set +e
akm bundle add \
  "$REPO/tests/fixtures/manual-qa/suppressed-dangerous-bundle" \
  --name qa-suppressed-dangerous \
  >"$AKM_SANDBOX/suppressed.stdout" \
  2>"$AKM_SANDBOX/suppressed.stderr" </dev/null
suppressed_status=$?
set -e

test "$suppressed_status" -eq 1
test "$(akm log --format json | jq -r '.events[-1].id // 0')" = "$before_event"
! akm bundle list --format json |
  jq -e '.sources[]? | select(.name == "qa-suppressed-dangerous")'
```

- [ ] **[LOCAL REGRESSION]** Publisher lint suppression cannot suppress
      untrusted install security; scan read errors fail closed; inferred,
      declarative, normal update, and force update use the same pre-publication
      audit.
- [ ] **[LOCAL]** Runtime blocks source-origin `LD_PRELOAD`, `DYLD_*`, `PATH`,
      `NODE_OPTIONS`, `BASH_FUNC_*`, and `GIT_CONFIG_*`; first-party use warns.
- [ ] **[LOCAL]** Exact dummy values and credential-shaped URL/userinfo/query/
      fragment variants are absent from AKM stdout/stderr, errors, events,
      task logs, databases, reports, proposals, workflows, backups, and config.
- [ ] **[LOCAL]** JSON/YAML stay parseable; text/Markdown visibly encode terminal
      controls; HTML escapes attacker fields. Inspect captured bytes only.
- [ ] **[LOCAL]** Env/secret directories and files akm creates are `0700`/`0600`
      even under umask 022, as are config backups and scheduler invocation
      files. The data directory, the databases and their sidecars, and per-run
      task logs take the process umask: akm neither sets nor reports on those.
- [ ] **[PLATFORM]** Windows ACL evidence replaces POSIX mode checks and is marked
      N/A only when genuinely unsupported.

### 20.6 Execution, agents, model output, and listeners

- [ ] **[LOCAL]** Command arrays preserve exact argv for whitespace, quotes,
      semicolons, substitutions, newlines, percent signs, and platform meta-
      characters. No shell appears unless explicitly selected by contract.
- [ ] **[PLATFORM]** Cron/launchd/schtasks serialization round-trips argv without
      shell/XML injection; timeout/cancel removes process tree and scheduler entry.
- [ ] **[AI]** Empty, fenced, think-block, malformed, nested, oversized, and
      schema-invalid model output fails closed within bounded attempts/bytes.
- [ ] **[AI]** Asset text containing fake verdict JSON, rubric overrides, tool
      instructions, and exfiltration requests cannot make a rejecting fake judge
      pass or publish a proposal.
- [ ] **[AI REGRESSION]** Every AKM-managed listener has an unpredictable
      per-process credential. Unauthenticated local requests get `401`, the AKM
      client authenticates, and the credential is never durable.
- [ ] **[AI REGRESSION]** The OpenCode SDK fallback listener is not considered
      safe merely because it binds loopback or chooses a random port.
- [ ] **[LOCAL]** Active-bundle custom wiki fetchers are trusted executable code;
      installation alone cannot import one, and activation requires an explicit
      reviewed trust decision.

### 20.7 Malformed input and resource exhaustion

- [ ] **[LOCAL]** Reject `__proto__`, `constructor`, and `prototype` at every
      config/import merge depth; ordinary object prototypes remain unchanged.
- [ ] **[LOCAL]** Wrong top-level types, duplicate keys, invalid UTF-8/NUL,
      extreme numbers, oversized strings/arrays/nesting, truncated JSON/YAML,
      and YAML alias expansion terminate within bounded memory/time.
- [ ] **[LOCAL]** Workflow source/step/param/fan-out/plan/depth limits fail before
      durable run creation or engine dispatch.
- [ ] **[LOCAL]** Malformed input emits no stack, spawns no child, makes no model
      or public request, writes no partial state, and never exits `70`.
- [ ] Fuzz/property failures retain the seed as a deterministic fixture.

### 20.8 Focused security suite and disposition

```sh
bun test --timeout=120000 \
  tests/redaction.test.ts \
  tests/registry-resolve.test.ts \
  tests/opencode-sdk-runner.test.ts \
  tests/integration/website-ssrf.test.ts \
  tests/integration/tar-utils-scan.test.ts \
  tests/integration/walker.test.ts \
  tests/integration/vault-dangerous-key-install-gate.test.ts \
  tests/integration/vault-dangerous-key-lint.test.ts \
  tests/integration/env-run-dangerous-key-block.test.ts \
  tests/integration/config-sanitize-secrets.test.ts \
  tests/integration/self-update.test.ts
```

Current known failing gates must be fixed or explicitly waived with expiry:

| Boundary | Required disposition |
| --- | --- |
| Ambient test-mode SSRF bypass and secondary URL sinks | `FAIL` until guarded |
| Git/direct-write symlink escape | `FAIL` until contained |
| Archive expanded-resource/type/link budgets | `FAIL` until bounded |
| Registry option/control-data rendering | `FAIL` until redacted |
| Registry URL credential persistence and rendering | `PASS` — #811 passed independent review after seven hardening cycles |
| Suppressible/add-only dangerous-key audit and event ordering | `FAIL` until pre-publication |
| Source lifecycle rollback across config/lock/root/index/events | `FAIL` until atomic/recoverable |
| OpenCode local-listener authentication/documentation | `FAIL` until authenticated |
| Exact-value command-target task-log redaction | `PASS` — fixed in 0.9.1 (#755) |
| Package-manager upgrade exact-version verification | `PASS` — fixed 2026-08-06 (`self-update.ts`) |

---

## 21. Package, Runtime, Platform, and Release

Release acceptance runs against the exact candidate commit and bytes. A local
source build, packed npm artifact, standalone binary, installer, and published
release are different subjects and require separate evidence.

### 21.1 Supported matrix and build boundaries

| Surface | Current support/constraint |
| --- | --- |
| npm package | Node `>=22` bootstrap; Bun `>=1.0` preferred, Node fallback supported |
| Node fallback | Test Node 22 and 24; requires built dist and usable SQLite dependency |
| Standalone | Linux x64/arm64 glibc, macOS x64/arm64, Windows x64 |
| Unsupported standalone | Alpine/musl, 32-bit, native Windows ARM64 |
| POSIX installer | Linux/macOS x64/arm64; `AKM_INSTALL_DIR` override |
| Windows installer | PowerShell 5.1+, x64 binary; ARM64 uses x64 emulation |
| Scheduler | Linux crontab, macOS LaunchAgent, Windows Task Scheduler |

```sh
bun install --frozen-lockfile
bun run check
bun run build

test -x dist/akm
test -x dist/akm-migrate
test -f dist/cli.js
test -f dist/cli-node.mjs
test -f dist/scripts/akm-migrate.js
test -f dist/scripts/akm-migrate-node.js
test ! -e dist/tests

node dist/akm --version
node dist/cli-node.mjs --version
bun dist/cli.js --version
```

- [ ] **[RELEASE]** Build emits `src/**` only plus deliberately copied runtime
      assets and migration entries; no test/general helper tree leaks into dist.
- [ ] **[RELEASE]** Package bins are exactly `dist/akm` and `dist/akm-migrate`,
      both Node-shebang launchers with Bun preference and Node fallback.
- [ ] **[RELEASE]** Relative ESM imports are Node-compatible and all module-local
      text/YAML/XML assets needed at runtime are present.
- [ ] **[RELEASE]** Build may regenerate schema but leaves no unexplained tracked
      diff. Release acceptance uses verify-only lint, not formatting mutation.

### 21.2 npm pack, isolated install, and runtime parity

```sh
bun run test:package
bun test --timeout=120000 \
  tests/package-install.test.ts \
  tests/integration/package-install.test.ts \
  tests/integration/package-launcher.test.ts \
  tests/integration/npm-bin-contract.test.ts

bun run build
# Install the exact spec package.json declares — never a range of your own.
# better-sqlite3 compiles from source whenever there is no prebuilt binary for
# the running Node's ABI, and a from-source build against Node 24.19+ headers
# aborts at teardown (#790). CI does the same read-back. Remove it first:
# `npm install pkg@version` is a no-op when that version is already installed
# and will NOT rebuild the binding for the Node you are about to test with.
rm -rf node_modules/better-sqlite3
npm install --no-save \
  "better-sqlite3@$(node -p "require('./package.json').optionalDependencies['better-sqlite3']")"
AKM_SMOKE_NODE=node bun run test:node-smoke
AKM_SMOKE_NODE=node bun run test:node-compat
```

- [ ] **[RELEASE]** Test-package packs and installs under a temporary prefix,
      verifies package/version/bin ownership, runs both launchers, and cleans up.
- [ ] **[PLATFORM]** Repeat Node smoke/compat on Node 22 and 24. Every gated test
      runs rather than skips; no Bun global leaks into the forced Node path.
- [ ] **[PLATFORM]** Missing/failed/pre-1.0 Bun probe falls back to Node; current
      Bun is selected. Paths with spaces and Windows `%*` preserve argv.
- [ ] **[PLATFORM]** Node 20 package install fails at preinstall with the Node 22
      diagnostic and leaves no usable bins.
- [ ] **[RELEASE]** Packed payload contains required dist/docs/schemas and omits
      source, tests, repository scripts, `.git`, `.akm`, and `node_modules`.
- [ ] **[RELEASE]** Packed README equals `.github/README.npm.md`. Run lifecycle
      staging only in a disposable worktree because it overwrites `README.md`.

`bun run build:install` replaces the configured machine-global installation and
is never an ordinary manual QA command.

### 21.3 Docker and standalone artifacts

```sh
./tests/docker/run-docker-tests.sh

# Focused alternatives:
./tests/docker/run-docker-tests.sh ubuntu-binary
./tests/docker/run-docker-tests.sh --bun-only
./tests/docker/run-docker-tests.sh --binary-only

# Test wrapper; without the variable the file skips:
AKM_DOCKER_TESTS=1 bun test tests/integration/docker-install.test.ts
```

- [ ] **[PLATFORM]** Four Bun-linked source variants pass: Ubuntu, Debian,
      Alpine, Fedora. Three local linux-x64 binary variants pass: Ubuntu,
      Debian, Fedora. Summary is seven passes, zero failures/skips.
- [ ] **[PLATFORM]** Matrix proves CLI startup, bundle create, index/search/show/
      info/list, and incremental indexing. It does not prove npm pack, published
      artifact, installer, self-upgrade, ARM, macOS, or Windows.
- [ ] **[RELEASE]** Cross-compile five exact standalone names; run each on native
      OS/architecture and verify the embedded version and supported command surface.
- [ ] **[RELEASE]** `checksums.txt` covers exactly five binaries and both
      installers. The npm tarball is compared separately because it is generated
      later.

### 21.4 Installers and self-upgrade

Use release-attached installers, not raw `main`, and pin a concrete tag:

```sh
VERSION="$(jq -r .version package.json)"
TAG="v$VERSION"
INSTALL_ROOT="$(mktemp -d)"

curl -fsSL \
  "https://github.com/itlackey/akm/releases/download/$TAG/install.sh" \
  -o "$INSTALL_ROOT/install.sh"
AKM_INSTALL_DIR="$INSTALL_ROOT/bin" bash "$INSTALL_ROOT/install.sh" "$TAG"
"$INSTALL_ROOT/bin/akm" --version
```

- [ ] **[LIVE PLATFORM]** Correct OS/arch asset downloads; exact checksum entry
      verifies before replacement; unsupported arch/tool/permission/mismatch
      fails closed.
- [ ] **[PLATFORM]** Windows installer uses isolated `AKM_INSTALL_DIR`, verifies
      SHA-256, records/reverses PATH mutation, and runs x64 candidate.
- [ ] **[RELEASE]** Installers support `AKM_INSTALL_DIR`; do not document a
      nonexistent `--prefix` option.

Real self-upgrade runs only in a disposable VM/container from a compatible
older 0.9 release:

```sh
unset AKM_UPGRADE_SKIP_CHECKSUM
akm --version
akm migrate status
akm upgrade --check --format json
akm upgrade --format json
akm --version
akm migrate status
akm info
```

- [ ] **[LIVE DESTRUCTIVE]** Check is nonmutating. npm/Bun/pnpm global installs
      invoke their package manager; standalone streams bounded bytes, verifies
      checksum, preflights the staged binary, and atomically replaces it.
- [ ] **[LIVE DESTRUCTIVE]** Failure retains explicit recoverable old/new
      artifacts. Integrity bypass variable is never set for acceptance.
- [ ] **[LIVE]** A 0.8 package can be replaced, but its config/state are not
      runtime inputs: archive them, initialize current paths, then explicitly
      migrate retained task-v2 sources.
- [ ] **[LIVE]** RC/`next` cannot be validated through latest-stable discovery;
      record post-publication stable self-upgrade as blocked until discoverable.

### 21.5 Native scheduler acceptance

Use an installed npm or standalone candidate and a disposable OS account. Do
not hide an ineligible checkout behind `--rebind` in release acceptance.

- [ ] **[PLATFORM]** Doctor reports eligible `npm`/`standalone` binding with
      absolute candidate paths and no credentials in context descriptor.
- [ ] **[PLATFORM]** Add disabled task, inspect native definition, enable/edit +
      sync, trigger, verify candidate version/history/log, delete YAML + sync,
      and prove native removal.
- [ ] **[PLATFORM]** Preserve unrelated crontab/plist/schtasks entries and exact
      argv quoting. Context descriptor is content-addressed and mode `0600` on
      POSIX.
- [ ] **[PLATFORM]** Linux standalone gate runs with its required candidate bin,
      version, and architecture variables.
- [ ] **[PLATFORM]** macOS/Windows native test runs only on disposable GitHub
      Actions with `CI=true`, `GITHUB_ACTIONS=true`, compiled native artifact,
      real runner home, unique task ID, gate dirs, version, and architecture.
- [ ] **[PLATFORM]** Windows Node variant also provides packed `akm.cmd`, exact
      `node.exe`, path-with-spaces gate, and unique node task ID.

A bare `AKM_NATIVE_SCHEDULER_TESTS=1 bun test ...` is insufficient and must not
be recorded as PASS when the test skipped.

### 21.6 Exact release gate and publication

```sh
bun run release:check

# Partial local gate only:
./tests/release-check.sh --skip-docker
```

- [ ] **[RELEASE]** Full script runs workflow syntax/contract, verify-only lint,
      typecheck, build/bin/migration checks, package acceptance, setup/install
      regression, explicit legacy-task migration, Linux standalone scheduler,
      unit, integration, then Docker.
- [ ] **[RELEASE]** Every gated file reports executed tests. Skip-docker is
      partial unless a separate exact-commit matrix transcript exists.
- [ ] **[RELEASE]** Cut the changelog BEFORE triggering the workflow: bump
      `package.json` `version`, rename `## [Unreleased]` to
      `## [<version>] - <YYYY-MM-DD>`, and leave a fresh empty `## [Unreleased]`
      above it. This is functional, not cosmetic —
      `src/commands/sources/migration-help.ts:84` resolves release notes by
      skipping the `Unreleased` heading, so shipping an un-renamed section makes
      the released binary's `akm help migrate latest` report the PREVIOUS
      release's notes. Enforced by `tests/integration/workflow-release.test.ts`
      ("the changelog is cut…"), which `tests/release-check.sh` runs as
      `run_step "Workflow Release Contract"` — so a missed cut fails the release
      gate rather than depending on this checklist being read.
- [ ] **[RELEASE]** Official workflow input version equals committed package
      version and targets the tested SHA. Stable uses npm `latest`; prerelease
      uses `next` and GitHub prerelease.
- [ ] **[RELEASE]** After publication, download every asset, verify checksums,
      compare GitHub/npm tarballs, install under fresh Node 22/24, and run native
      binaries/installers on supported targets.
- [ ] **[RELEASE]** npm version is immutable. Existing GitHub assets may be
      clobbered by rerun, so rerun only identical commit/bytes and compare hashes.

---

## 22. Evidence and Cleanup

### 22.1 Required evidence

Retain outside `/tmp/akm-*` because test cleanup can remove old matching paths:

- [ ] Commit SHA, package version, candidate/artifact digests, OS/architecture,
      Bun/Node/npm versions, exact launcher path, UTC window, tester, tiers.
- [ ] Exact command, exit status, stdout, and stderr as separate files. Preserve
      `PIPESTATUS[0]` when using `tee`.
- [ ] Before/after worktree status and config/lock/bundle/cache/data/state/event
      manifests for stateful failures.
- [ ] Test totals and skip list. An opt-in suite that skipped is `BLOCKED`, never
      `PASS`.
- [ ] Pack manifest, isolated install/bin ownership, Node matrix, Docker summary,
      native scheduler before/after, self-upgrade transcript, release/run URLs,
      npm metadata, release inventory, and checksum transcript where applicable.
- [ ] Every failure's reproduction result and retained rollback/stage/rescue path.
- [ ] Every waiver's issue, impact, owner, mitigation, approver, and expiry.
- [ ] No real token, npmrc, GitHub auth file, raw environment dump, prompt, or
      unredacted secret-bearing state enters evidence.

### 22.2 Cleanup procedure

```sh
if test -n "${AKM_QA_SERVICE_PID:-}"; then
  kill "$AKM_QA_SERVICE_PID" 2>/dev/null || true
  wait "$AKM_QA_SERVICE_PID" 2>/dev/null || true
fi
```

- [ ] Delete test task YAML, sync, and inspect native scheduler to prove no AKM
      test marker/plist/task remains.
- [ ] Remove isolated npm prefixes, installer directories, migration clones,
      writable remotes, containers, and VMs.
- [ ] Remove only the seven exact `akm-test-*` Docker image tags; never broad-
      prune a shared Docker host.
- [ ] Archive failure shard logs/evidence before deleting announced temp roots.
- [ ] Remove `tests/docker/.build` only by exact path after verifying it belongs
      to this checkout.
- [ ] Copy evidence out, then guard sandbox deletion:

```sh
case "$AKM_SANDBOX" in
  /tmp/akm-sandbox.*) rm -rf -- "$AKM_SANDBOX" ;;
  *) printf 'Refusing unsafe cleanup: %s\n' "$AKM_SANDBOX" >&2; false ;;
esac
```

- [ ] Compare final worktree/status to baseline. Explain every remaining change;
      do not use broad Git restore on a shared or dirty worktree.

---

## 23. Change-Based Test Selection

Every production change gets focused tests during iteration and `bun run check`
before merge. `check:changed` is a fixed fast contract battery, not diff-aware
and not a substitute for the full check.

| Changed area | Required escalation beyond focused tests |
| --- | --- |
| CLI dispatcher/output/command CLI | check:changed, envelope/output suites, sections 6 and 8, full check |
| Config/paths/setup/schema | setup/install regression, first-run package path, sections 3 and 6, full check |
| Refs/adapters/index/search/show | contract/ranking/index suites, sections 4 and 7; semantic if vectors/status changed |
| Sources/registry/write-source | provider/write/publication suites, controlled service; LIVE git/npm/HTTPS when lifecycle changed |
| Storage/migration/transactions | crash/concurrency/property/published-upgrade gates, section 19, destructive rehearsal for cutover changes |
| Workflow | workflow unit/integration, gate fake agents, slow expansion, crash/contention when scheduler changed |
| Workflow exec units / subprocess capture | section 14.5 end to end on an engine-less install, plus the worktree isolation and stale-sweep gates; any capture, timeout, or process-group change also runs the agent spawn suites, which share that subprocess layer |
| Workflow child environment / allowlist | section 14.5 environment gates plus section 11; a change to the shared floor is native Windows, not Linux emulation |
| Task/scheduler | task suites, Linux standalone; native macOS/Windows for backend/quoting/binding; published upgrade for schema changes |
| Env/secret/security path/archive/network | env/secret plus traversal/SSRF/archive/redaction/dangerous-key suites, section 20 |
| Agent/LLM/improve/proposal | family suites and fake-service AI pass; live bounded provider only for changed external dispatch |
| Package/runtime/build dependencies | build/package/bin, Node 22/24, Bun launcher, standalone, Docker, release check |
| Installers/self-update/standalone | installer/update suites, exact checksum/artifact tests, native install/upgrade, full release gate |
| Workflows/release-check/Docker | workflow syntax/contract, actual Docker matrix, complete artifact inventory |
| Test preload/helpers/runners | lint isolation, both sharded targets, multiple shard counts, leaked temp/log review |
| Documentation only | doc-example lint and named contract tests; local evidence required because normal CI may skip docs-only changes |

Minimum selection rules:

- [ ] Changes to providers, refs, search/show, config, or output also run
      `tests/contracts/` and read architecture guidance before acceptance.
- [ ] Contract/security/migration/release changes run the full relevant section,
      not one happy-path command.
- [ ] A platform-specific change cannot be passed solely on Linux emulation.
- [ ] A documentation-only change that alters commands runs those examples in a
      sandbox even if code tests are unaffected.

---

## 24. Known Constraints and Blocked Gates

These are current constraints, not historical expected failures. Re-audit this
section before each release and remove an item when its implementation/gate is
fixed.

### 24.1 Supported constraints

1. npm bootstrap requires Node `>=22`; Bun does not remove that requirement.
2. No Alpine/musl standalone, native Windows ARM64, 32-bit, or non-listed target.
3. Standalone binaries cannot load the externalized local transformer model.
4. macOS/Windows schedules are per-user interactive; schedule grammar is narrower
   than Linux cron and Windows expansion is bounded.
5. Docker, semantic E2E, Node compatibility, native scheduler, published upgrade,
   standalone scheduler, real-agent/model, and slow property gates are opt-in.
6. Current normal CI is Ubuntu-centric and does not itself run Docker, real
   embeddings, native macOS/Windows schedulers, or release binaries.
7. The release workflow runs `tests/release-check.sh --skip-docker`
   (build/publication follow it) but not Docker, the slow gate, or the Node
   matrix — those stay separate, opt-in local/CI gates.
8. Docker source variants use `bun link`; binary variants use a locally compiled
   linux-x64 artifact. They do not prove npm/published bytes.
9. Self-upgrade discovery follows latest stable/npm `@latest`, so an unpublished
   or prerelease candidate cannot complete that happy path.
10. 0.8-to-0.9 self-upgrade is deliberately blocked; use explicit migration.

### 24.2 Open release-blocking regression gates

Triaged 2026-08-06 for the 0.9.0 release: every sub-item was assessed against
the actual test/lint/code evidence (an item counts as covered only when a test
*asserts* the property, not merely exercises the path). itlackey reviewed the
triage the same day and directed per-row outcomes: three rows resolved
outright, four targeted fixes landed (registry stale fallback, upgrade
version verification, lint fail-closed, plus the full Semantic row), and the
remaining gaps carry approved waivers with the expiries recorded below.

- [x] **Test harness:** curation cannot leave a schema-less shared `index.db`
      that makes later proposal acceptance tests fail by file order.
      **Resolved 2026-08-06.** Root cause: `openExistingDatabase` created the
      missing file on open (no schema), so `curate`'s fire-and-forget usage
      telemetry planted a broken `index.db` that later proposal acceptance saw
      as existing-but-corrupt. It now refuses to create (`create: false` down
      to the driver) and a missing index throws with an `akm index` remedy.
      Regression pins: `tests/storage/open-existing-database-no-create.test.ts`
      (order-independent distillation of the two-file repro: telemetry no-op →
      write-path fail-open) and the original pair passing in one process
      (`tests/curate-logic.test.ts` + `tests/commands/proposal/adapter-precommit-check.test.ts`).
- [x] **Agent/LLM:** standalone `remember --enrich` dispatches enrichment instead
      of silently taking the raw-write path.
      **Resolved 2026-08-06.** The feared bug was real: `hasStructuredArgs`
      (`src/commands/read/remember-cli.ts`) omitted `args.enrich`, so a bare
      `--enrich` took the zero-flag hot path and never attempted enrichment.
      Fixed (routes like `--auto`; fail-soft unchanged) and the standalone test
      in `tests/integration/remember-frontmatter.test.ts` now asserts the
      enrichment branch ran (warning surfaced), which it previously did not.
- [x] **Semantic:** vector dimension validation, truthful ready-vec, JS fallback
      after fast-path failure, runtime failure status, targeted-write readiness,
      and cancellation propagation.
      **Resolved 2026-08-06** (fix-now directed by itlackey at 0.9.0 triage):
  - Truthful ready-vec: `verifyIndexState` now reports `ready-vec` only when
    the vec fast path is actually serving (`isVecAvailable` AND
    `isVecFastPathReady`); a degraded run reports `ready-js` with an
    `akm index --full` hint. Pinned by
    `tests/integration/index-verification-truth.test.ts` (forces real vec
    insert failures via a width-mismatched mock endpoint; verified to fail
    against the old logic).
  - Dimension validation: `embedding.dimension` is bounded to the vec-table
    guard's 1–4096 in the config schema (fails at `config set` with a clear
    message instead of crashing `akm index`); the DB-layer guard itself is
    pinned in `tests/integration/db.test.ts`.
  - Runtime failure status: a real provider failure (HTTP 500) driven through
    `akmIndex()` to `semanticStatus: "blocked"` is now pinned in
    `index-verification-truth.test.ts`.
  - Cancellation propagation: pre-aborted and mid-run-aborted signals
    rejecting `akmIndex()` are pinned in the same file.
  - JS fallback after fast-path failure: already covered
    (`tests/integration/db.test.ts`, `tests/integration/vector-search.test.ts`).
  - Targeted-write readiness: first-class writes use the same embedding
    materializer as full indexing for the entry IDs they changed. A healthy
    provider makes the write vector-fresh before return; provider failure keeps
    the authored file and FTS row while publishing canonical blocked status.
    Pinned in `tests/integration/indexer/index-written-assets.test.ts`.
- [x] **Durability:** atomic reader-visible index generations, live-lock age,
      full source lifecycle rollback, safe website/npm refresh, strict lockfile,
      registry stale fallback, and sync/write serialization.
      **Closed for 0.9.1** — the last open item (#758) landed; see the
      per-item history below.
  - Covered: strict lockfile (`tests/integration/lockfile.test.ts` corrupt-
    lockfile fail-closed + CAS cases).
  - **Fixed 2026-08-06** (fix-now directed at 0.9.0 triage): registry stale
    fallback — a failed registry fetch now serves the cached index even past
    its TTL, with a warning, instead of hard-failing
    (`src/storage/repositories/registry-cache.ts`; pinned by
    `tests/integration/registry-stale-fallback.test.ts`).
  - **Fixed for 0.9.1** ([#757](https://github.com/itlackey/akm/issues/757),
    [#759](https://github.com/itlackey/akm/issues/759)): four of the five
    partial/open items landed.
    - Live-lock age — a lock whose holder PID is genuinely ALIVE but whose
      mtime has aged past the threshold is now pinned in both directions, at
      the production thresholds, for the index-writer lease and the improve
      run lock (`tests/integration/index-writer-lock.test.ts`,
      `tests/integration/commands/improve/improve-lock-invariants.test.ts`).
      Each positive test fails when `probeLock`'s age branch is disabled; each
      negative control fails when it is made unconditional.
    - Atomic index generations — a second reader connection opened from inside
      `insertTransaction` now proves it observes the complete previous
      generation, never zero or partial rows
      (`tests/integration/indexer/reindex-generation-atomicity.test.ts`).
    - Sync serialization — `createExactPathCommit`'s own CAS is raced by a real
      concurrent commit landing inside the `update-ref` window, mirroring the
      `write-source.ts` pattern
      (`tests/integration/sync-exact-commit-cas.test.ts`).
    - Safe website refresh — this one was a REAL BUG, not just missing
      coverage: the refresh deleted the whole mirror and then wrote pages in
      place, so an interrupted run left a partial mirror that a later
      non-forced run would serve (the freshness marker is only rewritten on
      success, so the stale marker still looked fresh). Fixed with
      staging-dir-then-rename plus an age-gated sweep of abandoned staging
      dirs (`src/sources/snapshot-fetchers/website-ingest.ts`; pinned by
      `tests/integration/website-refresh-interruption.test.ts`, all four cases
      of which fail against the old in-place write). Residual, documented in
      code: publication is two renames, so a kill in that one-syscall window
      leaves the mirror absent — `requireStashDir` callers refresh immediately,
      others recover on the next expiry or `--force`.
  - **Closed for 0.9.1** ([#758](https://github.com/itlackey/akm/issues/758)):
    full source lifecycle rollback — the waiver's named verification test now
    exists as `tests/integration/vault-dangerous-key-blocked-install-rollback.test.ts`.
    It drives the real `akm bundle add` CLI end-to-end against a materialized
    copy of `tests/fixtures/manual-qa/dangerous-bundle/` (whose
    `env/runtime.env` carries `NODE_OPTIONS`), non-TTY and without
    `--allow-insecure`, and asserts every lifecycle surface after the block:
    **byte-level** parity of `config.json` and `akm.lock`, no surviving content
    root, and no orphaned index row. Three workspace states are covered —
    pristine, pre-existing operator config, and a bundle already installed —
    the last of which pins the other direction too: a rollback that reverts
    the FIRST bundle's records is as wrong as one that leaves the refused
    bundle's behind.
    Rollback was found already correct in every case constructible here; the
    test's value is as a pin, so it was mutation-verified against five separate
    breaks (skip the rollback; drop `removeLockEntry`; delete every bundle
    instead of the target; leave the content root; skip the post-rollback
    reindex) and fails on each.
  - Residue accepted by design, asserted explicitly rather than left implicit:
    (a) on a pristine workspace the attempt still SCAFFOLDS `config.json` and
    `akm.lock` — the config/lock writers create their file on first mutation —
    so the test pins that the created `config.json` deep-equals `DEFAULT_CONFIG`
    with no `bundles` key and that `akm.lock` is the empty array, rather than
    asserting absence; (b) the events stream keeps the `add` event for the
    refused ref, because it is an append-only audit log of ATTEMPTS and an
    operator investigating a blocked install needs it on record.
- [ ] **Security:** Git/direct-write symlink containment, authenticated OpenCode
      listener, registry credential/control-data redaction, archive expansion
      budgets, universal redirect/SSRF policy, and unsuppressible update audit.
  - Partial: symlink containment (walker escape cases tested; not exercised
    through a real git-repo walk), registry control-data redaction
    (response-shape limits tested), redirect/SSRF policy (website fetcher has
    the policy; registry fetch does not apply the same private-IP guard).
    Registry URL credential handling is implemented under #811. Strict
    configured-value rejection and conservative diagnostic redaction passed
    independent review after seven hardening cycles; the final focused corpus
    covers 102 cases with 36,895 assertions.
  - Open: authenticated OpenCode listener (localhost listener carries no
    per-process credential), archive expansion budgets (download size capped;
    expansion ratio/member budgets untested).
  - Closed in #765: the unsuppressible update audit stages and re-verifies every
    refreshed bundle before publication; keep the rejection, approval, and
    rollback cases above in the release matrix.
  - Tracking: [#763](https://github.com/itlackey/akm/issues/763) (listener credential),
    [#764](https://github.com/itlackey/akm/issues/764) (archive expansion budgets),
    [#766](https://github.com/itlackey/akm/issues/766) (git symlink containment),
    [#767](https://github.com/itlackey/akm/issues/767) (registry SSRF),
    [#811](https://github.com/itlackey/akm/issues/811) (registry URL credentials,
    completed for 0.9.2).
  - issue: local-attack-surface and hostile-upstream hardening gaps, all
    pre-existing (none regressed in 0.9.0). impact: requires a local
    co-resident attacker, a malicious registry/source, or a compromised
    upstream to exploit. owner: itlackey. verification test: the checklist's
    own §23 items (lines cited in the per-item notes). temporary mitigation:
    sources/registries are operator-chosen; dangerous-env audit runs at
    install; opencode listener binds loopback only. waiver approver:
    itlackey — approved 2026-08-06 (0.9.0 release triage). waiver expiry:
    0.10.0 (hardening series).
- [x] **Secrets/permissions:** exact-value task-log redaction; managed-file
      permission coverage (rejected — see below). **Row closed in 0.9.1:** both
      halves are resolved — the redaction gap is fixed, and permission
      management is a rejected concept rather than outstanding work. No waiver
      remains on this row.
  - Covered: exact-value redaction for prompt-target and workflow-target task
    logs (`tests/integration/tasks-runner.test.ts` "redacts echoed agent
    credentials before task logs are persisted", webhook-URL case).
  - **REJECTED, not fixed** ([#756](https://github.com/itlackey/akm/issues/756),
    reverted in [#791](https://github.com/itlackey/akm/issues/791)). akm briefly
    chmodded the databases, their `-wal`/`-shm` sidecars, and the containing
    data directory to owner-only on every `openManagedDatabase`, and wrote task
    logs `0600` into a `0700` directory. That is no longer the intended
    behavior and should not be re-attempted: enforcing a mode on a directory the
    operator owns — on the most-traveled path in the CLI, including read-only
    opens — silently converted legacy `0755` data dirs and broke installs
    sharing `$XDG_DATA_HOME` across uids, which worked in 0.9.0.
    **Decision: akm does not manage permissions on the data directory, the
    databases, or task logs.** Those take the process umask; protecting the
    data directory is the operator's call and umask/`chmod` is their lever.
    This is scoped, not blanket — akm still creates `env`/`secret` assets,
    config backups and scheduler invocation files at `0600`/`0700` at creation
    time, which is a different act from re-permissioning a directory the
    operator already owned. Nothing survives from that work:
    the health advisory that reported on those modes is gone too — akm does not
    nag about permissions it does not set.
  - **Fixed** ([#755](https://github.com/itlackey/akm/issues/755), 0.9.1).
    Exact-value redaction now runs in `persistRunLog`, the one sink all three
    target kinds funnel through, so the command arm is covered alongside the
    other two. Secret values come from three places, and the distinction matters:
    config-declared credentials and a task's own `redact:` names are redacted at
    any length, while values merely *inferred* from a variable's name must clear
    an 8-character floor. Applying the naive rule the issue proposed — treat
    every non-allowlisted value in the inherited environment as secret —
    classified 127 of 132 variables as credentials, 25 of them one character
    long, and rewrote `3 tests passed` into `[REDACTED] tests passed`. Pinned by
    `tests/tasks/log-redaction.test.ts` and the `runTask — command target` cases
    in `tests/integration/tasks-runner.test.ts`, including an over-redaction
    guard that fails if ordinary build output is ever mangled.
- [ ] **Package/release:** exact package-manager upgrade version verification,
      native installer/scheduler coverage, action/dependency provenance hardening,
      and post-publication artifact parity.
  - **Fixed 2026-08-06** (fix-now directed at 0.9.0 triage): upgrade version
    verification — after a package-manager install "succeeds", `akm upgrade`
    now re-reads `akm --version` from PATH; a confirmed mismatch (lagging
    `@latest` dist-tag) reports `upgraded: false` with the exact-version pin
    remedy and skips `migrate apply` (which would have run against the old
    binary). Fail-open only when verification itself is unavailable.
    (`src/commands/sources/self-update.ts`; pinned in
    `tests/integration/self-update.test.ts`.)
  - **Fixed** ([#771](https://github.com/itlackey/akm/issues/771), 0.9.1):
    publication is gated on the real release-acceptance script.
    `.github/workflows/release.yml` runs `./tests/release-check.sh
    --skip-docker` before version-verify/build/publish, so the npm bin shim,
    the migration bundle under both the Bun and Node entry points, and the
    packed-artifact install are all checked by CI instead of depending on the
    operator remembering `bun run release:check` locally.
  - **Fixed** ([#768](https://github.com/itlackey/akm/issues/768)): every
    third-party `uses:` in `.github/workflows/*.yml` is now pinned to a full
    commit SHA (with the tag preserved as a trailing comment) instead of a
    mutable tag.
  - Partial ([#770](https://github.com/itlackey/akm/issues/770)): native
    scheduler macOS/Windows coverage is no longer unreachable —
    `.github/workflows/gated-ci.yml`'s `native-scheduler` job now runs
    `tests/integration/native-scheduler.test.ts` with
    `AKM_NATIVE_SCHEDULER_TESTS=1` on real `macos-15`/`windows-2022` runners
    (path-gated on PRs, full on the weekly schedule and release-candidate
    tags). `install.ps1` still has no execution harness — its PATH-mutation
    step (`[Environment]::SetEnvironmentVariable(..., "User")`) throws off
    Windows, so a fake-harness approach like `install-script.test.ts` cannot
    deterministically drive it outside a real Windows runner — but
    `tests/integration/install-ps1-syntax.test.ts` now statically parses it
    with PowerShell's own parser (runs on any host with `pwsh`, including
    GitHub's `ubuntu-latest`), catching syntax regressions though not
    semantic ones.
  - Open: post-publish artifact parity (nothing compares npm tarball to
    release assets).
  - Tracking: [#769](https://github.com/itlackey/akm/issues/769) (post-publish artifact parity),
    [#770](https://github.com/itlackey/akm/issues/770) (install.ps1 execution harness, if ever pursued on a real Windows runner).
  - issue: release-infrastructure hardening. impact: a clobbered release
    asset ships silently; tag-hijack of a third-party action could
    compromise the release job. owner: itlackey. verification test: per-item
    notes (workflow-lint for SHA pins; post-publish parity job). temporary
    mitigation: releases are operator-triggered (`workflow_dispatch`) with a
    human watching; `release:check` covers the Linux artifact end-to-end
    when run. waiver approver: itlackey — approved 2026-08-06 (0.9.0 release
    triage). waiver expiry: 0.10.0.
- [ ] **Lint:** invalid type/dir fail-closed behavior, adapter type scoping,
      malformed task coverage, and transactional/publication-aware fixing.
  - **Fixed 2026-08-06** (fix-now directed at 0.9.0 triage): invalid
    `--type`/`--dir` fail closed — a nonexistent `--dir` and an unknown
    `--type` on an akm bundle (the singular/plural typo) are now usage
    errors instead of a false-clean `ok:true, flagged:0`
    (`src/commands/lint/index.ts`; pinned by
    `tests/integration/lint-fail-closed.test.ts`).
  - **Fixed for 0.9.1** (waiver discharged): all three tracked rows landed.
    - [#760](https://github.com/itlackey/akm/issues/760) malformed task YAML —
      the parse failure is now its own `invalid-task-yaml` finding instead of
      collapsing onto `{}` (which every task rule short-circuits on), and a
      `tasks/*.yaml` near miss is collected and flagged for the extension
      rather than skipped by the walk. Fixed on all three task-lint surfaces
      (the CLI sweep, the `akm` adapter's `validate`, and `akm-task`) from one
      shared parse in `src/tasks/schema.ts`; pinned by
      `tests/integration/lint-task-yaml.test.ts`.
    - [#761](https://github.com/itlackey/akm/issues/761) `--fix` safety —
      `--fix` against a bundle configured `writable: false` is now a usage
      error raised before any file is touched, and a per-file fix-write
      failure is reported in-band as `fixed: "failed"` (plus a `lint-failed`
      finding if the per-file dispatch throws) instead of aborting the sweep
      with an uncaught error that hid the fixes already on disk. Pinned by
      `tests/integration/lint-fix-safety.test.ts`.
    - [#762](https://github.com/itlackey/akm/issues/762) adapter type scoping —
      a `--type` passed to a non-akm bundle now emits a warning naming the
      flag and the adapter; findings are unchanged (validation was already a
      superset). Pinned in `tests/integration/lint-adapter-dispatch.test.ts`.
  - Also closed alongside these: [#774](https://github.com/itlackey/akm/issues/774)
    — `missing-skill-md` is reachable again for `agent-skills` (a real
    directory pass over `ValidateContext.list`, replacing the dangling
    `{@link directorySkillDiagnostics}` reference), and opencode's singular
    `skill/` alias is checked identically to `skills/`. Pinned by
    `tests/integration/lint-missing-skill-md.test.ts`.

For each unchecked row record:

```text
issue:
impact:
owner:
verification test:
temporary mitigation:
waiver approver:
waiver expiry:
```

The stale-consolidation CLI recovery surface was removed in 0.9.1; its two
obsolete skipped improve-memory integration cases were deleted during the 0.9.2
cleanup ([#794](https://github.com/itlackey/akm/issues/794)).
Stale transaction journals remain covered through the `stale-txn-journals`
health check. Do not carry historical failures into this list unless they remain
reproducible against the exact candidate.
