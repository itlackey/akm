# OKF format support

OKF is a first-class format supported by AKM through the built-in `okf`
adapter: a conformant OKF bundle installs, indexes, searches, and shows
without being converted to an AKM-native layout.

## What OKF is to AKM

OKF is AKM's least-common-denominator format for Markdown concepts and generic
read behavior. It is not AKM's database schema, and it does not force
non-Markdown formats through Markdown. In particular, OKF is **not**:

- an AKM asset type;
- a serialization imposed on scripts, YAML tasks, environment files, secrets,
  Agent Skills, or other native non-Markdown assets;
- a replacement for adapter-owned capability, validation, redaction, placement,
  or execution rules.

The core provides path identity, open descriptive types, generic Markdown
content/fragment reads, and a normalized search projection (`IndexDocument`).
Adapters add behavior to that baseline. An adapter does not narrow the core by
rejecting an item only because its `type` is unfamiliar.

## What the `okf` adapter does

For a bundle selected as `adapter: okf`:

1. Every conformant non-reserved Markdown concept is recognized with its OKF
   path-minus-`.md` concept ID.
2. `type`, `title`, `description`, `tags`, and `timestamp` are read according
   to OKF rules. Unknown types and unknown frontmatter fields remain valid. A
   concept with no `type` gets the default `knowledge`.
3. `index.md` and `log.md` keep their OKF structural meaning and are not
   indexed as concepts.
4. OKF links (both `/`-rooted bundle-relative and standard relative forms) are
   retained as relationships. A dangling link does not prevent indexing.
5. A ref emitted by search for an OKF concept is accepted by `show`. Adapter-owned
   concept IDs such as `tables/customers` are valid even though they do not use
   an AKM placement directory.
6. Markdown heading fragments are accepted as input-only selectors and do not
   become part of durable identity.
7. AKM-native write commands refuse an OKF target before touching disk, because
   the adapter has no authoring path (`assertAkmAssetWrite` in
   `src/core/write-source.ts` allows only the `akm` adapter by default).

The `okf` adapter is consumer-only. It does not infer task, command, script,
environment, or secret capabilities from an arbitrary OKF `type` value. Its
validation is lenient (a missing `type` or a broken link is reported but does
not block indexing). `tests/integration/okf-conformance.test.ts` exercises this
behavior end to end.

## Progressive enhancement

AKM Markdown is an OKF-compatible superset. Newly authored AKM Markdown emits a
non-empty native `type` plus any AKM-specific frontmatter required by its asset
kind. The `akm` adapter still derives native identity and capability from its
directory, extension, filename, and content rules; frontmatter `type` does not
override those rules. Existing Markdown without `type` stays readable and is
upgraded when AKM creates or semantically rewrites it, not during indexing.

The result is progressive enhancement:

1. Any OKF type gets path identity, indexing, search, content show, and heading
   fragments through the `okf` adapter.
2. The `akm` adapter recognizes AKM-owned types and adds their specialized
   behavior: command prompts, runnable scripts, workflows, tasks, redacted
   environment/secret views, memories, lessons, and other native capabilities.
3. Unknown `type` values remain valid data. They get generic behavior unless
   the selected adapter explicitly adds more.

`akm bundle create` records `adapter: akm`. `akm bundle add` records the detected
adapter, and an explicit configured adapter always wins over probing. Strong
native AKM layout evidence wins before the broader OKF probe because AKM
Markdown is an OKF superset. An index-less bundle containing conformant typed
Markdown can still be recognized as OKF. See [Adapters](../adapters.md) for the
probe order.

The normalized `IndexDocument` is the additive cross-format projection. Its
basic Markdown fields align with OKF, while adapters may project additional
metadata and capabilities without changing identity.

## OKF v0.2 provenance and lifecycle fields

OKF v0.2 adds a trust/provenance frontmatter family (`generated`, `verified`,
`sources`) and a lifecycle family (`status`, `stale_after`), standardizes an
actor convention (`<producer>/<version>`, `human:<id>`, `process:<id>`), and
supersedes `timestamp` with `generated.at`, with consumers falling back to
`timestamp` when `generated.at` is absent.

- **Read side (any OKF bundle):** the `okf` adapter parses the v0.2 family —
  `generated.at` (with the `timestamp` fallback), `verified` (a list, or the
  single-mapping shorthand), `sources`, `status`, `stale_after`, and
  `okf_version` — leniently, like every other optional OKF field: missing,
  malformed, or foreign values never reject a document. These land on
  namespaced `IndexDocument` fields (`provenance`, `lifecycleStatus`,
  `staleAfter`, `okfVersion`) rather than the AKM-native fields that already
  occupy adjacent names (`sources?: string[]` for wiki citations and the
  `quality: "generated"` value).
- **Write side (AKM-native assets only):** when an accepted proposal is promoted
  into an AKM-native bundle (`promoteProposal`), the provenance fields are
  stamped from the proposal's recorded source and gate decision. The `okf`
  adapter never writes. `generated: {by, at}` and `verified: [{by, at}]` are
  written bare at the top level, as OKF v0.2 spells them, so a third-party OKF
  v0.2 reader sees conformant provenance. `sources` stays namespaced as
  `provenance: {sources: [...]}` because a bare top-level `sources:` collides
  with the wiki citation-string convention.

Re-verification driven by `stale_after`, and trust-tier ranking, are not
implemented.

AKM implements the OKF core rules and the v0.2 fields above; it does not follow
later upstream changes automatically.

## See also

- [Adapters](../adapters.md) describes the adapter contract, the probe order,
  and the write allowlist.
- [`ref.md`](./ref.md) defines the cross-format ref grammar.
