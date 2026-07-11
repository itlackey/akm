---
category: convention
description: The closed vocabulary of domain prefixes for reuse-born assets (knowledge/skill/wiki/fact/script), plus canonical entity spellings. Edit this to match your stash.
when_to_use: Surfaced to authoring agents alongside the other convention facts; consult it when picking a domain prefix for a knowledge, skill, fact, or script asset (for wikis, the domain names the wiki).
---

<!--
  SOFT guidance only. This is the domain vocabulary that `organization.md` refers
  to. It is intentionally SHORT and STARTER — replace these with the domains your
  stash actually accumulates. A closed list keeps agents from coining a new
  folder per session (which fragments the tree and splits slug search); the flat
  type-root fallback in organization.md handles anything that doesn't fit yet.
-->

# Domain vocabulary

Reuse-born assets (`knowledge`, `skill`, `wiki`, `fact`, `script`) take a
**domain prefix** from this list, e.g. `knowledge:auth/oauth-refresh-races`,
`skill:testing/flaky-test-triage` (for a wiki, the domain names the wiki:
`wikis/auth/`). Pick the closest match. If two fit, take the one naming the
SUBJECT of the doc (what it teaches, not where it was met) and put the other in
tags; if still tied, the earlier entry in this list wins. If nothing fits, write
the asset at the type root and propose an addition here — do **not** invent a
one-off domain mid-task.

## Starter domains

Add, remove, and rename to fit your stash. Keep the list short (roughly a dozen)
— the whole list rides along in every authoring prompt, and a short closed list
is what keeps two agents picking the same slug. Add a subdomain only where
volume justifies it.

- `auth` — authentication, authorization, tokens, sessions
- `networking` — protocols, TLS, DNS, proxies, connectivity
- `databases` — storage engines, queries, migrations (subdomain e.g. `databases/postgres`)
- `testing` — test strategy, fixtures, flaky-test triage, coverage
- `build` — build systems, packaging, CI pipelines
- `cloud` — infra, deploy targets, IaC (subdomain e.g. `cloud/aws`)
- `observability` — logging, metrics, tracing, alerting
- `security` — threat modeling, secrets handling, hardening
- `frontend` — UI, rendering, client state
- `data-pipelines` — ETL, streaming, batch processing
- `tooling` — dev tooling, editor/agent integration, scripts
- `policies` — organizational/business rules the work must obey (PII handling, licensing) (`fact:policies/…`)
- `conventions` — stash authoring house-rules (`fact:conventions/…`; auto-surfaced to authoring agents — keep them in this directory)

## Canonical entity spellings

Pick ONE name per entity and use it everywhere in asset **bodies** — retrieval
is case-insensitive but treats aliases as different entities, so alias variants
fragment the entity graph. Extend as your stash grows.

- Postgres (not postgresql / pg)
- Kubernetes (not k8s)
- TLS (not ssl when you mean TLS)
- OAuth

Project and client slugs are **not** listed here — those are scope slugs for
scope-born types (`memory`, `lesson`, `task`, `env`, `secret`). Keep their
canonical spellings in a `category: meta` fact (e.g. `fact:active-projects`) so
they auto-inject at authoring time — not in `.meta/`, which is unindexed and
invisible mid-task — and `akm search` for an existing spelling before minting a
new one.
