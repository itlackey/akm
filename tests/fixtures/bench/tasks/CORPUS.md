# akm-bench seeded corpus

Seventeen hand-authored tasks across three domains. Each task references a
fixture stash by name (`tests/fixtures/stashes/<name>/`). The `_example/`
subtree exists for loader unit tests and is excluded by `listTasks()` by
default — see `tests/bench/corpus.ts`.

Train/eval split: 9 train, 8 eval (~50/50 per domain: docker 3+3, az 3+3,
opencode 3+2).

## Tasks

| id | domain | slice | fixture | verifier | leakage check |
|---|---|---|---|---|---|
| docker-homelab/redis-healthcheck | docker-homelab | eval | docker-homelab | pytest | SKILL.md mentions `redis-cli ping` as one of several in-container probes; verifier asserts `services.redis.healthcheck.test` contains `redis-cli`. The literal `services.redis.healthcheck.test: redis-cli ping` does not appear in the gold ref. |
| docker-homelab/restart-policy | docker-homelab | train | docker-homelab | pytest | SKILL.md does not contain the literal `restart: unless-stopped` or `services.web.restart`. |
| docker-homelab/env-from-file | docker-homelab | train | docker-homelab | pytest | SKILL.md does not contain `env_file:` or `./app.env`. |
| docker-homelab/named-volume | docker-homelab | eval | docker-homelab | pytest | SKILL.md mentions named volumes generally; the literal path `/var/lib/postgresql/data` and the volume name `pgdata` do not appear. |
| docker-homelab/bridge-network | docker-homelab | eval | docker-homelab | pytest | SKILL.md describes bridge networking generally; the literal network name `internal` and the YAML structural fragments do not appear. |
| docker-homelab/compose-version-upgrade | docker-homelab | train | docker-homelab | pytest | SKILL.md states "compose v3+" generally; the literal string `version: "3.8"` and the v2-only key list (`mem_limit`, `cpu_shares`) do not appear. |
| az-cli/create-resource-group | az-cli | train | az-cli | regex | SKILL.md describes RG lifecycle generally; the literal `az group create --name myrg --location eastus` does not appear. |
| az-cli/assign-managed-identity | az-cli | eval | az-cli | regex | SKILL.md does not contain `az vm identity assign` or the literal `-g myrg -n myvm`. |
| az-cli/query-by-tag | az-cli | train | az-cli | regex | SKILL.md does not contain `az resource list --tag env=prod`. |
| az-cli/keyvault-secret-set | az-cli | train | az-cli | regex | SKILL.md does not contain `az keyvault secret set --vault-name myvault --name dbpass`. |
| az-cli/aks-get-credentials | az-cli | eval | az-cli | regex | SKILL.md does not contain `az aks get-credentials -g myrg -n mycluster`. |
| az-cli/storage-account-create | az-cli | eval | az-cli | regex | SKILL.md does not contain `az storage account create --name mystorage --sku Standard_LRS`. |
| opencode/agents-md-akm-snippet | opencode | eval | multi-domain | script | gold ref `skill:opencode` (multi-domain) describes opencode generally; does not contain the phrase `akm search` or an `AGENTS.md` snippet. |
| opencode/opencode-config-model | opencode | train | multi-domain | script | gold ref mentions `opencode.json` for model config generally; does not pin `anthropic/claude-opus-4-7` verbatim. |
| opencode/tool-allowlist | opencode | train | multi-domain | script | gold ref does not list `["bash","edit","read"]` or describe a tool allowlist. |
| opencode/provider-akm-feedback | opencode | eval | multi-domain | script | gold ref does not mention `akm feedback` or `provider.sh`. |
| opencode/system-prompt-snippet | opencode | train | multi-domain | script | gold ref does not contain a system-prompt snippet referencing `akm feedback`. |

## Leakage discipline (spec §7.4)

The `tests/bench/leakage.test.ts` suite enforces a substring check between
each verifier's *structural* assertions (regex literals, Python subscript
chains, shell `grep`/`jq` patterns) and the gold-ref SKILL.md content. The
table above is the human-reviewed counterpart: each row records the manual
check the corpus author performed against the shipped fixture stash content
on `release/1.0.0`.

If a fixture stash skill is later expanded to include a fragment that
satisfies a verifier directly, both the table entry and the automated test
will need to be revisited.
