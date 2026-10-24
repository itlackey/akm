# Refs

Reference for the ref grammar `akm search` emits and `akm show` consumes,
rename semantics, and namespacing conventions.

## Contract

A **ref** is a compact handle identifying one capability. Agents should
treat refs as opaque tokens — get them from search or curate, pass them to
show. The structured `conceptId` and `bundle` fields in search results
provide the same information in parseable form; never parse a ref string by
hand.

## Grammar

```text
[bundle//]conceptId[#fragment]
```

| Part | Required | Description |
| --- | --- | --- |
| `bundle` | no | Narrows lookup to one installed bundle, separated from the rest of the ref by `//`. Omit it and the ref resolves against the workspace `defaultBundle`, then the remaining bundles in installation-priority order. |
| `conceptId` | yes | Subdir-qualified within its bundle: the placement subdirectory followed by the item's canonical name (extension stripped for markdown-like types; scripts and secrets keep their natural filename). `type` is not part of a ref — the subdirectory carries that signal. |
| `fragment` | no | A selector for part of the item. Input-only — never stored. |

Examples: `scripts/deploy.sh`, `agents/reviewer`, `knowledge/api-guide`,
`workflows/ship-release`, `team-catalog//scripts/deploy.sh`,
`personal//knowledge/guide`, `knowledge/api-guide#authentication`.

Source locators like `github:owner/repo` and `npm:@scope/pkg` are **install
refs**, a distinct grammar accepted only by `akm bundle add` and `akm
clone`. They are not asset refs and are never addressable through `akm
show`.

This reference page is deliberately non-normative prose over the same
grammar; [`docs/architecture/specs/ref.md`](https://github.com/itlackey/akm/blob/main/docs/architecture/specs/ref.md)
is the normative spec, including the `parseBundleRef` grammar, fragment
resolution rules, and reserved-name handling.

## Namespacing

AKM supports **physical-subdirectory namespacing** — no extra flags
required. Drop assets under nested directories beneath the type folder and
the path becomes part of the ref's name:

```text
memories/projectA/auth-tip.md    →  memories/projectA/auth-tip
memories/teamA/clientX/notes.md  →  memories/teamA/clientX/notes
skills/projectB/lint-fix.md      →  skills/projectB/lint-fix
knowledge/clientX/api-guide.md   →  knowledge/clientX/api-guide
```

This works for **any** asset type. The subpath segments become part of the
conceptId, so `akm search "projectA" --type memory` narrows results to that
subtree, and `akm show memories/projectA/auth-tip` resolves the full ref.

There is also a **ref-prefix query syntax** — a query that is a conceptId
prefix ending in `/` enumerates that subtree instead of keyword-matching:

```sh
akm search "memories/"                  # every memory
akm search "memories/projectA/"         # exactly that subtree
akm search "team-catalog//"             # every item in one bundle
akm search "team-catalog//skills/"      # one subtree of one bundle
```

Enumeration is `/`-boundary exact — a sibling `projectAlpha/` scope does not
leak — and hits are a deterministic listing with the fixed browse score `1`,
not a relevance ranking. Because it matches conceptIds, it works for items
from every adapter, and you can copy a ref prefix straight out of search
output and paste it back as a query. A complete ref
(`memories/projectA/auth-tip`, no trailing `/`) stays an ordinary keyword
search — resolving a single ref is `akm show`'s job.

**Recommendation:** use physical subdirectories now to organize multi-project
or multi-team bundles. They sort cleanly on disk and require no
configuration.

**Which subdirectory?** Choose the partition axis by asset **type**:
scope-born types (`memory`, `lesson`, `task`, `env`, `secret`) take the
current **project/client** slug; reuse-born types (`knowledge`, `skill`,
`fact`, `script`) take a stable **domain**; global types (`command`, `agent`,
`workflow`) stay at the type root or a tool slug. The full rules — depth
limits, no-volatile-facets, off-axis facets as tags, and how to cross-link
for retrieval — ship as the `facts/conventions/organization`,
`facts/conventions/backlinks`, and `facts/conventions/domains` convention
facts in the bundle skeleton, and are surfaced to agents automatically at
authoring time.

## Renames and moves

**Treat a ref as permanent.** A rename is **delete plus create**: the new
path is a new identity, so the destination starts with fresh learned state
(utility, salience, usage history) and any inbound refs to the old path
dangle. When you must rename:

```sh
mv ~/akm/memories/old-note.md ~/akm/memories/new-note.md
# update any intentional refs (they are fully qualified: bundle//memories/old-note)
akm index
akm lint          # confirms nothing dangles
```

Moving an item between bundles is copy/import followed by deletion from the
source — both the bundle and the concept identity change. `akm mv`, which
promised identity-preserving renames, was removed in 0.9.0: its inbound-ref
rewriting targeted bare conceptIds rather than the anchored
`bundle//conceptId` prose form, so it could rewrite non-refs while leaving
real refs dangling. The procedure above is the only supported path today.

To carry an asset's earned signal (feedback, usage, salience/outcome
history) across a rename, the maintainer script `scripts/rekey-asset-ref.ts`
re-keys those rows onto the new ref before `akm index` runs; it is Internal
tooling, not a supported command surface.

## Refs in prose

Refs embedded in prose must use the fully-qualified `bundle//conceptId` form
— the bundle-slug charset makes such a token lexically anchored — or a
native link form owned by the adapter (OKF links, wiki links). A bare
conceptId in prose is ordinary text, not a ref, and no akm tool rewrites it.

## Stability

Per `STABILITY.md`, this is **Stable** surface: the
`[bundle//]conceptId[#fragment]` grammar (durable state always stores the
fully-qualified `bundle//conceptId`; the short form is accepted input only),
conceptId-prefix enumeration, and the rename-is-delete-plus-create procedure
are all named explicitly in the Stable tier, and the ref grammar is called
out as frozen at 1.0 alongside the supported source model, search behavior,
and write-target rules. See `STABILITY.md` for the full command- and
surface-level tier index.

## See also

- [Concepts](../guides/concepts.md) — where refs fit in the retrieval loop
- [Asset Types](asset-types.md) — how a conceptId's subdirectory maps to an asset type
- [Memory](memory.md) — parent/derived-memory provenance backrefs
- [`docs/architecture/specs/ref.md`](https://github.com/itlackey/akm/blob/main/docs/architecture/specs/ref.md) — the normative ref grammar spec
