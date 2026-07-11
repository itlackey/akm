---
category: convention
description: Where to place an asset in the stash — the one path partition axis, chosen by asset type, so refs stay stable and prefix-scoped retrieval works.
when_to_use: Surfaced to authoring agents when they create or move any non-wiki asset and must decide its subdirectory/name.
---

<!--
  SOFT guidance only — advice, not a contract. Nothing here is enforced by the
  proposal gate. It steers WHERE assets go so that path-derived refs stay stable
  and `akm search "<type>:<prefix>/"` keeps working. Tune the axis choices and
  the domain vocabulary to match how your stash is actually queried.
-->

# Stash organization conventions

A file's path under its type directory **becomes part of its ref**
(`knowledge/auth/oauth-refresh-races.md` → `knowledge:auth/oauth-refresh-races`).
That ref is an address other assets cite and `akm search` filters by prefix. The
path is therefore the one facet you **cannot express twice and cannot change
without breaking the ref** — so spend it deliberately, on exactly one axis.

Retrieval is search, not browse: no one walks these folders at query time. A
subdirectory buys you only two things — a small indexing-confidence bump and a
ref-prefix filter (`akm search "memory:projectA/"`). Every other facet belongs
in frontmatter, where the index can actually read it.

## Choose the partition axis by asset TYPE, not per-asset judgment

Deciding "project or domain?" per asset is non-deterministic — two agents guess
differently and bake the wrong guess into an immutable ref. Decide by type:

- **Scope-born types → current project / client / team slug.**
  `memory`, `lesson`, `task`, `env`, `secret`. These are born bound to the work
  in front of you, so the working context *is* the answer — no judgment needed.
  - `memory:projectA/auth-token-refresh`
  - `lesson:clientX/migration-rollback-gotcha`
  - `secret:clientX/api-key`
- **Reuse-born types → stable domain from a short vocabulary.**
  `knowledge`, `skill`, `wiki`, `fact`. These are meant to be reused across
  projects, so co-locate them by subject and let any project prefix-search them.
  - `knowledge:auth/oauth-refresh-races`
  - `skill:testing/flaky-test-triage`
  - `fact:policies/pii-handling`
- **Global-by-nature types → type root or a tool slug.**
  `command`, `agent`, `workflow`, and stash-wide `env`. Scoping these to a
  project rarely improves precision and only adds rename risk.

**Why reuse types don't take the project axis:** project relevance is already
recovered at query time — AKM blends a per-project usage signal into ranking
(scoped utility, keyed independently of the path, so it is rename-proof).
Spending the scarce path segment on the project axis for a reusable asset is
therefore redundant; free it for the domain, which is the *only* handle that
co-locates cross-project reuse.

## Placement rules

- **One axis only.** Never encode two dimensions in the path
  (`client/project/subsystem`, or `domain+status`). Second dimensions go in tags.
- **Depth 1 by default, 2 max**, and only for strict stable containment
  (`knowledge/databases/postgres/…`, `secret/clientX/projectA/…`). Never a third
  semantic level — deeper axes go in frontmatter.
- **Segments are lowercase-hyphen semantic tokens** that read as query terms
  (`connection-pooling`, `tls-handshake-debugging`) — never opaque IDs, numbers,
  or Johnny.Decimal-style codes, which carry no search signal.
- **Never put a volatile facet in the path** — status, date, version, priority,
  author, `wip`/`done`. Each one changes and forces a ref-breaking rename. They
  belong in frontmatter tags.
- **Flat fallback beats an invented folder.** If no domain fits a reuse-type
  asset, write it at the type root (`knowledge:http-retry-basics`) rather than
  coining a one-off domain. An unneeded folder is pure rename liability; propose
  a vocabulary addition instead of fragmenting the tree.
- **Reuse an existing slug before minting a new one.** Before coining a new
  project/client/domain slug, `akm search` for the existing spelling
  (`acme` vs `acme-corp`) so the prefix does not fragment. Keep the domain
  vocabulary in `fact:conventions/domains`.
- **Off-axis facets go in `tags:`, not a bare field.** The indexed FTS fields are
  name, description, tags, hints, and content — there is **no `project` field**,
  so `project: projectA` in frontmatter is invisible to search. Put the off-axis
  facet in `tags` instead (a project-scoped memory adds `tags: [auth]`; a
  domain-scoped asset genuinely tied to a project adds `tags: [projectA]`
  sparingly).
- **Footgun:** path segments are auto-added to `tags` **only when `tags` is
  empty**. The moment you set `tags` explicitly you must also include the path
  scope/domain token, or you silently drop the auto-derived one.

## Renames and evolution

- **A ref is chosen once. Default to not renaming.** Non-wiki inbound xrefs have
  no broken-link lint, so a rename dangles them silently while the dead ref
  string keeps scoring in FTS.
- If a rename is truly unavoidable, treat it as an xref-fixing operation: grep
  the stash for the old ref string and fix every inbound reference in the same
  pass.
- When a project-scoped note turns out to be domain-general, **append, don't
  promote**: write a new `knowledge:<domain>/…` asset that xrefs the originating
  memory. Never rename the memory up a rung — that breaks its ref. The atomic
  note still serves factoid recall; the new synthesis serves reuse; the xref
  bridges them.

## Real isolation is a separate stash, not a folder

A path prefix is a ranking scope, not a security boundary. When you need enforced
isolation (client confidentiality, secret-leak containment), mount a **separate
stash** and let source resolution keep it apart — don't rely on a subdirectory.
