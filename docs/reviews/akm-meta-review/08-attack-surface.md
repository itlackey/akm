# 08 — Attack surface inventory: everything akm installs, stores, and exposes

> Adapts **"Deployed infrastructure audit"** from `wiki:articles/raw/blog-prompts-to-run-when-fable-comes-back`.
> The blog builds a running `attacksurface.md` for deployed infra. akm's version: everything the tool installs on a host, every store it owns, every secret it holds, and every integration point it opens — maintained as a living document.

## Prompt

```text
Build akm's attack-surface inventory as a living document
(findings/08-attack-surface.md, structured so it can be re-run and diffed).

1. Enumerate everything akm places on a host and everything it exposes:
   - Data stores: index.db, state.db, wikis/, stash dirs — paths, sizes, what's in
     them, on-disk protections, whether any is gitignored user data.
   - Secrets & env assets: how env/secret assets are stored, encrypted-at-rest or
     not, how they're injected, and whether values can leak via logs, stats output,
     error messages, or the SessionStart payload.
   - Install/integration surface: the CLI, the Claude Code plugin, the opencode
     plugin, cron jobs, SessionStart/other hooks, and any network egress (registry
     fetches, LLM API calls, web fetches for wiki stash).
   - Multi-install / shared-config surface: multiple akm versions sharing one
     config.json (a real prior incident), dev vs. prod data isolation, and the
     stashDir-repoint hazard.

2. For each surface, capture: what tech/dependency it rests on, self-hosted vs.
   third-party, how it authenticates (LLM API keys, registry auth), the common
   misconfigurations for that surface, and its exposure audience (local-only,
   whoever can read the home dir, whoever can PR a registry kit, the LLM provider).

3. Rank by criticality × exposure and recommend a continuous-assessment cadence per
   surface (which to check every release, which quarterly).

4. Deliverable structure: propose an "AttackSurface" skill that maintains this
   inventory doc and an "AssessAttackSurface" review flow that can re-audit any one
   surface. Only propose them — do not scaffold new code this pass. Prefer folding
   the assessment into the existing health command over new machinery if it fits.

5. Output: findings/08-attack-surface.md — the inventory table, the criticality
   ranking, the cadence, and the skill/flow proposal (design only).

Guardrails: NEVER print secret values — reference secret assets by name/path only
(use the akm-secret / akm-env read-safe patterns). Read-only on live data. Do not
repoint stashDir or run init against a live config; sandbox HOME/XDG if you must
exercise anything.

ultracode
```

## Refs

Stash:

- `command:skills/coding/application-security-review/commands/security-code-review-pass` — reusable structured audit pass.
- `memory:vault-security-surface-isolated.derived` — prior finding on the secret/vault surface boundary.
- `knowledge:skills/gha-security-review/references/permissions-and-secrets` (from `github:getsentry/skills`) — secrets-handling reference patterns.
- `memory:isolate-config-in-init-repros` and `memory:akm-dev-prod-isolation-already-solved` (see MEMORY.md) — the shared-config / dev-prod-isolation hazards to include as surfaces.

Repo:

- `docs/technical/storage-locations.md` and `docs/technical/filesystem.md` — where everything lives on disk.
- `docs/data-and-telemetry.md` — what's stored and what leaves the machine.
- `docs/technical/logs-audit.md` — prior audit of what logs contain (leak candidates).
- `docs/technical/akm-production-readiness-findings.md` — production-hardening findings, incl. storage integrity.
- Env/secret asset handling code (grep for the env/secret read paths) and the plugin/hook install code.

Live (read-only, values-redacted): `akm health`, `akm env list` / `akm secret list` (names only), `~/.config/akm/config.json`, `crontab -l`.
