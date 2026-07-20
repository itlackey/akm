---
category: convention
description: Where to place an asset in the stash — the one path partition axis, chosen by asset type, so refs stay stable and slug search (akm search "<slug>" --type <type>) co-locates related assets.
when_to_use: Surfaced to authoring agents when they create or move any non-wiki asset and must decide its subdirectory/name.
---

<!--
  SOFT guidance only — advice, not a contract. Nothing here is enforced by the
  proposal gate. It steers WHERE assets go so that path-derived refs stay stable
  and scoped search (`akm search "<slug>" --type <type>`) keeps working. Tune
  the axis choices and the domain vocabulary to match how your stash is queried.
-->

# Stash organization conventions

A file's path under its type directory **becomes part of its ref**
(`knowledge/auth/oauth-refresh-races.md` → `knowledge/auth/oauth-refresh-races`).
That ref is an address other assets cite, and its segments are search terms —
`akm search "projectA" --type memory` reconstructs a project's memories. The
path is therefore the one facet you **cannot express twice and cannot change
without breaking the ref** — so spend it deliberately, on exactly one axis.

Retrieval is search, not browse: no one walks these folders at query time. A
subdirectory buys you three things: its tokens are indexed as part of the
asset's **name** (the highest-weighted search field), they are auto-added to
`tags` (even when you set `tags` explicitly), and for scope-born types a slug
matching the current repo's name earns an automatic in-project ranking boost.
Every other facet belongs in frontmatter, where the index can actually read it.

## Choose the partition axis by asset TYPE, not per-asset judgment

Deciding "project or domain?" per asset is non-deterministic — two agents guess
differently and bake the wrong guess into an immutable ref. Decide by type:

- **Scope-born types → current project / client / team slug.**
  `memory`, `lesson`, `task`, `env`, `secret`. These are born bound to the work
  in front of you, so the working context *is* the answer — no judgment needed.
  When the scope is a single repo, use its repo/package name as the slug (as
  `git remote`/package.json spell it) — ranking auto-boosts assets whose name
  or tags match the current repo. Client/team slugs get no such boost; just
  reuse the existing spelling.
  - `memories/projectA/auth-token-refresh`
  - `lessons/clientX/migration-rollback-gotcha`
  - `secrets/clientX/api-key`
- **Reuse-born types → stable domain from a short vocabulary.**
  `knowledge`, `skill`, `wiki`, `fact`, `script`. These are meant to be reused
  across projects, so co-locate them by subject — any project retrieves them
  with `akm search "<domain>" --type <type>`. For a wiki the domain names the
  wiki itself (`wikis/auth/`); inside it, its `schema.md` and wiki lint govern
  layout, not these rules.
  - `knowledge/auth/oauth-refresh-races`
  - `skills/testing/flaky-test-triage`
  - `facts/policies/pii-handling`
- **Global-by-nature types → type root or a tool slug.**
  `command`, `agent`, `workflow`, and stash-wide `env`. Scoping these to a
  project rarely improves precision and only adds rename risk. `env` defaults
  to the project/client slug; only an env consumed by every project sits at
  the type root — if any single project would break when it changes, it is
  scope-born.

**Why reuse types don't take the project axis:** project relevance is already
recovered at query time — AKM blends a per-project usage signal into ranking
(scoped utility, keyed off the current repo, not the asset's path). Free the
scarce path segment for the domain — the *only* handle that co-locates
cross-project reuse.

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
  asset, write it at the type root (`knowledge/http-retry-basics`) rather than
  coining a one-off domain. An unneeded folder is pure rename liability; propose
  a vocabulary addition instead of fragmenting the tree.
- **Reuse an existing slug before minting a new one.** Before coining a new
  project/client/domain slug, `akm search` for the existing spelling
  (`acme` vs `acme-corp`) so the prefix does not fragment. Keep the domain
  vocabulary in `facts/conventions/domains`.
- **Off-axis facets go in `tags:`, not a bare field.** The indexed FTS fields are
  name, description, tags, hints, and content (headings only — body prose is
  not indexed by default; the opt-in `index.indexBodyOpening` flag adds just
  the first body paragraph, at the lowest weight) — there is **no `project`
  field**, so `project: projectA` in
  frontmatter is invisible to search. Put the off-axis facet in `tags` instead
  (a project-scoped memory adds `tags: [auth]`; a domain-scoped asset genuinely
  tied to a project adds `tags: [projectA]` sparingly).
- **Directory tokens join `tags` on their own.** The scope/domain segments of
  the path are always auto-added to `tags` — even when you set `tags`
  explicitly — so there is no need to restate them; the tag-match ranking
  boost fires for the scope token either way. Filename tokens are auto-added
  only when `tags` is empty.

## Renames and evolution

- **A ref is chosen once. Default to not renaming.** A manual rename dangles
  inbound xrefs silently at write time — nothing catches the breakage until
  the next `akm lint` run flags the dead frontmatter refs (`missing-ref`) —
  while the dead ref string keeps scoring in FTS, and a manually renamed file
  is a new index entry, so the asset's accumulated usage-ranking history
  resets.
- If a rename is truly unavoidable, prefer `akm mv <ref> <new-name>`
  (Experimental): it moves the file, rewrites inbound references across the
  writable stash in the same pass, and keeps the asset's usage-ranking
  history. Citing files in read-only sources are reported for manual
  follow-up. On an older CLI without `akm mv`, treat the rename as an
  xref-fixing operation: grep the stash for the old ref string and fix every
  inbound reference in the same pass.
- When a project-scoped note turns out to be domain-general, **append, don't
  promote**: write a new `knowledge:<domain>/…` asset that xrefs the originating
  memory. Never rename the memory up a rung — that breaks its ref. The atomic
  note still serves factoid recall; the new synthesis serves reuse; the xref
  bridges them.

## Real isolation is a separate stash, not a folder

A path prefix is a ranking scope, not a security boundary. When you need enforced
isolation (client confidentiality, secret-leak containment), mount a **separate
stash** and let source resolution keep it apart — don't rely on a subdirectory.
