# OKF v0.2 Conformance Re-Evaluation Runbook

Use this runbook after changing AKM's adapters, indexing, refs, writes, or lint
behavior. It is the acceptance procedure for
[first-class OKF format support](../specs/okf-support.md). It runs without
reading or modifying the host's AKM installation, bundle, configuration, cache,
or index.

The runbook deliberately tests observable behavior in addition to unit tests.
Passing adapter-local tests is not enough: the original failures happened
between recognition, persistence, search output, and command ref parsing.

**v0.2 update (#730):** upstream OKF minor-versioned to v0.2 (trust/provenance
family `generated`/`verified`/`sources`; lifecycle family `status`/
`stale_after`; an actor convention; `timestamp` superseded by `generated.at`
with a permitted fallback). Rules 1-9, Producer, and Lint below are unchanged
and still gate v0.1-only bundles; Rules 10-14 are new v0.2-specific gates. The
`okf` adapter stays **consumer-only** for both spec versions — see
`okf-support.md`'s v0.2 note for why AKM's own provenance *writes* go through
the proposal path onto AKM-native assets instead, and are out of this
runbook's scope (which evaluates the `okf` adapter's read/consumer behavior
against third-party and reference OKF bundles).

## Success Criteria

The evaluation passes only when all applicable statements are true:

| Rule | Required result |
|---|---|
| 1 | Every conformant non-reserved Markdown concept is represented by its path-minus-`.md` identity. Different paths cannot collide even when their titles match. Search emits that identity, and `show` accepts it. |
| 2 | Root and nested `index.md`/`log.md` files never become concepts. |
| 3 | Any non-empty `type` value survives unchanged and receives generic behavior when unknown. |
| 4 | Missing title falls back to the filename without changing identity. |
| 5 | If AKM modifies an existing OKF document, unknown nested frontmatter keys and the body survive unless the requested operation explicitly changes them. If AKM has no OKF write path, record this rule as not applicable rather than satisfied. |
| 6 | Inline, root-relative, relative, reference-style, and dangling concept links survive as durable directed relationships. A dangling target does not reject indexing. |
| 7 | Index synthesis is optional. Record whether it exists; do not fail solely because it does not. |
| 8 | Missing optional fields, unknown type, unknown keys, dangling links, and missing index files do not cause OKF semantics to be abandoned. |
| 9 | An unknown `okf_version` receives best-effort consumption. |
| 10 | `generated.at`, when present, takes precedence over legacy `timestamp` for the freshness/`updated` field; `timestamp` alone remains a fully valid fallback reading; neither present is not an AKM freshness error. |
| 11 | `verified` is read in both its list form and its v0.2-permitted single-mapping (no list dash) form; each entry survives as a durable `{by, at?}` pair; a malformed entry is dropped, never rejecting the document. |
| 12 | `sources` as a v0.2 object list (`resource` required; `id`/`title`/`author`/`usage_count`/`last_modified` optional) survives intact and distinctly from any pre-existing AKM `sources` convention — it must never be silently coerced into a bare string list (which would drop every entry). |
| 13 | `status` (`draft`/`stable`/`deprecated`) and `stale_after` are read verbatim when present; an unrecognized `status` value is ignored rather than guessed at, and neither field's absence is an error. |
| 14 | If AKM's own accepted-proposal writes stamp OKF v0.2 provenance onto AKM-native assets, record what is stamped and confirm it never applies to an OKF-adapter target (Rule 5 / runbook §10's write-rejection contract must stay intact). If AKM has no such write path, record this rule as not applicable. |
| Producer | If AKM claims to produce OKF, every emitted non-reserved Markdown file has parseable mapping frontmatter with a non-empty type, and reserved files have structural content. Otherwise record AKM as consumer-only. |
| Lint | `--fail-on-flagged` does not turn a dangling OKF body link into a failing exit status. |

Type participation in FTS and ranking is not a conformance gate. Record it for
regression awareness, but do not fail the OKF verdict because of it.

## 1. Prerequisites And Subject Capture

Run from the AKM repository root. Required host tools are Docker and Git. Bun,
Node, AKM, SQLite, and the Google checkout run only inside Docker.

Record the exact subject before testing:

```bash
git status --short
git rev-parse HEAD
git diff --stat
```

Uncommitted source changes are included in the Docker build because the local
working tree is the build context. Existing `node_modules`, `dist`, `.git`, and
developer state are excluded by `.dockerignore`.

Set stable names and pin the same upstream OKF snapshot used by the baseline
audit:

```bash
export AKM_OKF_IMAGE="akm-okf-eval:local"
export AKM_OKF_CONTAINER="akm-okf-eval"
export KC_REF="3fcbb9f828c2f23d109c855ee403c3a4c81f3a96"
export AKM_SUBJECT="$(git rev-parse HEAD)$(test -n "$(git status --porcelain)" && printf '%s' '-dirty')"
```

If intentionally updating the OKF reference revision, inspect the upstream
`okf/SPEC.md` diff first. Do not silently compare AKM against a changed spec.

**2026-07-30 bump (#730):** `KC_REF` was moved from `d44368c15e38e7c92481c5992e4f9b5b421a801d`
(the v0.1 baseline) to `3fcbb9f828c2f23d109c855ee403c3a4c81f3a96`, obtained via
`git ls-remote https://github.com/GoogleCloudPlatform/knowledge-catalog.git HEAD`
and cross-checked against `git ls-remote ... refs/heads/main` (both resolved to
the same commit) — a real, verified upstream commit, not an invented one. The
`okf/SPEC.md` content at that exact commit was fetched and confirmed to state
"This document specifies OKF version 0.2" with the `generated`/`verified`
field definitions this update implements against. This runbook update was done
without Docker access to actually run the container-based evaluation in
this session; §§2-13 below are updated to describe the v0.2 procedure a
maintainer should run, but have not been re-executed end-to-end against a
live container since this bump. Treat the `KC_REF` bump and the procedural
updates as reviewed-but-unexecuted until a maintainer runs this runbook for
real.

## 2. Build The Isolated AKM Image

This image contains the working tree under test, Bun, Git, and SQLite. It does
not mount the host home directory.

```bash
docker build \
  --build-arg AKM_SUBJECT="$AKM_SUBJECT" \
  --tag "$AKM_OKF_IMAGE" \
  --file - . <<'DOCKERFILE'
FROM oven/bun:1.3.6-debian
ARG AKM_SUBJECT
LABEL org.opencontainers.image.revision="$AKM_SUBJECT"
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates sqlite3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run build
ENV PATH="/app/dist:${PATH}"
CMD ["sleep", "infinity"]
DOCKERFILE
```

Start a long-lived evaluation container with an isolated home:

```bash
docker rm -f "$AKM_OKF_CONTAINER" 2>/dev/null || true
docker run --detach \
  --name "$AKM_OKF_CONTAINER" \
  --env HOME=/tmp/akm-home \
  --env NO_COLOR=1 \
  "$AKM_OKF_IMAGE"
docker exec "$AKM_OKF_CONTAINER" mkdir -p /tmp/akm-home
docker exec "$AKM_OKF_CONTAINER" akm --version
```

Pass condition: the reported version is the code under test, and no command
references the host's home or XDG directories.

## 3. Clone And Pin Google's OKF Repository

```bash
docker exec "$AKM_OKF_CONTAINER" git clone \
  https://github.com/GoogleCloudPlatform/knowledge-catalog.git /tmp/kc
docker exec "$AKM_OKF_CONTAINER" git -C /tmp/kc checkout "$KC_REF"
docker exec "$AKM_OKF_CONTAINER" git -C /tmp/kc rev-parse HEAD
docker exec "$AKM_OKF_CONTAINER" sh -lc 'nl -ba /tmp/kc/okf/SPEC.md'
```

Pass condition: the printed revision equals `KC_REF`. Retain the numbered spec
output with the evaluation record.

## 4. Run Focused Existing Tests

Run the current adapter, registry, type, dispatch, and reserved-name tests:

```bash
docker exec "$AKM_OKF_CONTAINER" bun test \
  tests/integration/okf-conformance.test.ts \
  tests/core/akm-markdown.test.ts \
  tests/core/adapter/okf-adapter.test.ts \
  tests/core/adapter/conformance.test.ts \
  tests/core/adapter/registry.test.ts \
  tests/indexer/installations.test.ts \
  tests/core/type-token-contract.test.ts \
  tests/integration/indexer/adapter-dispatch.test.ts \
  tests/integration/reserved-filename-conformance.test.ts
```

v0.2 update (#730): also run the promotion-path provenance-stamping coverage
(D2 — write side, AKM-native assets only, not the `okf` adapter itself) and
the OKF format-family golden:

```bash
docker exec "$AKM_OKF_CONTAINER" bun test \
  tests/integration/proposals.test.ts \
  tests/core/adapter/okf-adapter.test.ts
```

After implementing fixes, the repository should also contain focused
end-to-end tests for these behaviors:

| Coverage to require | Minimum assertion |
|---|---|
| Official OKF fixture | Persisted concept count equals all non-reserved `.md` files. |
| Identity | Same type/title at two paths produces two refs and two rows. |
| Search/show | Search ref is `<bundle>//<path-minus-.md>` and `show` accepts it. |
| Missing index | Explicitly configured or otherwise recognized OKF still uses OKF semantics. |
| v0.2 `generated`/`timestamp` | `generated.at` wins when both are present; `timestamp` alone still satisfies freshness; neither present is not an error. |
| v0.2 `verified` | Both the list form and the single-mapping form persist as a non-empty `{by, at?}` array. |
| v0.2 `sources` | An object list survives intact and distinctly from the bare AKM `sources: string[]` convention. |
| v0.2 `status`/`stale_after` | Both read verbatim when present; an unrecognized `status` is ignored, not guessed at. |
| D2 promotion-path stamping | An accepted AKM-native proposal's written frontmatter carries `generated`/`verified` (and `sources` when `evidenceSources` was present); an OKF-adapter target is still rejected before any write (Rule 5 / write-rejection contract unchanged). |
| Links | Root-relative, relative, reference-style, and dangling links survive persistence. |
| Unknown values | Unknown type/version/key never rejects the bundle. |
| Writes | OKF writes are either blocked or produce conformant documents through adapter-owned placement. |
| Reserved names | Concept writers reject `index` and `log` at every depth. |
| Lint | A dangling OKF body link remains non-blocking under `--fail-on-flagged`. |

Run those new files explicitly in addition to the existing suite. Do not rely
only on test names containing `conformance`; the original conformance suite
tested adapter-local folds, not durable behavior.

## 5. Initialize Container-Local AKM State

```bash
docker exec "$AKM_OKF_CONTAINER" akm bundle create \
  --dir /tmp/akm-home/akm \
  --set-default
```

Pass condition: config is written under `/tmp/akm-home`, not a mounted host
path.

## 6. Evaluate Google's GA4 Bundle

Add and fully index the real producer output:

```bash
docker exec "$AKM_OKF_CONTAINER" akm bundle add \
  /tmp/kc/okf/bundles/ga4 \
  --name okf-ga4
docker exec "$AKM_OKF_CONTAINER" akm index --full
docker exec "$AKM_OKF_CONTAINER" akm bundle list
docker exec "$AKM_OKF_CONTAINER" akm search orders \
  --format json --detail full --limit 100
docker exec "$AKM_OKF_CONTAINER" akm search events \
  --format json --detail full --limit 100
docker exec "$AKM_OKF_CONTAINER" akm show \
  okf-ga4//tables/events_ --format json --detail full
```

The `orders` search is informational, not a conformance gate. OKF does not
require a particular search index. The `show` command is a gate because it
tests whether the path identity emitted by the adapter remains usable through
the consumer.

Verify adapter ownership, count, type, and identity directly in the derived
index. These SQL gates target the exact v22 `entries` generation. A managed
index open discards any generation whose version or complete schema fingerprint
does not match v22, then `akm index --full` repopulates the canonical table from
source. Reader-only openers reject an incompatible generation instead of
serving legacy columns.

```bash
docker exec "$AKM_OKF_CONTAINER" sh -lc '
set -eu
db=/tmp/akm-home/.local/share/akm/index.db
root=/tmp/kc/okf/bundles/ga4
version=$(sqlite3 "$db" "SELECT value FROM index_meta WHERE key='"'"'version'"'"';")
columns=$(sqlite3 "$db" "SELECT group_concat(name, '"'"','"'"') FROM (SELECT name FROM pragma_table_xinfo('"'"'entries'"'"') ORDER BY cid);")
expected=$(find "$root" -type f -name "*.md" ! -iname "index.md" ! -iname "log.md" | wc -l)
actual=$(sqlite3 "$db" "SELECT count(*) FROM entries WHERE bundle_id='"'"'okf-ga4'"'"';")
adapter=$(sqlite3 "$db" "SELECT group_concat(DISTINCT adapter_id) FROM entries WHERE bundle_id='"'"'okf-ga4'"'"';")
printf "schema=v%s columns=%s expected_concepts=%s actual_concepts=%s adapter=%s\n" "$version" "$columns" "$expected" "$actual" "$adapter"
test "$version" = "22"
test "$columns" = "id,item_ref,bundle_id,component_id,concept_id,adapter_id,type,file_path,content_hash,document_json,search_text,derived_from"
test "$expected" -eq "$actual"
test "$adapter" = "okf"
sqlite3 -header -column "$db" "SELECT item_ref, concept_id, type, adapter_id, file_path FROM entries WHERE bundle_id='"'"'okf-ga4'"'"' ORDER BY item_ref;"
'
```

Pass conditions:

- `index_meta.version` is `22` and `entries` has exactly the canonical v22
  column sequence shown above.
- Expected and actual counts match.
- Every row has `adapter_id=okf`.
- `item_ref` is `okf-ga4//<concept_id>`.
- `BigQuery Dataset`, `BigQuery Table`, and `Reference` survive unchanged.
- No `index.md` or `log.md` row exists.
- `akm show okf-ga4//tables/events_` succeeds.

Verify that search emits path refs rather than title refs:

```bash
docker exec "$AKM_OKF_CONTAINER" sh -lc '
set -eu
akm search events --format json --detail full --limit 100 > /tmp/ga4-search.json
bun -e '\''import fs from "node:fs"; const r=JSON.parse(fs.readFileSync("/tmp/ga4-search.json","utf8")); const h=r.hits.find((x)=>x.path.endsWith("/tables/events_.md")); if(!h) throw new Error("events_ hit missing"); if(h.ref!=="okf-ga4//tables/events_") throw new Error(`wrong ref: ${h.ref}`);'\''
'
```

## 7. Create Adversarial Bundles Inside Docker

Create all fixtures inside the container. Nothing is written to the host.

```bash
docker exec -i "$AKM_OKF_CONTAINER" sh -lc 'tee /tmp/create-okf-fixtures.mjs >/dev/null' <<'FIXTURE_SCRIPT'
import fs from "node:fs";
import path from "node:path";

function write(root, rel, content) {
  const dest = path.join(root, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
}

const root = "/tmp/okf-adversarial";
write(root, "index.md", `---
okf_version: "9.9"
---

# Adversarial bundle
`);
write(root, "log.md", `# Update Log

## 2026-07-23
* **Update**: Created the evaluation bundle.
`);
write(root, "sub/index.md", `# Subdirectory

* [Duplicate](duplicate-b.md)
`);
write(root, "plain.md", `# Plain

No frontmatter. Marker: plain-body-only.
`);
write(root, "notype.md", `---
title: No Type
optional_vendor_key: retained-if-roundtripped
---

Missing type. Marker: no-type-body-only.
`);
write(root, "unknown.md", `---
type: Some Vendor Thing
title: Vendor Item
vendor_meta:
  owner: vendor
  revision: 7
---

# Overview

Marker: vendor-body-only.

[Root](/target.md)
[Relative](./relative.md)
[Dangling](/missing.md)
[Reference style][vendor-reference]

[vendor-reference]: /ref-target.md
`);
write(root, "target.md", `---
type: Known
title: Root Target
---

Target body.
`);
write(root, "relative.md", `---
type: Known
title: Relative Target
---

Relative body.
`);
write(root, "ref-target.md", `---
type: Known
title: Reference Target
---

Reference target body.
`);
write(root, "duplicate-a.md", `---
type: Vendor Duplicate
title: Same Title
---

First concept.
`);
write(root, "sub/duplicate-b.md", `---
type: Vendor Duplicate
title: Same Title
---

Second concept.
`);
write(root, ".hidden/hidden.md", `---
type: Hidden Concept
title: Hidden Concept
---

Hidden directory concept.
`);
write(root, "bin/bin-doc.md", `---
type: Bin Concept
title: Bin Concept
---

Bin directory concept.
`);
write(root, "knowledge/roundtrip.md", `---
type: Some Vendor Thing
title: Round Trip
vendor_meta:
  owner: preserve-me
  nested:
    value: 42
---

Round-trip body marker.
`);
// v0.2 update (#730): the full trust/provenance/lifecycle family in one
// concept — generated (supersedes legacy timestamp), verified (list form),
// object-list sources, status, stale_after.
write(root, "knowledge/v2-full.md", `---
type: Some Vendor Thing
title: V0.2 Full Family
generated:
  by: reference_agent/gemini-2.5-pro
  at: 2026-06-20T22:53:05Z
verified:
  - by: human:ahormati
    at: 2026-06-25T09:00:00Z
  - by: process:finance-nightly
    at: 2026-06-26T03:00:00Z
sources:
  - resource: https://example.com/data/export.csv
    id: main-dataset
    title: Example export
    author: human:jdoe
    usage_count: 3
    last_modified: "2026-06-01"
  - resource: gs://acme-bucket/raw.parquet
status: stable
stale_after: "2026-12-31"
---

V0.2 full-family body marker.
`);
// v0.2 update (#730): verified SINGLE-MAPPING form (no list dash) + draft status.
write(root, "knowledge/v2-verified-single.md", `---
type: Some Vendor Thing
title: V0.2 Verified Single Mapping
generated:
  by: human:ahormati
  at: 2026-06-18T00:00:00Z
verified:
  by: human:ahormati
  at: 2026-06-18T00:05:00Z
status: draft
---

V0.2 single-mapping verified body marker.
`);

const noIndex = "/tmp/okf-no-index";
write(noIndex, "vendor.md", `---
type: Some Vendor Thing
title: No Index Vendor
vendor_key: keep
---

No-index marker.
`);

const overlap = "/tmp/okf-wiki-overlap";
write(overlap, "index.md", "# Root index\n");
write(overlap, "schema.md", "# Wiki schema\n");
write(overlap, "pages/page.md", `---
page_kind: concept
---

# Wiki page
`);

const lintRoot = "/tmp/okf-lint-dangling";
write(lintRoot, "index.md", "# Root index\n");
write(lintRoot, "concepts/source.md", `---
type: Reference
title: Dangling Source
---

[Future concept](/concepts/not-yet-written.md)
`);
FIXTURE_SCRIPT
docker exec "$AKM_OKF_CONTAINER" bun /tmp/create-okf-fixtures.mjs
```

Add the bundles and rebuild:

```bash
docker exec "$AKM_OKF_CONTAINER" akm bundle add \
  /tmp/okf-adversarial --name adversarial
docker exec "$AKM_OKF_CONTAINER" akm bundle add \
  /tmp/okf-no-index --name noindex
docker exec "$AKM_OKF_CONTAINER" akm bundle add \
  /tmp/okf-wiki-overlap --name overlap
docker exec "$AKM_OKF_CONTAINER" akm bundle add \
  /tmp/okf-lint-dangling --name lint-dangling
docker exec "$AKM_OKF_CONTAINER" akm index --full
```

## 8. Assert Recognition And Tolerance

Run the database assertions:

```bash
docker exec "$AKM_OKF_CONTAINER" sh -lc '
set -eu
db=/tmp/akm-home/.local/share/akm/index.db

test "$(sqlite3 "$db" "SELECT group_concat(DISTINCT adapter_id) FROM entries WHERE bundle_id='"'"'adversarial'"'"';")" = "okf"
test "$(sqlite3 "$db" "SELECT group_concat(DISTINCT adapter_id) FROM entries WHERE bundle_id='"'"'noindex'"'"';")" = "okf"
test "$(sqlite3 "$db" "SELECT group_concat(DISTINCT adapter_id) FROM entries WHERE bundle_id='"'"'overlap'"'"';")" = "llm-wiki"

test "$(sqlite3 "$db" "SELECT type FROM entries WHERE item_ref='"'"'adversarial//unknown'"'"';")" = "Some Vendor Thing"
test "$(sqlite3 "$db" "SELECT type FROM entries WHERE item_ref='"'"'noindex//vendor'"'"';")" = "Some Vendor Thing"

test "$(sqlite3 "$db" "SELECT count(*) FROM entries WHERE bundle_id='"'"'adversarial'"'"' AND type='"'"'Vendor Duplicate'"'"';")" -eq 2
test "$(sqlite3 "$db" "SELECT count(*) FROM entries WHERE item_ref IN ('"'"'adversarial//.hidden/hidden'"'"','"'"'adversarial//bin/bin-doc'"'"');")" -eq 2
test "$(sqlite3 "$db" "SELECT count(*) FROM entries WHERE bundle_id='"'"'adversarial'"'"' AND lower(file_path) GLOB '"'"'*/*index.md'"'"';")" -eq 0
test "$(sqlite3 "$db" "SELECT count(*) FROM entries WHERE bundle_id='"'"'adversarial'"'"' AND lower(file_path) GLOB '"'"'*/*log.md'"'"';")" -eq 0

sqlite3 -header -column "$db" "SELECT item_ref,type,adapter_id FROM entries WHERE item_ref IN ('"'"'adversarial//plain'"'"','"'"'adversarial//notype'"'"') ORDER BY item_ref;"
sqlite3 -header -column "$db" "SELECT bundle_id,item_ref,type,adapter_id,file_path FROM entries WHERE bundle_id IN ('"'"'adversarial'"'"','"'"'noindex'"'"','"'"'overlap'"'"') ORDER BY bundle_id,item_ref;"
'
```

These assertions are permanent gates for the no-index source, duplicate title
pair, hidden directory, and `bin` directory. A change is not complete until
each conformant path-defined concept survives independently.
The plain and missing-type rows are printed for observation but are not gates:
those files are nonconformant producers, and OKF does not require a consumer to
accept a concept whose required `type` is absent.

v0.2 update (#730) — assert the trust/provenance/lifecycle family on the two
new fixtures (Rules 10-13):

```bash
docker exec "$AKM_OKF_CONTAINER" sh -lc '
set -eu
db=/tmp/akm-home/.local/share/akm/index.db

full=$(sqlite3 "$db" "SELECT document_json FROM entries WHERE item_ref='"'"'adversarial//knowledge/v2-full'"'"';")
bun -e '\''
const e = JSON.parse(process.argv[1]);
if (e.updated !== "2026-06-20T22:53:05Z") throw new Error(`generated.at not preferred: ${e.updated}`);
if (e.provenance?.generatedBy !== "reference_agent/gemini-2.5-pro") throw new Error("generatedBy missing");
if (!Array.isArray(e.provenance?.verified) || e.provenance.verified.length !== 2) throw new Error("verified list wrong length");
if (!Array.isArray(e.provenance?.sources) || e.provenance.sources.length !== 2) throw new Error("sources object-list wrong length");
if (e.provenance.sources[0].resource !== "https://example.com/data/export.csv") throw new Error("sources[0].resource wrong");
if (e.lifecycleStatus !== "stable") throw new Error(`lifecycleStatus wrong: ${e.lifecycleStatus}`);
if (e.staleAfter !== "2026-12-31") throw new Error(`staleAfter wrong: ${e.staleAfter}`);
// The pre-existing AKM-native sources:string[] field (wiki citations) must
// NEVER be populated by the okf adapter -- it is a completely different field.
if (e.sources !== undefined) throw new Error("bare sources field must stay unset for okf-adapter documents");
'\'' "$full"

single=$(sqlite3 "$db" "SELECT document_json FROM entries WHERE item_ref='"'"'adversarial//knowledge/v2-verified-single'"'"';")
bun -e '\''
const e = JSON.parse(process.argv[1]);
if (!Array.isArray(e.provenance?.verified) || e.provenance.verified.length !== 1) throw new Error("single-mapping verified did not normalize to a one-element array");
if (e.provenance.verified[0].by !== "human:ahormati") throw new Error("verified[0].by wrong");
if (e.lifecycleStatus !== "draft") throw new Error(`lifecycleStatus wrong: ${e.lifecycleStatus}`);
'\'' "$single"
'
```

Pass condition: both `bun -e` checks above exit zero (no thrown error).

Verify unknown type filtering and path-based show:

```bash
docker exec "$AKM_OKF_CONTAINER" akm search Vendor \
  --type 'Some Vendor Thing' \
  --format json --detail full --limit 100
docker exec "$AKM_OKF_CONTAINER" akm show \
  adversarial//unknown --format json --detail full
docker exec "$AKM_OKF_CONTAINER" akm show \
  'adversarial//unknown#overview' --format json --detail full
docker exec "$AKM_OKF_CONTAINER" akm show \
  noindex//vendor --format json --detail full
```

Pass condition: both `show` calls succeed without requiring an AKM type-directory
prefix.

Verify the search ref for the unknown-type document:

```bash
docker exec "$AKM_OKF_CONTAINER" sh -lc '
set -eu
akm search Vendor --format json --detail full --limit 100 > /tmp/vendor-search.json
bun -e '\''import fs from "node:fs"; const r=JSON.parse(fs.readFileSync("/tmp/vendor-search.json","utf8")); const h=r.hits.find((x)=>x.path==="/tmp/okf-adversarial/unknown.md"); if(!h) throw new Error("vendor hit missing"); if(h.ref!=="adversarial//unknown") throw new Error(`wrong ref: ${h.ref}`);'\''
'
```

## 9. Assert Durable Link Semantics

The adversarial `unknown.md` has four distinct concept targets:

- `target` from a bundle-root-relative inline link.
- `relative` from a relative inline link.
- `missing` from a dangling bundle-root-relative inline link.
- `ref-target` from a reference-style Markdown link.

The dangling target must remain represented as an edge even though no target
document exists.

The current `IndexDocument` contract has a first-class `links` field, so the
minimal persistence acceptance test is:

```bash
docker exec "$AKM_OKF_CONTAINER" sh -lc '
set -eu
db=/tmp/akm-home/.local/share/akm/index.db
links=$(sqlite3 "$db" "SELECT json_extract(document_json,'"'"'$.links'"'"') FROM entries WHERE item_ref='"'"'adversarial//unknown'"'"';")
printf "durable_links=%s\n" "$links"
bun -e '\''const links=JSON.parse(process.argv[1]); const want=["target","relative","missing","ref-target"]; for(const x of want) if(!links.includes(x)) throw new Error(`missing link ${x}`); if(links.length!==want.length) throw new Error(`unexpected links ${JSON.stringify(links)}`);'\'' "$links"
'
```

If the implementation intentionally moves links into a dedicated relation
table, replace this assertion with an equivalent query against that table and
retain a test proving all four directed edges. Do not count LLM-extracted entity
relations as OKF concept links.

## 10. Evaluate Writable OKF Targets And Round-Trip Behavior

AKM has two conformant policies for an OKF source. The 0.9.0 `okf` adapter uses
the consumer-only policy:

| Policy | Required behavior |
|---|---|
| Consumer-only/read-only | The write command fails before creating or changing a file. |
| Writable OKF | Placement is adapter-owned, every new concept is conformant, and metadata-only edits preserve unknown keys and body bytes. |

**v0.2 update (#730) — Rule 14 scope note:** the assertions below are entirely
about writes *targeting an OKF-adapter bundle* (`adversarial`), and that
policy is unchanged by the v0.2 update — the write command below must still
fail before touching disk. AKM's new v0.2 provenance-stamping behavior (D2)
is a completely separate code path: accepting a proposal stamps
`generated`/`verified` frontmatter onto an **AKM-native** target through
`promoteProposal`, never through the `okf` adapter — it is orthogonal to
every assertion in this section. This runbook does not script a manual D2
spot-check (the `akm proposal`/`akm remember` CLI surface for driving one
deterministically end-to-end was not re-verified against this container in
this update); `tests/integration/proposals.test.ts`'s `"D2 (#730): ..."`
suite is the authoritative, already-passing coverage for Rule 14 — rerun it
if you need to re-confirm this specific behavior:
`bun test tests/integration/proposals.test.ts -t D2`.

Attempt a superseding write while recording its exit status:

```bash
set +e
docker exec "$AKM_OKF_CONTAINER" akm remember \
  'Correction written during OKF conformance evaluation' \
  --name correction \
  --bundle adversarial \
  --supersedes adversarial//knowledge/roundtrip
export OKF_WRITE_STATUS=$?
set -e
printf 'okf_write_status=%s\n' "$OKF_WRITE_STATUS"
```

If the status is non-zero, verify that no correction was created and record the
source as consumer-only/read-only.

```bash
if test "$OKF_WRITE_STATUS" -ne 0; then
  docker exec "$AKM_OKF_CONTAINER" test ! -e /tmp/okf-adversarial/memories/correction.md
fi
```

If the status is zero, verify the old document's unknown nested key, type, and
body survived, and verify the new document has a non-empty `type`:

```bash
if test "$OKF_WRITE_STATUS" -eq 0; then
  docker exec "$AKM_OKF_CONTAINER" bun -e '
    import fs from "node:fs";
    import { parse } from "yaml";
    function split(raw) {
      const m=raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
      if(!m) throw new Error("frontmatter missing");
      return {fm:parse(m[1]),body:m[2]};
    }
    const old=split(fs.readFileSync("/tmp/okf-adversarial/knowledge/roundtrip.md","utf8"));
    if(old.fm.type!=="Some Vendor Thing") throw new Error("type changed");
    if(old.fm.vendor_meta?.owner!=="preserve-me") throw new Error("unknown key lost");
    if(old.fm.vendor_meta?.nested?.value!==42) throw new Error("nested unknown key lost");
    if(!old.body.includes("Round-trip body marker.")) throw new Error("body changed");
    const created=split(fs.readFileSync("/tmp/okf-adversarial/memories/correction.md","utf8"));
    if(typeof created.fm.type!=="string" || !created.fm.type.trim()) throw new Error("new OKF concept has no type");
  '
fi
```

Test that concept writers reject reserved filenames. This must fail whether the
source is generally writable or consumer-only:

```bash
RESERVED_BEFORE=$(docker exec "$AKM_OKF_CONTAINER" sh -lc 'find /tmp/okf-adversarial -type f \( -iname "index.md" -o -iname "log.md" \) -exec sha256sum {} + | sort | sha256sum')
set +e
docker exec "$AKM_OKF_CONTAINER" akm remember \
  'Reserved index payload' --name index --bundle adversarial
INDEX_WRITE_STATUS=$?
docker exec "$AKM_OKF_CONTAINER" akm remember \
  'Reserved log payload' --name log --bundle adversarial
LOG_WRITE_STATUS=$?
set -e
test "$INDEX_WRITE_STATUS" -ne 0
test "$LOG_WRITE_STATUS" -ne 0
RESERVED_AFTER=$(docker exec "$AKM_OKF_CONTAINER" sh -lc 'find /tmp/okf-adversarial -type f \( -iname "index.md" -o -iname "log.md" \) -exec sha256sum {} + | sort | sha256sum')
test "$RESERVED_BEFORE" = "$RESERVED_AFTER"
docker exec "$AKM_OKF_CONTAINER" test ! -e /tmp/okf-adversarial/memories/index.md
docker exec "$AKM_OKF_CONTAINER" test ! -e /tmp/okf-adversarial/memories/log.md
```

A future structural index/log generator is allowed to write those files through
an explicitly structural path. The ban applies to concept writers, not to valid
structural production.

## 11. Evaluate Lint

Run lint against a conformant bundle whose only issue is a dangling body link:

```bash
docker exec "$AKM_OKF_CONTAINER" akm lint \
  --dir /tmp/okf-lint-dangling \
  --fail-on-flagged
```

Also run lint against the official bundle:

```bash
docker exec "$AKM_OKF_CONTAINER" akm lint \
  --dir /tmp/kc/okf/bundles/ga4 \
  --fail-on-flagged
```

Pass condition: both commands exit zero. The adapter-aware OKF lint walk checks
all concept paths, including ordinary dot directories and `bin/`. It may report
the dangling target as informational or non-blocking, but
`--fail-on-flagged` must not turn that spec-tolerated link into CI failure.

## 12. Optional Producer Validation

Skip this section if AKM explicitly remains consumer-only. Do not classify the
absence of a producer as a consumer failure.

If AKM adds a producer, save this checker inside the container:

```bash
docker exec -i "$AKM_OKF_CONTAINER" sh -lc 'tee /tmp/check-okf-producer.mjs >/dev/null' <<'CHECKER'
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";

const root = path.resolve(process.argv[2]);
const errors = [];

function frontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!m) return null;
  try {
    const data = parse(m[1]);
    return data && typeof data === "object" && !Array.isArray(data)
      ? { data, body: m[2] }
      : null;
  } catch {
    return null;
  }
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs);
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    const rel = path.relative(root, abs).replaceAll(path.sep, "/");
    const lower = entry.name.toLowerCase();
    const raw = fs.readFileSync(abs, "utf8");
    if (lower === "index.md") {
      const fm = frontmatter(raw);
      if (fm && rel !== "index.md") errors.push(`${rel}: nested index has frontmatter`);
      if (fm && Object.keys(fm.data).some((key) => key !== "okf_version")) {
        errors.push(`${rel}: root index frontmatter contains keys other than okf_version`);
      }
      continue;
    }
    if (lower === "log.md") {
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith("## ") && !/^## \d{4}-\d{2}-\d{2}$/.test(line)) {
          errors.push(`${rel}: invalid log date heading ${line}`);
        }
      }
      continue;
    }
    const fm = frontmatter(raw);
    if (!fm) {
      errors.push(`${rel}: missing or invalid mapping frontmatter`);
      continue;
    }
    if (typeof fm.data.type !== "string" || !fm.data.type.trim()) {
      errors.push(`${rel}: missing non-empty type`);
    }
  }
}

if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  throw new Error(`bundle not found: ${root}`);
}
walk(root);
if (errors.length) {
  for (const error of errors) console.error(error);
  process.exit(1);
}
console.log(`OKF producer check passed: ${root}`);
CHECKER
```

Generate a bundle through the public AKM producer command, then run:

```bash
docker exec "$AKM_OKF_CONTAINER" bun \
  /tmp/check-okf-producer.mjs /path/to/generated/bundle
```

The producer check is intentionally independent of AKM's parser. A producer
must not validate itself with the same lenient parser used by its consumer.

## 13. Run Repository Verification

After focused behavior passes, run the repository's normal checks inside the
same image:

```bash
docker exec "$AKM_OKF_CONTAINER" bun run check
docker exec "$AKM_OKF_CONTAINER" bun run build
```

For pre-commit verification, follow repository policy inside Docker:

```bash
docker exec "$AKM_OKF_CONTAINER" bunx biome check --write src/ tests/
docker exec "$AKM_OKF_CONTAINER" bun run check
```

The write-capable Biome command changes only the container copy. If it reports
changes, apply the equivalent formatting to the host working tree deliberately
and rebuild the image before treating the result as final.

## 14. Record The New Verdict

Create a result record containing:

```text
AKM commit and dirty state:
AKM version:
OKF repository commit (KC_REF):
Docker base image:
Focused tests:
Full check:
Official GA4 expected/actual concept count:
Official adapter IDs:
Official type values:
Official show-by-concept-ID result:
Adversarial adapter ID:
Missing-index adapter ID:
Overlap precedence result:
Duplicate-title row count:
Hidden/bin concept result:
Unknown type result:
Unknown version result:
Durable link targets:
Dangling-link indexing result:
Unknown-key round-trip result or N/A:
Reserved concept-write result:
Producer result or consumer-only:
Lint --fail-on-flagged result:
v0.2 generated.at precedence result:
v0.2 verified (list form) result:
v0.2 verified (single-mapping form) result:
v0.2 sources (object list) result:
v0.2 status/stale_after result:
D2 promotion-path provenance-stamping result or N/A:
Rule 1 verdict:
Rule 2 verdict:
Rule 3 verdict:
Rule 4 verdict:
Rule 5 verdict:
Rule 6 verdict:
Rule 7 verdict:
Rule 8 verdict:
Rule 9 verdict:
Rule 10 verdict:
Rule 11 verdict:
Rule 12 verdict:
Rule 13 verdict:
Rule 14 verdict:
Remaining deviations:
Remaining undetermined items:
```

Do not mark a rule satisfied from a direct adapter unit test if the durable or
CLI path still loses the behavior. Do not mark Rule 5 satisfied merely because
unknown keys did not cause a parse error. Likewise, do not mark Rules 10-13
satisfied from `tests/core/adapter/okf-adapter.test.ts` alone if the durable
persist path (`indexer/scan/doc-to-entry.ts`) or the `show`/`search` output
loses a field — this repo has a documented history (D1's own GREEN commit) of
`recognize()` returning a field correctly while a separate persistence-layer
reconstruction step silently dropped it before it ever reached `document_json`.

## 15. Cleanup

Remove all custom containers and images:

```bash
docker rm -f "$AKM_OKF_CONTAINER"
docker image rm "$AKM_OKF_IMAGE"
```

Optional verification that no host AKM state changed:

```bash
git status --short
```

Only intentional source/test/documentation changes should appear. No
`~/.config/akm`, `~/.cache/akm`, or local AKM index should have been read or
modified by this runbook.
