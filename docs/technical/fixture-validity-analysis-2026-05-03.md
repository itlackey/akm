# Fixture Validity Analysis — docker-homelab READMEs (2026-05-03)

## Context

Six `README.md` files were added to docker-homelab task workspaces as untracked local changes,
following a bench run (2026-05-03, Qwen 9B, 40-task corpus) that exposed weak pass rates on
three of the six tasks:

| Task | Pre-README pass rate | Rationale recorded in baseline note |
|---|---|---|
| docker-homelab/bridge-network | 20% | "README.md added for next run" |
| docker-homelab/compose-version-upgrade | 40% | "README.md added for next run" |
| docker-homelab/env-from-file | 0% | "README.md added for next run" |
| docker-homelab/named-volume | 80% | Already passing — README added anyway |
| docker-homelab/redis-healthcheck | 60% | Already near target — README added anyway |
| docker-homelab/restart-policy | 80% | Already passing — README added anyway |

The concern: do the new READMEs short-circuit AKM to the point where the akm vs. noakm
comparison becomes meaningless for these tasks?

---

## Step 1 — What is in each README vs. the AKM stash

### AKM stash summary

The docker-homelab stash contains:

- `skill:docker-homelab` (`SKILL.md`) — high-level principles: healthchecks, networking
  philosophy ("create one project network per stack"), volumes ("use named volumes for opaque
  state"), restart policy. No YAML syntax examples.
- `knowledge:compose-conventions` — file layout, image pinning, environment conventions.
  One relevant line: `restart: unless-stopped is the right default for homelab.`
- `knowledge:healthcheck-patterns` — concrete YAML examples for HTTP, Postgres, and Redis
  healthchecks. Redis example uses `redis-cli ping`, `interval: 10s`, `timeout: 3s`,
  `retries: 5`.
- `knowledge:networking` — bridge networking, reverse proxy attachment, DNS. One code block
  showing multi-network service attachment YAML structure.
- `knowledge:troubleshooting` — debugging commands only; no authoring guidance.

The stash does **not** contain explicit YAML for: named-volume declaration syntax,
`env_file:` syntax, `version:` upgrade mechanics, or the specific field names for bridge
network declaration at the compose top level (`networks.internal.driver: bridge`).

### README content analysis

#### bridge-network

README contains:
- Task description ("create a top-level network named `internal` with `driver: bridge`")
- A complete, ready-to-paste solution YAML block
- Exact verification criteria verbatim from the verifier

The solution block shows every field an agent needs: `networks.internal.driver: bridge` at
the top level, and `networks: [internal]` under each service. An agent reading this README
can copy-paste the answer without touching AKM.

The AKM stash (`knowledge:networking`) shows the YAML pattern for external proxy networks but
not for declaring a named internal network. So AKM is not actually needed to know the syntax
once the README provides it.

#### compose-version-upgrade

README contains:
- What to change (`version: "2"` → `version: "3.8"`)
- The exhaustive list of v2-only keys to remove: `mem_limit`, `cpu_shares`, `volume_driver`,
  `cpuset`, `cpu_quota`
- A complete solution YAML block
- Verification criteria

The AKM stash makes no mention of v2→v3 migration, deprecated keys, or the `version:` field
at all. An agent with only the README can solve this with no AKM usage. An agent with only
AKM (and no README) has no information about which v2 keys to remove — this is pure training
knowledge, and the README hands it over directly.

#### env-from-file

README contains:
- The field name `env_file: app.env`
- A complete solution YAML block
- Verification criteria

The AKM stash mentions `env_file:` once in `knowledge:compose-conventions` ("Secrets go in a
sibling `.env.secrets` that's gitignored, loaded via `env_file:`") but does not explain the
syntax or where it goes at the service level. The README provides the full answer. This was
the 0% task; the README was added to recover it.

#### named-volume

README contains:
- Exact field names: `volumes.pgdata` at top level, `volumes: [pgdata:/var/lib/postgresql/data]`
  at the service level
- A complete solution YAML block
- Verification criteria

The AKM skill mentions: "Use named volumes for opaque state (databases, caches)." The stash
does not provide the YAML syntax for declaring a named volume or the `source:target` mount
syntax. The README provides the full answer. This task was at 80% before — agents with
training knowledge apparently already knew the syntax most of the time.

#### redis-healthcheck

README contains:
- The specific command: `["CMD", "redis-cli", "ping"]`
- Exact timing parameters: `interval: 10s`, `timeout: 5s`, `retries: 3`
- A complete solution YAML block
- Verification criteria

The AKM stash (`knowledge:healthcheck-patterns`) contains a Redis healthcheck example with
`interval: 10s`, `timeout: 3s`, `retries: 5`. The README differs (timeout 5s vs 3s, retries
3 vs 5). Since the verifier only checks for the presence of `redis-cli` in the `test` field,
both the README and the stash satisfy it. Here, AKM **does** provide meaningful guidance
independent of the README. However, the README also hands over the exact solution, so AKM is
still unnecessary in practice.

#### restart-policy

README contains:
- The exact value: `restart: unless-stopped`
- A complete solution YAML block
- Verification criteria

The AKM stash (`knowledge:compose-conventions`) contains: "`restart: unless-stopped` is the
right default for homelab." The stash does teach the correct answer. However, the README
also makes it explicit. This was already 80% before the README — the stash was working.

---

## Step 2 — Per-task diagnosis

| Task | Rating | Reasoning |
|---|---|---|
| bridge-network | **Problematic** | README provides complete solution YAML. AKM stash has no bridge network declaration syntax. Agent can pass without AKM. |
| compose-version-upgrade | **Problematic** | README provides the v2-key list and complete solution. AKM stash has no v2→v3 migration content at all. AKM is completely irrelevant. |
| env-from-file | **Problematic** | README provides `env_file: app.env` and complete solution. AKM stash mentions `env_file:` only in passing. AKM is irrelevant. |
| named-volume | **Problematic** | README provides complete YAML with top-level declaration and service mount syntax. AKM stash has no named-volume YAML. AKM is irrelevant. |
| redis-healthcheck | **Borderline** | AKM stash (`knowledge:healthcheck-patterns`) contains a Redis healthcheck example with slightly different timing. Both stash and README get agent to pass. But the README makes AKM redundant in practice. |
| restart-policy | **Benign** | AKM stash explicitly names `restart: unless-stopped` as the homelab default. README confirms the same value. This is the closest to the intended design: README tells the agent WHAT to configure, AKM tells it HOW. But the README includes the full solution YAML, not just the requirement. |

---

## Step 3 — Root cause of the pre-README failures

The actual failure mode was **not** that agents couldn't find the task requirements. The
starting `docker-compose.yml` in each workspace makes the target service obvious. The failures
were:

- **bridge-network (20%)**: Agents did not know the YAML structure for declaring a named
  internal network at the compose top level. The AGENTS.md instructs them to search AKM, but
  the AKM stash has no `networks:` declaration syntax in any asset. Agents either produced
  wrong field names or attached services to the default network only.

- **compose-version-upgrade (40%)**: Agents sometimes correctly changed `version: "3.8"` but
  failed to remove all v2-only keys (especially `cpu_shares`, `cpuset`, `cpu_quota`). The
  stash has no v2 key list. Only agents with strong training-data knowledge of compose v2/v3
  differences passed.

- **env-from-file (0%)**: Agents did not know the field name `env_file:` or its placement.
  The AKM stash does not model this pattern. AGENTS.md instructs AKM search, but AKM has
  nothing useful to return.

In all three failing cases, the root cause was **missing stash content**, not agent
comprehension failure. The fix was applied to the README rather than the stash. That is the
wrong layer.

The three tasks that were already passing (named-volume 80%, redis-healthcheck 60%,
restart-policy 80%) worked because agents drew on training-data knowledge for those
patterns, not because AKM provided it. Adding READMEs to those three tasks also fails to
clarify what AKM's unique contribution is.

---

## Step 4 — The inkwell design as a reference

`inkwell/configure-scaling` demonstrates the intended split correctly:

- **README.md** states WHAT to configure: `min: 2`, `max: 20`, `metric: rps`, `target: 100`.
  These are task-specific values with no universal training-data counterpart. The agent cannot
  guess them.
- **AGENTS.md** explicitly warns: "Do not write YAML from memory — always consult
  `akm show skill:inkwell` first." And critically: "The skill shows field names and value
  types as a schema reference — its examples use placeholder values. Always use the SPECIFIC
  VALUES from this workspace's README.md."
- **AKM stash** provides the YAML field names and value types (`min`, `max`, `metric`,
  `target`) as a non-obvious schema that differs from any standard. Agents without AKM
  cannot know these field names from training data.

The key property: the README provides **opaque task-specific values** that have no training
analogue, while AKM provides **non-obvious YAML schema** that the agent cannot fabricate.
Neither alone is sufficient.

The docker-homelab READMEs invert this: they provide both the values AND the schema AND the
complete solution YAML. The AGENTS.md then tells agents to search AKM anyway, but AKM either
duplicates what the README said or adds nothing.

---

## Step 5 — Analysis and recommendations

### 5.1 The fundamental problem

These docker-homelab tasks use standard Docker Compose patterns that any capable model already
knows from training data. Unlike the inkwell tasks (which use a fictional service with an
invented YAML schema), docker-compose is documented extensively in public training corpora.
This makes the docker-homelab domain inherently problematic for an AKM effectiveness
benchmark: the gap between "with AKM" and "without AKM" will be small regardless of fixture
design, because agents already know the syntax.

The READMEs compound this by removing the last remaining reason an agent might need to consult
AKM — namely, uncertainty about the exact field name or value when not sure from training
data.

### 5.2 What the READMEs should and should not contain

The correct design follows the inkwell principle:

**README should contain:**
- The task goal in plain English (what the agent must achieve)
- Service names, image references, target values — things specific to this workspace
- No YAML syntax, no field names, no solution code

**AKM stash should contain (and currently does not, for most cases):**
- The YAML syntax for the operation being tested
- Field names, accepted values, required structure
- Examples that demonstrate structure but use placeholder values the agent must replace

**README should NOT contain:**
- A "Required result" block with complete solution YAML
- The exact field names and values an agent needs to write
- Verbatim verification criteria

### 5.3 AKM-centric alternative designs

**bridge-network**: Remove the solution YAML. README states: "Create a custom bridge network
named `internal` and attach both the `api` and `worker` services to it." Add to
`knowledge:networking` a YAML snippet showing `networks:` top-level declaration with
`driver: bridge` and the per-service `networks:` list syntax (with placeholder names). Agents
must search AKM to find that YAML structure.

**compose-version-upgrade**: Remove the solution YAML and the v2 key list from the README.
README states: "Upgrade this compose file from v2 to v3.8." Add a new knowledge asset
`knowledge:compose-migration.md` covering the v2→v3 migration: version string change,
deprecated service-level keys (`mem_limit`, `cpu_shares`, `volume_driver`, `cpuset`,
`cpu_quota`), and their v3 equivalents or absence. This is the highest-impact fix: the stash
currently has zero migration content.

**env-from-file**: README states: "The `app` service should load its environment from
`app.env`." Expand `knowledge:compose-conventions` (or `SKILL.md`) to document `env_file:`
placement and syntax. The stash currently mentions it only in a secrets context; it needs a
proper working example at the service level.

**named-volume**: README states: "Add persistent storage for the `postgres` service using a
named volume called `pgdata` mounted at `/var/lib/postgresql/data`." Expand `SKILL.md` or
add `knowledge:volumes.md` with the YAML syntax for top-level volume declaration and
`source:target` shorthand notation. The stash currently says "use named volumes" but never
shows the syntax.

**redis-healthcheck**: README states: "Add a health check to the `redis` service using the
`redis-cli` probe." The AKM stash already has a Redis healthcheck example in
`knowledge:healthcheck-patterns`. Remove the complete solution block from the README. The
stash example alone is sufficient. (Timing values differ slightly between README and stash;
verifier only checks for `redis-cli` presence, so both are valid.)

**restart-policy**: README states: "Configure the `web` service with the appropriate restart
policy for a homelab deployment." The AKM stash already names `unless-stopped` as the
homelab default. Remove the explicit value and solution YAML from the README. Let agents
learn the right policy from AKM. This is the task closest to correct design already.

### 5.4 Should the README files be revised?

Yes, but the priority order matters:

1. **High priority — revise**: `bridge-network`, `compose-version-upgrade`, `env-from-file`.
   These are the three tasks that were failing (20%, 40%, 0%). The READMEs were added to fix
   pass rate, but did so by providing the answer rather than by improving the stash. Fix: trim
   README to requirements-only AND add the missing stash content. Both changes are needed.

2. **Medium priority — revise**: `named-volume`. Was passing at 80% via training-data
   knowledge, not AKM. The README now makes AKM completely unnecessary. Fix: same approach —
   requirements-only README, add named-volume YAML syntax to the stash.

3. **Low priority — trim solution block**: `redis-healthcheck` and `restart-policy`. The stash
   already contains the relevant content for these. The README solution block is redundant but
   not critically damaging, since the stash content does exist. At minimum, remove the
   "Required result" YAML block; keep the requirement description.

### 5.5 Broader observation

The bench run artifacts (all `budget_exceeded` for the test model, no real agent outcomes
available yet) mean the actual noakm vs. akm delta from these READMEs has not been measured.
However, the structural argument is clear: once the README contains a complete "Required
result" block, any model capable of reading the README will pass without consulting AKM. The
noakm arm (if implemented) would pass just as readily. The akm/noakm delta collapses to zero
on these tasks, making them unable to demonstrate AKM value.

The correct benchmark design principle for all future docker-homelab (and similar real-world
domain) tasks: the AKM stash must be the **only** place that answers "what is the exact YAML
structure." The README must be the **only** place that answers "what specific configuration
does this particular workspace need." Neither should answer the other's question.
