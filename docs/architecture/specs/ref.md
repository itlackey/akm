# Ref Format

A `ref` is the identifier that `akm search` returns for items and `akm show`
consumes.

Agents should not parse refs or construct them by hand. The intended flow is:

```text
search -> pick a hit -> pass its ref to show
```

This document is the normative ref grammar for 0.9.

## Item Refs

Item refs use this wire format:

```text
[bundle//]conceptId[#fragment]
```

| Part | Required | Description |
| --- | --- | --- |
| `bundle` | no | Workspace bundle slug (e.g. `personal`, `team-catalog`) that owns the item. Separated from the rest of the ref by `//`. When omitted, CLI input resolves against `defaultBundle` first and then the remaining bundles in installation-priority order. |
| `conceptId` | yes | Adapter-defined path within the bundle, `/`-separated and canonicalized by that adapter. Examples: `knowledge/http-caching`, `skills/code-review`, `scripts/db/migrate/run.sh`, `tables/customers`. |
| `fragment` | no | Selector for a part of the item. For markdown-document items the core interprets it as a **section selector**; for every other item kind it is an adapter-owned selector, opaque to the core. See [Fragments](#fragments). |

`type` is not part of a ref. Identity is a path, not a `type:name` pair, and a
conceptId is an **opaque path** — akm does not parse meaning out of its
segments. `skills/deploy` and `workflows/deploy` are distinct concepts because
their paths differ, not because their first segment is a recognized word.

An item's `type` is an **attribute of the resolved item**, supplied by the
selected adapter, not a predicate parsed out of the ref string. The `okf`
adapter reads it from OKF frontmatter; the `akm` adapter derives it from its
native matcher and placement rules. This is why a ref into any bundle —
`okfbundle//tables/customers`, `wiki//pages/attention` — is just as addressable
as `personal//memories/vpn-note`. See [`okf-support.md`](./okf-support.md).

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

### Not item refs

- `viking://skills/deploy` (a URI scheme — a `:` before `//` is not a bundle slug)
- `skills/../../../etc/passwd` (`..` segments)
- `github:owner/repo` (an install ref, parsed elsewhere)
- the old `<type>:<name>` spelling; only the frozen migrator parses it

## Fragments

`akm show` is the only command that accepts a `#fragment`. Every other ref
boundary routes through `parseRefInput`, which rejects a fragment with
`INVALID_FLAG_VALUE`.

**Markdown-document items — section selector.** For an item whose adapter
presents it as a markdown document, the fragment names a section:

```text
akm show knowledge/api-guide#authentication
```

Resolution is: slugify each heading in the document (lowercase, non-alphanumeric
runs collapsed to `-`, trimmed) and match the fragment against those slugs;
fall back to a case-insensitive match against raw heading text. The selected
region runs from that heading to the next heading of the same or higher level.
A fragment that matches no heading is an error that **lists the available
fragment slugs**, which is how a caller discovers them. Opaque
`#akm-fragment-...` selectors resolve against the indexed revision; see
[Architecture: Show Resolution](../architecture.md#show-resolution).

**Every other item kind — adapter-owned selector.** The grammar reserves the
fragment for the adapter: when one item exposes multiple exports the adapter may
append a stable fragment (`team//tools/toolbox#deploy`), and the core does not
interpret it. Today `akm show` ignores a fragment on an item that is not a
Markdown document, warns, and shows the whole item.

**Fragments are input-only.** Durable state — index rows, state keys, proposal
targets, bindings — does not store a fragment, and a stored ref carrying one is
invalid.

## Ref-prefix enumeration (browse)

Browsing a subtree uses a **conceptId prefix**, matching the grammar refs are
emitted in:

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

Enumeration is prefix-matching over conceptIds, so it covers every adapter's
items uniformly, and a prefix copied out of search output works as typed.

## Asset types are free-form

`type` is adapter-supplied metadata that presents, ranks, and filters — it
does not execute and does not identify. The OKF adapter reads the open OKF `type`
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

`akm bundle add` and one-shot `akm clone` accept a different ref grammar. Install
refs locate an upstream kit to fetch; they are **not** item refs and are
parsed by `parseRegistryRef` in `src/registry/resolve.ts`.

```text
install-ref := github-ref | git-url | npm-pkg | https-url | skills-sh-slug | local-path
```

Examples: `github:owner/repo#v1.2.3`, `git+https://gitlab.com/org/kit`,
`@scope/kit`, `https://docs.example.com`,
`./path/to/kit`.

The two parsers are intentionally distinct — each rejects the other's inputs.
Item refs do not carry URI schemes; install refs are not addressable through
`akm show`.

## Bundle prefix

When a ref includes a bundle prefix, `akm show` narrows lookup to that bundle:

```text
team-catalog//scripts/deploy.sh
personal//knowledge/my-notes
```

When absent, a short ref from CLI/API input resolves to `defaultBundle` if the
conceptId exists there, otherwise to the first bundle containing it in installation
priority order (first match wins, deterministically). akm does not resolve refs
found inside bundle content. The one place it checks them is `akm lint`'s
missing-ref scan, which looks a ref up among that bundle's own files (see
[Refs in prose](#refs-in-prose)). To pin lookup to a single bundle programmatically, use
`resolveRef(input, { only: bundleId })` — there is no ref spelling for "primary
only".

## Refs in prose

Refs embedded in prose must use the fully-qualified `bundle//conceptId` form —
the bundle-slug charset makes such a token lexically anchored — or a native
link form owned by the adapter (OKF links, wiki links). **Bare short refs in
prose are not refs**: `memories/foo` in a sentence is ordinary text, and no
tool rewrites it. `akm lint`'s missing-ref scan checks fully-qualified refs in
body text, and bare refs in the frontmatter ref fields (`xrefs`, `supersededBy`,
`contradictedBy`), against the bundle's own files.

## Renames and moves

A rename or move is **delete plus create**. The destination is a new identity:
it gets a fresh index row, and learned state (utility, salience, outcomes,
usage history) does not follow it.

```sh
mv ~/akm/memories/old-note.md ~/akm/memories/new-note.md
# update any intentional refs to it
akm index
akm lint          # confirms nothing dangles
```

Moving an item **between bundles** is copy/import followed by deletion from the
source. Both the bundle and the concept identity change; there is no
identity-preserving cross-bundle move.

Carrying learned state (utility, salience, usage history) across a rename is
opt-in and out-of-band: run `bun scripts/rekey-asset-ref.ts <old-ref> <new-ref>`
from a source checkout **before** `akm index`, and it re-keys the `entries` row
plus `asset_salience`/`asset_outcome`/`usage_events` in place rather than letting
`akm index` mint a fresh row. See
[`v0.9.0-troubleshooting.md`](../../migration/v0.9.0-troubleshooting.md) for the
walkthrough.

Renaming a *bundle* is separate: `akm bundle rename <old> <new>` is the one
command that changes a bundle id. It rewrites the config `bundles` key,
`defaultBundle` and `defaultWriteTarget`, `scheduler.enabled` refs, the lockfile
entry, and the stored `bundle//` refs in index entries, proposals, and task
history. Refs inside bundle content are reported, not rewritten, and usage,
salience, and outcome history keyed by the old prefix stays behind. See
the [`bundle` entry in the CLI reference](../../reference/cli.md#bundle).

## Usage Notes

Pass the `ref` from search output back to `show` unchanged as the lookup
token.

## Canonical Form

Refs are emitted in canonical form: the bundle slug (when qualified), the
adapter-canonical conceptId, and an optional `#fragment`. The adapter decides
whether an on-disk extension is stripped: OKF and AKM Markdown items strip
`.md`, scripts retain executable extensions, and directory-items such as
skills resolve on the directory path (`skills/<dir>`, not
`skills/<dir>/SKILL`).
