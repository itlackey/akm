# Ref Format

A `ref` is the identifier that `akm search` returns for items and `akm show`
consumes.

Agents should not parse refs or construct them by hand. The intended flow is:

```text
search -> pick a hit -> pass its ref to show
```

> **Status.** This document is normative for 0.9.0 and is the target the
> implementation is being brought to. Sections marked **[0.9.0 change]**
> describe decisions taken during the 0.9.0 surface review that the code does
> not yet fully implement.

## Item Refs

Item refs use this wire format:

```text
[bundle//]conceptId[#fragment]
```

| Part | Required | Description |
| --- | --- | --- |
| `bundle` | no | Workspace bundle slug (e.g. `personal`, `team-catalog`) that owns the item. Separated from the rest of the ref by `//`. When omitted, the ref resolves against the containing bundle (content-internal refs) or, for CLI/API input, against `defaultBundle` and then the remaining bundles in installation-priority order. |
| `conceptId` | yes | Adapter-defined path within the bundle, `/`-separated and canonicalized by that adapter. Examples: `knowledge/http-caching`, `skills/code-review`, `scripts/db/migrate/run.sh`, `tables/customers`. |
| `fragment` | no | Selector for a part of the item. For markdown-document items the core interprets it as a **section selector**; for every other item kind it is an adapter-owned selector, opaque to the core. See [Fragments](#fragments). |

`type` is **no longer part of a ref**. Identity is a path, not a `type:name`
pair, and a conceptId is an **opaque path** — akm does not parse meaning out of
its segments. `skills/deploy` and `workflows/deploy` are distinct concepts that
never collide because their paths differ, not because their first segment is a
recognized word.

An item's `type` is an **attribute of the resolved item**, supplied by the
selected adapter, never a predicate parsed out of the ref string. The `okf`
adapter reads it from OKF frontmatter; the `akm` adapter derives it from its
native matcher and placement rules. This is why a ref into any bundle —
`okfbundle//tables/customers`, `wiki//pages/attention` — is just as addressable
as `personal//memories/vpn-note`. See
[`okf-support.md`](./okf-support.md).

Refs are parsed by `parseBundleRef` in `src/core/asset/asset-ref.ts`. The
grammar is:

```text
ref        := [ bundle "//" ] concept-id [ "#" fragment ]
bundle     := any run of non-space chars excluding : . # /
concept-id := adapter-canonical path within the bundle, / -separated, NFC, case-sensitive
fragment   := section slug (markdown-document items) | adapter-owned selector
```

The bundle slug excludes `:`, `.`, `#`, `/`, and whitespace so a `bundle//conceptId`
token is lexically distinct from a URL (whose scheme carries a `:` before `//`) and
so the first `//` unambiguously bounds the bundle.

### AKM concept ids and adapter layouts

The subdirectory prefix is the item's placement directory:

| Subdir | Holds | Example conceptId |
| --- | --- | --- |
| `scripts/` | Executable scripts | `scripts/deploy.sh` |
| `skills/` | Skill directories (`SKILL.md`) | `skills/code-review` |
| `commands/` | Slash-command templates | `commands/release` |
| `agents/` | Agent definitions | `agents/reviewer` |
| `knowledge/` | Reference documents | `knowledge/api-guide` |
| `workflows/` | Workflow documents / programs | `workflows/ship-release` |
| `memories/` | Recalled context fragments | `memories/deployment-notes` |
| `lessons/` | Distilled feedback lessons | `lessons/retry-backoff` |
| `facts/` | Durable bundle-level facts | `facts/team/tool-stack` |
| `sessions/` | Indexed agent sessions | `sessions/claude/2026-07-24-abc` |
| `env/` | `.env` configuration groups | `env/prod` |
| `secrets/` | Single sensitive values | `secrets/deploy-token` |
| `tasks/` | Scheduled / on-demand tasks | `tasks/nightly-sync` |

These are the subdirs the **`akm` adapter** places into and interprets according
to its own matcher rules. Other bundles use whatever paths their adapters
declare — an OKF bundle emits `tables/customers`, an LLM wiki emits
`pages/attention`, and a website snapshot emits its crawled path. Every one of
those is an equally valid conceptId; the core does not require the leading
segment to be an AKM placement directory.

### Examples

- `scripts/deploy.sh`
- `skills/code-review`
- `knowledge/api-guide`
- `commands/release`
- `agents/reviewer`
- `memories/deployment-notes`
- `env/prod`
- `personal//knowledge/http-caching`
- `team-catalog//workflows/release`
- `knowledge/api-guide#authentication` (section selector)

### Rejected

- `viking://skills/deploy` (URI scheme — a `:` before `//` is not a bundle slug)
- `skills/../../../etc/passwd` (path traversal)
- `github:owner/repo` (this is an install ref, parsed elsewhere)
- the pre-0.9.0 `<type>:<name>` grammar (e.g. the old colon-typed spelling) — dead;
  parsed only by the frozen migrator

## Fragments

**Scope: `show` only in 0.9.0 (ruled 2026-07-26, Q-06).** `parseRefInput`
still rejects any `#fragment` outright; `show` is the only command that
accepts one, by bypassing that shared parser. Every other ref-consuming
command (graph, tasks, improve, proposals, the utility repo, the indexer
walk) routes through `parseRefInput` and does not accept fragments yet.
Wider rollout is post-0.9.0.

**[0.9.0 change]** Before 0.9.0 the fragment production existed in the grammar
and in this document, but every input boundary rejected it
(`parseRefInput` threw `INVALID_FLAG_VALUE` for any `#fragment`) and nothing
consumed it. It was stable on paper and unusable in practice. 0.9.0 resolves
that by giving it one concrete meaning the core implements, and keeping the
adapter-owned meaning for everything else.

**Markdown-document items — section selector (core-implemented).** For an item
whose adapter presents it as a markdown document, the fragment names a section:

```text
akm show knowledge/api-guide#authentication
```

Resolution is: slugify each heading in the document (lowercase, non-alphanumeric
runs collapsed to `-`, trimmed) and match the fragment against those slugs;
fall back to a case-insensitive match against raw heading text. The selected
region runs from that heading to the next heading of the same or higher level.
A fragment that matches no heading is an error that **lists the available
fragment slugs** — that error is the discovery mechanism, replacing the removed
`toc` view mode.

**Every other item kind — adapter-owned selector.** When one item exposes
multiple exports the adapter MAY append a stable fragment
(`team//tools/toolbox#deploy`). The fragment is adapter-owned and opaque to
the core. The two meanings coexist because the core only interprets
fragments for items whose adapter declares them markdown documents; for
everything else it passes the fragment through untouched.

**Fragments are input-only.** Durable state — index rows, state keys, proposal
targets, bindings — never stores a fragment. A stored ref carrying one is
invalid.

### Superseded: the `akm show` view-mode grammar

**[0.9.0 change]** `akm show <ref> toc|section "H"|lines A B|frontmatter|full`
is removed. It was a second argv parser (`normalizeShowArgv` rewrote
`process.argv` and injected hidden `--akmView` / `--akmHeading` / `--akmStart` /
`--akmEnd` flags), and its view keywords were reserved words in ref position.

| Old | New |
| --- | --- |
| `akm show X section "Auth"` | `akm show X#auth` |
| `akm show X full` | `akm show X` (no fragment = whole item) |
| `akm show X toc` | `akm show X#<unmatched>` lists available fragment slugs |
| `akm show X lines 10 30` | removed — every response carries `path`; slice the file |
| `akm show X frontmatter` | removed — if a raw-YAML projection proves necessary it returns as a `--shape` value, the designated projection axis |

## Ref-prefix enumeration (browse)

**[0.9.0 change]** Browsing a subtree uses a **conceptId prefix**, matching the
grammar refs are actually emitted in:

```text
akm search "memories/"                 # every memory in scope
akm search "memories/projecta/"        # one subtree
akm search "team-catalog//"            # every item in one bundle
akm search "team-catalog//skills/"     # one subtree of one bundle
```

A trailing `/` is required for a non-empty prefix, giving exact `/`-boundary
subtree semantics (`projecta/` cannot match a sibling `projectalpha/`). A query
with interior whitespace is prose, not a prefix — it stays an ordinary keyword
search.

This replaces the pre-0.9.0 `akm search "<type>:"` / `"<type>:<prefix>/"`
grammar, which had three defects: it resurrected the singular `type:` spelling
the release removed; it validated against the `akm` adapter's placement types,
so items from every other adapter could not be enumerated at all; and it
matched against item *names* while every displayed ref is a conceptId — so
copying a ref prefix out of search output and pasting it back in silently
degraded to a keyword search.

Because enumeration is now prefix-matching over conceptIds, it covers every
adapter's items uniformly, and `bundle//` enumeration replaces the removed
`akm bundle items` command.

## Asset types are free-form

`type` is adapter-supplied metadata that presents, ranks, and filters — it
never executes and never identifies. The OKF adapter reads the open OKF `type`
field and defaults it according to OKF adapter rules; other adapters derive a
type from their native formats. `IndexDocument.type` is an open string by
contract, and adapters emit types outside the `akm` adapter's placement set
(`website`, `wiki-source`, an LLM-wiki page's `pageKind`, `instruction`, and
anything an OKF bundle author writes).

Consequently `akm search --type <t>` is an **exact string match against an open
set, deliberately unvalidated**: an unrecognized type returns zero hits rather
than an error, because "unrecognized" is not a decidable property. Callers that
want a closed set should filter on conceptId prefix instead (see above).

The closed set still applies where a type must select a *write placement* —
`akm proposal new <type> <name>`, `placeNew` — because those need a directory to write to.

## Reserved structural files

For the OKF adapter, `index.md` (directory listing / progressive disclosure)
and `log.md` (update history) are reserved structural files at every level and
are never concepts. The `akm` and `llm-wiki` adapters independently reserve
the same names as part of their own format contracts. Other adapters own their
reserved-name rules; the cross-format ref grammar does not impose OKF
structure on them. Item writes must follow the selected adapter's rules.

## Install Refs (distinct grammar)

`akm add` and one-shot `akm clone` accept a different ref grammar. Install
refs locate an upstream kit to fetch; they are **not** item refs and are
parsed by `parseRegistryRef` in `src/registry/resolve.ts`.

```text
install-ref := github-ref | git-url | npm-pkg | https-url | skills-sh-slug | local-path
```

Examples: `github:owner/repo#v1.2.3`, `git+https://gitlab.com/org/kit`,
`@scope/kit`, `https://docs.example.com`, `skills.sh:code-review`,
`./path/to/kit`.

The two parsers are intentionally distinct — each rejects the other's inputs.
Item refs never carry URI schemes; install refs are not addressable through
`akm show`.

## Bundle prefix

When a ref includes a bundle prefix, `akm show` narrows lookup to that bundle:

```text
team-catalog//scripts/deploy.sh
personal//knowledge/my-notes
```

When absent, a short ref from CLI/API input resolves to `defaultBundle` if the
conceptId exists there, otherwise to the first bundle containing it in installation
priority order (first match wins, deterministically). A short ref inside bundle
content resolves against its **containing** bundle. To pin lookup to a single
bundle programmatically, use `resolveRef(input, { only: bundleId })` — there is no
ref spelling for "primary only".

## Refs in prose

Refs embedded in prose MUST use the fully-qualified `bundle//conceptId` form —
the bundle-slug charset makes such a token lexically anchored — or a native
link form owned by the adapter (OKF links, wiki links). **Bare short refs in
prose are not refs**: `memories/foo` in a sentence is ordinary text, and no
tool may rewrite it.

Only lint's missing-ref scan honours this rule today. The other consumer,
`akm mv`'s inbound-ref rewriting, was defective: it implemented the rule
exactly inverted (it rewrote bare conceptIds and matched no `bundle//` pattern
at all), so it rewrote prose that is not a ref while leaving real anchored
refs dangling. That defect is why `akm mv` shipped **Experimental** earlier in
the 0.9.0 cycle and was never covered by the stability contract.

**Amended 2026-07-30.** `akm mv` was removed outright before the 0.9.0
release (no alias, no stub).
There is no tool today that rewrites inbound refs on rename; see "Renames and
moves" below for the current procedure.

## Renames and moves

**[0.9.0 change]** A rename or move is **delete plus create**. The destination
is a new identity: it gets a fresh index row, and learned state (utility,
salience, outcomes, usage history) does not follow it.

```sh
mv ~/akm/memories/old-note.md ~/akm/memories/new-note.md
# update any intentional refs to it
akm index
akm lint          # confirms nothing dangles
```

Moving an item **between bundles** is copy/import followed by deletion from the
source. Both the bundle and the concept identity change; there is no
identity-preserving cross-bundle move.

This supersedes the pre-0.9.0 rule that a rename "MUST use an explicit
state-rekey transaction". That rule was a product choice made during the bundle
refactor, not a constraint the architecture imposes. `akm mv`, which implemented
the superseded rule, shipped briefly as an **Experimental** surface outside
the stability contract, because its inbound-ref rewriting was inverted (above),
then was removed outright before the 0.9.0 release. The procedure above —
plain filesystem move, then `akm index`, then `akm lint` — is the only
supported path today. If preserving learned state through renames later proves
materially valuable, a narrow same-bundle `akm rename` can return — resolving
through the index, using adapter-owned placement, accepting qualified refs,
rewriting only anchored prose refs, applying one qualified old→new state
mapping, and rebuilding derived index data rather than preserving row IDs.

**Amended 2026-07-30.** Carrying learned state (utility, salience, usage
history) across a rename is opt-in and out-of-band: run
`bun scripts/rekey-asset-ref.ts <old-ref> <new-ref>` from a source checkout
**before** `akm index`, and it re-keys the `entries` row plus
`asset_salience`/`asset_outcome`/`usage_events` in place rather than letting
`akm index` mint a fresh row. Automated garbage collection of orphaned rows
left by renames that skip this script is tracked as issue #733; until it
lands, the script is the only path. See
[`v0.9.0-troubleshooting.md`](../../migration/v0.9.0-troubleshooting.md) for
the full walkthrough.

## Usage Notes

Consumers should use structured fields like `conceptId` and `bundle` for display,
and pass the full `ref` string back to `show` as the lookup token.

## Canonical Form

Refs are emitted in canonical form: the bundle slug (when qualified), the
adapter-canonical conceptId, and an optional `#fragment`. The adapter decides
whether an on-disk extension is stripped: OKF and AKM Markdown items strip
`.md`, scripts retain executable extensions, and directory-items such as
skills resolve on the directory path (`skills/<dir>`, not
`skills/<dir>/SKILL`).
