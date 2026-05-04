# add-healthcheck regression analysis — 2026-05-03

## Summary

`inkwell/add-healthcheck` regressed from **100% → 20%** pass rate after commit `760bf73`
(`feat(akm+bench): implement agent compliance improvements (REC-01 to REC-09)`).
This is the single largest task regression (-80pp) in the current session.

---

## What changed in commit 760bf73

Three changes landed simultaneously:

### 1. `src/output/text.ts` — APPLY directive appended to `akm show` output (REC-01/09)

```
APPLY: Copy field names, value types, and formats exactly from the content above.
Do not substitute approximations. Run `akm feedback 'skill:inkwell' --positive` after the task succeeds.
```

This directive is appended after the entire SKILL.md content every time an agent runs
`akm show skill:inkwell`.

### 2. `src/output/text.ts` — "Next: akm show" hint appended to `akm search` output (REC-02)

```
Next: akm show 'skill:inkwell'
```

### 3. `tests/fixtures/bench/tasks/inkwell/add-healthcheck/workspace/AGENTS.md` — added (REC-04)

```markdown
## Required workflow
1. Run `akm search 'inkwell service'`
2. Run `akm show skill:inkwell`
3. Apply ONLY the field names and value formats shown — do not use approximations
4. Edit the workspace file using the schema from step 2
5. Run `akm feedback skill:inkwell --positive` if the task succeeds
```

### 4. `tests/fixtures/stashes/inkwell/skills/inkwell/SKILL.md` — frontmatter expanded (735fe81, one commit prior)

The `description` field was expanded with keywords and `tags:` array added to improve FTS5
ranking. The body of SKILL.md was not changed.

---

## The structural conflict in SKILL.md

The SKILL.md has two healthcheck code examples with **different values**:

**Section `## healthcheck` (correct for this task):**
```yaml
spec:
  healthcheck:
    path: /health
    interval: 10
    threshold: 3
```

**Section `## Full example` (different values):**
```yaml
spec:
  healthcheck:
    path: /healthz      # <-- different path
    interval: 15        # <-- different interval
    threshold: 2        # <-- different threshold
```

The test verifier (`test_healthcheck.py`) requires exactly `path=/health`, `interval=10`,
`threshold=3`. An agent that applies the full-example values fails all three assertions.

---

## Root cause hypothesis (ranked by confidence)

### Hypothesis 1 — APPLY directive + full example causes value substitution [HIGH CONFIDENCE]

**Confidence: ~85%**

Before 760bf73: agents read the README (which states `path: /health`, `interval: 10 seconds`,
`threshold: 3`) and independently looked up field NAMES from the skill. The task passed at
100% because the README values were the primary reference.

After 760bf73: the APPLY directive appended by `akm show` tells the agent:
> "Copy field names, value types, and formats **exactly** from the content above."

"Content above" includes the `## Full example` section, which uses `/healthz`, `15`, and `2`.
An agent following the APPLY directive literally copies these values instead of the README's
required values. Since the directive says "do not substitute approximations" and "copy exactly",
agents have strong textual authority to use the full-example values.

**Supporting evidence — cross-task correlation:**

| Task | Baseline | Current | Delta | SKILL.md full-example matches task? |
|------|----------|---------|-------|--------------------------------------|
| add-healthcheck | 100% | 20% | **-80%** | NO (path:/healthz 15/2 vs /health 10/3) |
| new-service | 40% | 80% | **+40%** | YES (api-gateway, gateway:v2, port 8080) |
| set-rate-limit | 60% | 40% | **-20%** | NO (rps:1000/burst:2000 vs rps:500/burst:1000) |
| configure-scaling | 60% | 60% | 0% | NO (target:200 vs target:100) |
| cpu-scaling | 100% | 80% | **-20%** | NO (scaling values in full example differ) |

The pattern is consistent: tasks where the SKILL.md full example happens to use different
values from what the task requires regress; tasks where the full example matches improve.

`new-service` improved because the task requires (`api-gateway`, `gateway:v2`, `8080`) which
happen to be the exact values in the full example. The APPLY directive caused agents to produce
correct output by copying the example directly.

### Hypothesis 2 — AGENTS.md step 4 de-emphasizes the README [MEDIUM CONFIDENCE]

**Confidence: ~60%**

AGENTS.md step 4 says: "Edit the workspace file using the schema from step 2" (the skill).
Step 3 (reading the README for task requirements) is not mentioned in AGENTS.md at all.
This subtly trains agents to anchor on the skill content rather than on the README values.

The driver's default prompt (`tests/bench/driver.ts` line ~408) explicitly includes:
> "Step 3 — read README.md ... to understand the specific task requirements"
> "Step 4 — using the skill content from step 2 AND task requirements from step 3"

AGENTS.md overrides this when present (it is the agent's AGENTS.md in the workspace cwd)
and its step 4 omits "AND task requirements from README.md". This may cause agents to
skip or underweight the README.

### Hypothesis 3 — Conflicting authority between APPLY and README [MEDIUM CONFIDENCE]

**Confidence: ~55%**

After the APPLY directive was added, agents see two competing sources of truth:
- README.md: "path: `/health`"
- APPLY directive: "Copy … **exactly** from the content above [the skill]"

The "do not substitute approximations" wording implies that using the README values
*instead of the skill values* would be an approximation. This reverses the intended
priority order.

### Hypothesis 4 — AGENTS.md workflow step 3 ambiguity [LOWER CONFIDENCE]

**Confidence: ~35%**

AGENTS.md step 3 says: "Apply ONLY the field names and value formats shown". The phrase
"value formats" is intended to mean "integer vs string", but agents may interpret it as
"apply the example values (formats) you see in the skill content". This compounds the APPLY
directive confusion.

---

## Why add-healthcheck is affected more severely than other tasks

add-healthcheck was at 100% in the baseline — it was already a "solved" task because:
1. The healthcheck field names (`path`, `interval`, `threshold`) are not tricky
2. The type constraints (integer interval, no "s" suffix) were already clear in the README
3. The README spelled out exact required values

The regression is so deep (-80%) because the task now has a near-deterministic failure path:
agents that follow APPLY + AGENTS.md step 4 will copy the full example's `/healthz` / `15` / `2`
instead of the README's required `/health` / `10` / `3`. All three assertions in the verifier
fail simultaneously, leaving no partial credit.

---

## What did NOT cause the regression

- **Frontmatter expansion (735fe81)**: SKILL.md body content was not changed; this only improved
  FTS5 search signal. The baseline (100%) was recorded at this commit.
- **Embedding model change**: Affects semantic search, not text rendering or agent behavior.
- **`run-failing-tasks` extraction bug (1776785)**: Fixed a reporting bug, did not change bench logic.
- **SKILL.md healthcheck section content**: The `## healthcheck` section still correctly shows
  `/health`, `10`, `3`. The issue is the FULL EXAMPLE, not the dedicated section.

---

## Recommended fix

**Do NOT implement — diagnosis only.**

Three paths to resolution (non-exhaustive):

**Option A (Preferred) — Fix the SKILL.md full example to use task-neutral placeholder values**

Replace concrete values in the `## Full example` section with clearly different placeholder
values that cannot be mistaken for task requirements, OR use values that differ visibly from
any task's requirements:

```yaml
healthcheck:
  path: /healthz          # example path — use your task's required path
  interval: 30            # example interval — use your task's required value
  threshold: 5            # example threshold — use your task's required value
```

This prevents agents from accidentally copying the full example values.

**Option B — Weaken the APPLY directive's "exactly" language**

Change:
```
APPLY: Copy field names, value types, and formats exactly from the content above.
Do not substitute approximations.
```
To:
```
APPLY: Use the field names and value types shown above — copy structure, not example values.
Apply the values required by your task (from README.md), not the example values shown above.
```

**Option C — Add explicit README-over-skill priority to AGENTS.md**

Add to AGENTS.md critical constraints:
```
- The SKILL.md examples show field NAMES and FORMAT TYPES — use them for structure only
- The actual values (path, interval, threshold, etc.) come from README.md, not the skill
- Do not copy example values from the skill; use the values specified in this README
```

**Option A + C together** is the most robust fix: it eliminates the root source of
confusing signal (inconsistent full example) while also explicitly setting priority rules
in the agent's local context.

---

## Files relevant to this analysis

- `tests/fixtures/stashes/inkwell/skills/inkwell/SKILL.md` — skill content with conflicting examples
- `tests/fixtures/bench/tasks/inkwell/add-healthcheck/workspace/AGENTS.md` — added in 760bf73
- `tests/fixtures/bench/tasks/inkwell/add-healthcheck/workspace/README.md` — task specification
- `tests/fixtures/bench/tasks/inkwell/add-healthcheck/tests/test_healthcheck.py` — verifier
- `src/output/text.ts` lines 683-703 — `formatShowPlain` APPLY directive (REC-01/09)
- `tests/bench/driver.ts` lines 388-431 — default akm-arm prompt (still references README)
- `tests/bench/baseline-qwen9b-2026-05-03.json` — pre-regression baseline (add-healthcheck: 100%)
- `~/.cache/akm/bench/bench-partial-2026-05-03T16-19-37-408Z.json` — post-regression run (add-healthcheck: 20%)
