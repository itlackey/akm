# akm-bench seeded corpus

Thirty-seven hand-authored tasks across six domains. Each task references a
fixture stash by name (`tests/fixtures/stashes/<name>/`). The `_example/`
subtree exists for loader unit tests and is excluded by `listTasks()` by
default — see `tests/bench/corpus.ts`.

The original three domains (docker-homelab, az-cli, opencode) measure task
success. The fourth domain — `workflow-compliance/` — measures whether the
agent follows AKM workflow process even when shortcuts are tempting,
retrieval is noisy, or feedback requires discipline. See
`workflow-compliance/README.md` for the per-task breakdown. The fifth and
sixth domains — `drillbit/` and `inkwell/` — are fictional CLIs used to
measure task success on novel procedural skills without leakage from training
data.

Train/eval split: 23 train, 14 eval. drillbit and inkwell now have both
train and eval tasks, enabling Track B (evolve) to run on all 6 domains.

## Tasks

| id | domain | slice | fixture | verifier | leakage check |
|---|---|---|---|---|---|
| docker-homelab/redis-healthcheck | docker-homelab | train | docker-homelab | pytest | SKILL.md mentions `redis-cli ping` as one of several in-container probes; verifier asserts `services.redis.healthcheck.test` contains `redis-cli`. The literal `services.redis.healthcheck.test: redis-cli ping` does not appear in the gold ref. |
| docker-homelab/restart-policy | docker-homelab | train | docker-homelab | pytest | SKILL.md does not contain the literal `restart: unless-stopped` or `services.web.restart`. |
| docker-homelab/env-from-file | docker-homelab | train | docker-homelab | pytest | SKILL.md does not contain `env_file:` or `./app.env`. |
| docker-homelab/named-volume | docker-homelab | eval | docker-homelab | pytest | SKILL.md mentions named volumes generally; the literal path `/var/lib/postgresql/data` and the volume name `pgdata` do not appear. |
| docker-homelab/bridge-network | docker-homelab | eval | docker-homelab | pytest | SKILL.md describes bridge networking generally; the literal network name `internal` and the YAML structural fragments do not appear. |
| docker-homelab/compose-version-upgrade | docker-homelab | train | docker-homelab | pytest | SKILL.md states "compose v3+" generally; the literal string `version: "3.8"` and the v2-only key list (`mem_limit`, `cpu_shares`) do not appear. |
| az-cli/create-resource-group | az-cli | train | az-cli | script | verify.sh greps `commands.txt` for `az group create`, `-n/--name myrg`, `-l/--location eastus`. SKILL.md describes RG lifecycle generally; none of those grep clauses appear verbatim. |
| az-cli/assign-managed-identity | az-cli | eval | az-cli | script | verify.sh greps for `az vm identity assign`, `-g/--resource-group myrg`, `-n/--name myvm`. SKILL.md does not contain any of these clauses. |
| az-cli/query-by-tag | az-cli | train | az-cli | script | verify.sh greps for `az resource list` and `--tag env=prod`. SKILL.md does not contain either. |
| az-cli/keyvault-secret-set | az-cli | train | az-cli | script | verify.sh greps for `az keyvault secret set`, `--vault-name myvault`, `-n/--name dbpass`. SKILL.md does not contain these. |
| az-cli/aks-get-credentials | az-cli | eval | az-cli | script | verify.sh greps for `az aks get-credentials`, `-g/--resource-group myrg`, `-n/--name mycluster`. SKILL.md does not contain these. |
| az-cli/storage-account-create | az-cli | eval | az-cli | script | verify.sh greps for `az storage account create`, `-n/--name mystorage`, `--sku Standard_LRS`, `-g/--resource-group myrg`. SKILL.md does not contain these. |
| opencode/agents-md-akm-snippet | opencode | eval | multi-domain | script | gold ref `skill:opencode` (multi-domain) describes opencode generally; does not contain the phrase `akm search` or an `AGENTS.md` snippet. |
| opencode/opencode-config-model | opencode | train | multi-domain | script | gold ref mentions `opencode.json` for model config generally; does not pin `anthropic/claude-opus-4-7` verbatim. |
| opencode/tool-allowlist | opencode | train | multi-domain | script | gold ref does not list `["bash","edit","read"]` or describe a tool allowlist. |
| opencode/provider-akm-feedback | opencode | eval | multi-domain | script | gold ref does not mention `akm feedback` or `provider.sh`. |
| opencode/system-prompt-snippet | opencode | train | multi-domain | script | gold ref does not contain a system-prompt snippet referencing `akm feedback`. |
| workflow-compliance/tempting-shortcut-arithmetic | workflow-compliance | train | minimal | script | No `gold_ref`. Verifier computes the expected sum at runtime via `$((2+2))`; the literal `4` does not appear in the script. |
| workflow-compliance/distractor-docker-port-publish | workflow-compliance | eval | noisy | pytest | gold ref `skill:docker` (in `noisy`) describes compose generally; the literal `8080`, `nginx:1.27`, and the multi-subscript chain `services["web"]["ports"]` do not appear. |
| workflow-compliance/feedback-trap-az-tag-list | workflow-compliance | train | az-cli | script | gold ref discusses `--query` and `-o tsv` generally; the literal `az resource list`, `--tag env=prod`, `--tag tier=data`, and the JMESPath projection regex do not appear. |
| workflow-compliance/abstention-rust-async-haiku | workflow-compliance | eval | minimal | script | Abstention case — no `gold_ref`. Verifier checks file shape (3 non-empty lines), no content match. |
| workflow-compliance/repeated-fail-storage-lifecycle-a | workflow-compliance | train | az-cli | script | gold ref does not contain `management-policy`, `blockBlob`, or `daysAfterModificationGreaterThan`. |
| workflow-compliance/repeated-fail-storage-lifecycle-b | workflow-compliance | train | az-cli | script | gold ref does not contain `management-policy`, `blockBlob`, `daysAfterLastAccessTimeGreaterThan`, or `tierToCool`. |
| drillbit/backup-policy | drillbit | eval | drillbit | script | SKILL.md describes the `backup` subcommand generally; the literal cluster name `vault-primary`, `--retention 90d`, and `--snapshots 7` do not appear verbatim. |
| drillbit/canary-enable | drillbit | eval | drillbit | script | SKILL.md describes the `canary enable` subcommand; the literal cluster name `staging-west` and `--weight 20` do not appear verbatim. |
| drillbit/provision-edge | drillbit | eval | drillbit | script | SKILL.md describes `provision` flags generally; the literal cluster name `sentinel-1`, `--tier edge`, `--region az-west`, and `--replicas 3` do not appear verbatim. |
| drillbit/rotate-secret | drillbit | eval | drillbit | script | SKILL.md describes `secret rotate` flags; the literal path `services/auth/token` and `--algorithm ed25519` do not appear verbatim. |
| drillbit/scale-replicas | drillbit | eval | drillbit | script | SKILL.md describes `scale` generally; the literal cluster name `prod-core` and `--replicas 8` do not appear verbatim. |
| drillbit/backup-policy-train | drillbit | train | drillbit | script | SKILL.md describes the `backup` subcommand generally; the literal cluster name `logs-archive`, `--retention 30d`, and `--snapshots 14` do not appear verbatim. |
| drillbit/scale-replicas-train | drillbit | train | drillbit | script | SKILL.md describes `scale` generally; the literal cluster name `dev-edge` and `--replicas 4` do not appear verbatim. |
| inkwell/add-healthcheck | inkwell | eval | inkwell | pytest | SKILL.md describes the `healthcheck` block fields; the literal values `/health`, `10`, and `3` do not appear in the gold ref. |
| inkwell/configure-scaling | inkwell | eval | inkwell | pytest | SKILL.md describes `scaling` fields generally; the literal `metric: rps`, `target: 100`, `min: 2`, `max: 20` do not appear verbatim. |
| inkwell/cpu-scaling | inkwell | eval | inkwell | pytest | SKILL.md describes CPU scaling; the literal `metric: cpu`, `target: 65`, `min: 1`, `max: 8` do not appear verbatim. |
| inkwell/new-service | inkwell | eval | inkwell | pytest | SKILL.md describes the basic structure; the literal service name `api-gateway`, image `gateway:v2`, and port `8080` do not appear verbatim. |
| inkwell/set-rate-limit | inkwell | eval | inkwell | pytest | SKILL.md describes `limits` fields; the literal `rps: 500` and `burst: 1000` do not appear verbatim. |
| inkwell/new-service-train | inkwell | train | inkwell | pytest | SKILL.md describes the basic structure; the literal service name `auth-proxy`, image `proxy:v1`, and port `9090` do not appear verbatim. |
| inkwell/add-healthcheck-train | inkwell | train | inkwell | pytest | SKILL.md describes the `healthcheck` block fields; the literal values `/readyz`, `15`, and `2` do not appear in the gold ref. |

## Memory-operation tags (#262)

Every real corpus task carries at minimum a `memory_ability` and `task_family`
tag. Both are OPTIONAL in the schema — the loader leaves them undefined for
legacy tasks and `aggregateBy*` helpers skip rows where the keying tag is
missing.

`memory_ability` (closed set, see `tests/bench/corpus.ts`):

| value | what the task exercises |
|-------|--------------------------|
| `procedural_lookup` | find and apply a single procedural skill |
| `multi_asset_composition` | combine guidance from two+ assets |
| `temporal_update` | apply newer guidance over older versions |
| `conflict_resolution` | choose between conflicting assets |
| `abstention` | recognise no relevant asset exists and decline to load |
| `noisy_retrieval` | succeed despite distractor / irrelevant assets |

`task_family` follows `<domain>/<short-name>` (e.g.
`docker-homelab/compose-basics`). Tasks sharing a family are expected to
transfer knowledge between each other; the utility report aggregates pass
rate / akm − noakm delta per family.

Optional booleans (`abstention_case`, `conflict_case`, `stale_guidance_case`)
flag the structural shape of the task. `expected_transfer_from[]` lists
families the agent should benefit from when memory carries over.
`workflow_focus` names the declarative workflow (#255) the task targets.

The utility report's `corpus_coverage` block surfaces:
- counts per memory-ability label (closed set + `untagged`),
- per-memory-ability pass-rate / delta / negative-transfer counts,
- per-task-family rollups when ≥ 2 families are tagged,
- workflow-compliance means when the runner plumbs the trace.

### Coverage in this release

| ability | train tasks | eval tasks | notes |
|---------|------------|-----------|-------|
| `procedural_lookup` | 18 | 13 | core coverage across all 6 domains |
| `temporal_update` | 2 | 0 | workflow-compliance/repeated-fail-storage-lifecycle-{a,b} |
| `abstention` | 2 | 1 | tempting-shortcut-arithmetic (train), abstention-rust-async-haiku (eval) |
| `noisy_retrieval` | 0 | 1 | workflow-compliance/distractor-docker-port-publish |
| `multi_asset_composition` | 0 | 0 | no tasks yet — future wave |
| `conflict_resolution` | 0 | 0 | no tasks yet — future wave |

Per-domain task families:

| family | tasks |
|--------|-------|
| `az-cli/commands` | 6 |
| `docker-homelab/compose-basics` | 6 |
| `opencode/config-basics` | 5 |
| `drillbit/scale` | 2 |
| `drillbit/backup` | 2 |
| `drillbit/canary` | 1 |
| `drillbit/provision` | 1 |
| `drillbit/secret` | 1 |
| `inkwell/service` | 2 |
| `inkwell/healthcheck` | 2 |
| `inkwell/scaling` | 2 |
| `inkwell/limits` | 1 |
| `workflow-compliance/feedback-polarity` | 1 |
| `workflow-compliance/repeated-failure` | 2 |
| `workflow-compliance/tempting-shortcut` | 1 |

Future waves will add `multi_asset_composition` and `conflict_resolution`
tasks to reach full 6/6 ability coverage.

## Leakage discipline (spec §7.4)

The `tests/bench/leakage.test.ts` suite enforces a substring check between
each verifier's *structural* assertions (regex literals, Python subscript
chains, shell `grep`/`jq` patterns) and the gold-ref SKILL.md content. The
table above is the human-reviewed counterpart: each row records the manual
check the corpus author performed against the shipped fixture stash content
on `release/0.7.0`.

If a fixture stash skill is later expanded to include a fragment that
satisfies a verifier directly, both the table entry and the automated test
will need to be revisited.
