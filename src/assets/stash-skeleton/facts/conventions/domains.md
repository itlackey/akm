---
category: convention
description: The closed vocabulary of domain prefixes for reuse-born assets (knowledge/skill/wiki/fact), plus canonical entity spellings. Edit this to match your stash.
when_to_use: Surfaced to authoring agents when they must pick a domain prefix for a knowledge, skill, wiki, or fact asset.
---

<!--
  SOFT guidance only. This is the domain vocabulary that `organization.md` refers
  to. It is intentionally SHORT and STARTER — replace these with the domains your
  stash actually accumulates. A closed list keeps agents from coining a new
  folder per session (which fragments prefix search); the flat type-root fallback
  in organization.md handles anything that doesn't fit yet.
-->

# Domain vocabulary

Reuse-born assets (`knowledge`, `skill`, `wiki`, `fact`) take a **domain prefix**
from this list, e.g. `knowledge:auth/oauth-refresh-races`,
`skill:testing/flaky-test-triage`. Pick the closest match. If nothing fits, write
the asset at the type root and propose an addition here — do **not** invent a
one-off domain mid-task.

## Starter domains

Add, remove, and rename to fit your stash. Keep the list short (roughly a dozen);
add a subdomain only where volume justifies it.

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
- `policies` — durable house rules and standards (`fact:policies/…`)

## Canonical entity spellings

Spell these consistently in asset **bodies** so the entity/relation graph boost
does not fragment. Extend as your stash grows.

- Postgres (not postgresql / pg)
- OAuth (not oauth / Oauth)
- TLS (not tls / ssl when you mean TLS)
- Kubernetes (not k8s in prose titles)

Project and client slugs are **not** listed here — those are scope slugs for
scope-born types (`memory`, `lesson`, `task`, `env`, `secret`). Keep their
canonical spellings wherever your stash tracks active projects (e.g. a
`fact:canonical-names` or your `.meta/` orientation doc) and `akm search` for an
existing spelling before minting a new one.
