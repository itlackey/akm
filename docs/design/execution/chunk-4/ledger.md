# Chunk 4 — execution ledger — RETROACTIVE

> **RETROACTIVE LEDGER — reconstructed 2026-07-21 from git history; NOT a
> contemporaneous record.**
>
> **Why this exists:** the 2026-07-21 0.9.0 close-out audit found chunks 3, 4, 5,
> and 6.5 landed real code but never committed the per-chunk execution ledger the
> chunk-manifest's hard gate #4 requires. `git log --grep=ledger` shows ledger
> commits for chunks 0b/1/1.5/2/8/9/10 but none for 3/4/5/6.5. This backfills
> chunk 4.
>
> **Evidence classes** (every claim traces to one):
> - **[COMMIT]** — commit hash + `git show --stat` subject/body/diffstat.
> - **[GREP@HEAD]** — grep/command run at HEAD `e3eec904`
>   (branch `claude/akm-architecture-refactor-fubvd7`) on 2026-07-21. HEAD is
>   downstream of chunks 5–10, so this proves the *durable* end-state.
> - **[DOC]** — quote from a committed document.
> - **NO RECORD** — not answerable from the record; not reconstructed.
>
> **Could NOT be reconstructed:** contemporaneous Opus review verdicts, mid-chunk
> vs. close gate-run logs, batteries-at-close totals, escalation events. Commit
> bodies do not self-report a full `bun run check` for this chunk (unlike chunk 3).

Chunk 4 — **"Wiki asset-type death; LLM Wiki adapter restored"** (manifest id
`"4"`, order 10, wave 2, branch-of-record `akm-090/chunk-4`; landed on
`claude/akm-architecture-refactor-fubvd7`). Plan §11 Chunk 4, §7.4, §12.4,
**deviation DEV-7** (deviation analysis §1, resolution §4 item 5). **Chunk-2
coupling [DOC]:** chunk 2's ledger explicitly defers this adapter — "Other format
families — `llm-wiki`→Chunk 4" — so chunk 4 both *kills* the wiki asset-type token
and *restores* wiki semantics as a first-class `llm-wiki` bundle adapter (the
DEV-7 pivot: wiki is an adapter/format-family, not an AKM-owned type).

## Landed work items

Attributed by `git log --oneline --all --grep="chunk-4"` (12 raw hits; 4 later chunk-8 commits that merely MENTION chunk-4 artifacts were filtered out, leaving 8 commits; the §-labels
in the subjects, A–E, are the author's own decomposition). Ordered by §-label /
logical sequence; all dated 2026-07-18.

| § | Commit [COMMIT] | Headline |
|---|---|---|
| §A | `a6101d26` | Kill the `wiki` asset-type token: removed from `KNOWN_TYPES` (recognition-util), matchers, presentation, renderers. |
| §C / DEV-7 | `394d53ee` | First-class `llm-wiki` adapter `src/core/adapter/adapters/llm-wiki-adapter.ts` (+438 LOC) owning schema/index/log/raw/pages/xrefs/citations/ingest + validation; registered in `adapters/index.ts`; conformance + adapter tests (+224 LOC). |
| §B/§C | `453bc20d` | Delete the `wikiName` config special-case + the native wiki module: `src/wiki/wiki.ts` (−1182), `wiki-templates.ts`, `src/commands/wiki-cli.ts` (−327), `src/assets/wiki/*` templates; repoint show.ts read path, source-add, installed-stashes, indexer, search. |
| §D | `d54c32e9` | Rename `wiki-fetchers/ → snapshot-fetchers/` KEEPING youtube + website (§12.4 — they feed the knowledge path, not wiki); colocate `website-ingest`. |
| §D | `2b034072` | Retarget the dynamic-import lint baseline to the renamed `snapshot-fetchers` path. |
| §E | `eea8e782` | all-types wiki cascade — drop the retired wiki asset from goldens (recognition/placement/lint/renderer + DESIGNATIONS.json + the wiki fixture file). |
| — | `5ebf4605` | Retire the wiki placement spec + repoint residual wiki tests (schema, presentation, validate, file-context, legacy-layout). |
| — | `7c773a0c` | Repoint residual wiki-pinning integration tests + re-baseline the minting oracle golden. |

### Actuals (summed from the eight diffstats) [COMMIT]

| Commit | +ins | −del | files |
|---|---|---|---|
| `a6101d26` | 64 | 120 | 12 |
| `394d53ee` | 727 | 21 | 4 |
| `453bc20d` | 86 | 2181 | 25 |
| `d54c32e9` | 16 | 16 | 10 |
| `2b034072` | 1 | 1 | 1 |
| `eea8e782` | 19 | 59 | 10 |
| `5ebf4605` | 29 | 41 | 12 |
| `7c773a0c` | 11 | 29 | 7 |
| **TOTAL** | **953** | **2468** | **81 (file-touches)** |

**Net LOC = −1515.** Manifest target: `netLoc: "smaller than the prior −1300
(adapter retained, not deleted)"`. Landed −1515 is *larger* than the −1300 the
target phrases as an upper bound — the native wiki module (`wiki.ts` −1182 alone)
was heavier than the target framing assumed, only partly offset by the +727
`llm-wiki` adapter that was *added* rather than deleted. Directionally consistent
with the scope (retain the adapter, delete the type + native module).

## Deletion inventory (retired surfaces) [COMMIT]

- **Deleted files:** `src/wiki/wiki.ts` (−1182), `src/wiki/wiki-templates.ts`,
  `src/commands/wiki-cli.ts` (−327), `src/assets/wiki/{index,ingest-workflow,log,schema}-template.md`,
  `tests/commands/wiki-ingest-redaction.test.ts` (−54), the
  `tests/fixtures/.../all-types-wiki.md` golden fixture. Confirmed at HEAD
  [GREP@HEAD]: `ls src/wiki/` → *No such file or directory*; `ls src/assets/wiki/`
  → absent; `ls src/commands/wiki-cli.ts` → absent.
- **Retired config/type surface:** `wiki` asset-type token; `wikiName` config
  special-case (config-schema/config-sources/config-types + 5 call-sites);
  `SearchSource.wikiName`; `schemas/akm-config.json` wiki block (−20).
- **Renamed, NOT deleted (§12.4):** `wiki-fetchers/ → snapshot-fetchers/`, keeping
  `youtube.ts` (0-line rename) + `website.ts` + `website-ingest.ts`. Confirmed at
  HEAD [GREP@HEAD]: `ls src/sources/snapshot-fetchers/` → `registry.ts types.ts
  website-ingest.ts youtube.ts`; `ls src/sources/wiki-fetchers/` → absent.
- **Added (not deleted):** `src/core/adapter/adapters/llm-wiki-adapter.ts` (present
  at HEAD, 17,880 bytes) [GREP@HEAD].

## Gate results — verified at HEAD `e3eec904` on 2026-07-21 [GREP@HEAD]

| Manifest gate | Command run | Result |
|---|---|---|
| `grep wikiName → 0` | `grep -rn wikiName src/` | **0. PASS.** |
| wiki type token → 0 | `grep -rn '"wiki"' src/` | 1 hit, **in the frozen migrator** `src/migrate/legacy/legacy-layout.ts:144` (the `KNOWN_TYPES` migrator copy). 0 live. Corroborated by `recognition-util.ts` comment [GREP@HEAD]: "minus the retired `wiki` type (chunk 4)". **PASS** (outside migrator). |
| llm-wiki adapter conformance tests green | `bun test tests/core/adapter/llm-wiki-adapter.test.ts tests/core/adapter/conformance.test.ts` | **31 pass / 0 fail, 126 expect() calls, 414ms. PASS** (run 2026-07-21 at HEAD). |
| website/youtube snapshot fetchers renamed, not deleted (§12.4) | `ls src/sources/snapshot-fetchers/` | `registry.ts types.ts website-ingest.ts youtube.ts` present; `wiki-fetchers/` gone. **PASS.** |

## Deviations from manifest scope

- **Net LOC −1515 vs. target "smaller than −1300"** (see Actuals): the native
  wiki module was larger than the target framing; scope-vs-actuals deviation on
  the estimate only. Deletion set and adapter-retention match scope.
- **`show.ts` read-path collapse** (`453bc20d`, −141 lines in show.ts): the
  `show.ts:428-432` wiki read path named in manifest scope was removed as part of
  the native-module deletion, consistent with scope.
- **DEV-7 honored:** the LLM Wiki adapter is first-class, not folded into
  knowledge — commit `394d53ee` subject explicitly cites "chunk-4 §C, DEV-7", and
  the adapter owns schema/index/log/raw/pages/xrefs/citations/ingest per scope.

## Deferrals / downstream state

- **NO RECORD** of any chunk-4 deferral list. No commit body names a deferred item
  for this chunk.
- Downstream (CORRECTED by the 2026-07-21 adversarial verification — the
  draft misread the decision doc): `llm-wiki`'s D-R6 reserved-filename
  compliance SHIPPED IN THIS CHUNK (`isReservedRootFile` introduced in
  `394d53ee`, confirmed by `git log -S`). The decision doc §4 D-R6 defers the
  **akm adapter's** own exclusion — not llm-wiki's — to F4/Chunk-8, where it
  landed.

## NO RECORD (declared gaps — not reconstructable)

1. Contemporaneous **Opus dual-review verdicts** / review notes for any WI.
2. **Full `bun run check` at chunk-4 close** — no commit body self-reports it
   (unlike chunk 3's `a519462e`/`f8e48d90`). Batteries-at-close totals unknown.
3. **Mid-chunk gate-run logs**; whether goldens were re-baselined under review.
4. Any **escalation / re-scope** events.
5. The **DEV-7 decision record cross-check** — DEV-7 is cited in the commit
   subject but the deviation-analysis document's contemporaneous sign-off state at
   chunk-4 time is NO RECORD.
