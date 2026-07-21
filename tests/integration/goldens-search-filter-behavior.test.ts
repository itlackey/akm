// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Golden capture: proposed/belief/scope filter-behavior parity across BOTH
 * search code paths, `whyMatched`, and rank metrics (WI-0b.5, chunk-0b brief,
 * `docs/design/execution/chunk-0b/anchors.md` Section D — "Filter-behavior +
 * rank-metric surfaces").
 *
 * `src/indexer/search/db-search.ts` has two independently-duplicated filter
 * chains that are not yet unified (plan §4.3, Chunk-5-owned):
 *   - the SCORED path (`searchDatabase`, fn@:282) — reached by any query with
 *     searchable FTS tokens;
 *   - the ENUMERATE path (`enumerateEntries`, fn@:574) — reached by an empty/
 *     unsearchable query or a `<type>:` ref-prefix query.
 * Both apply the same source/scope/quality/belief filter chain in the same
 * order.
 *
 * CORRECTED FINDING (verified empirically against HEAD `cd25a769`, see the
 * ledger for detail): `docs/design/execution/chunk-0b/anchors.md` Section D.1
 * characterizes the two-path difference as "scored path lacks [the
 * `inheritDerivedTwinBeliefStates`] call". Direct testing against this
 * fixture shows that framing is imprecise — `searchDatabase` DOES call
 * `inheritDerivedTwinBeliefStates` (:459, before ranking), and because its
 * later filter chain (:513-530) derives from the SAME mutated array via
 * chained `.filter()` calls (which preserve object references, not copies),
 * the scored path's own belief filter sees the inherited state too. For a
 * `.derived` twin that IS an FTS/vector candidate for the query, BOTH paths
 * agree on filter membership under every belief mode — this fixture's
 * `base-memory`/`base-memory.derived` pair pins that PARITY case directly (no
 * divergence). The REAL, robust divergence is candidate-POOL membership, not
 * filter code: `searchDatabase`'s candidate pool comes from `searchFts`/
 * vector matches for the query's own tokens (FTS indexes description/tags/
 * searchHints/aliases — NOT raw markdown body prose, unless
 * `index.indexBodyOpening` is enabled, off by default); `enumerateEntries`'s
 * candidate pool is `getAllEntries` for the type, entirely independent of
 * query text. A `.derived` twin whose own indexed fields share NO token with
 * the query (`silent-twin-base`/`silent-twin-base.derived` in this fixture)
 * is therefore NEVER a scored-path candidate under any belief filter — never
 * even reaching `inheritDerivedTwinBeliefStates` — while the SAME twin,
 * reached via an empty-query enumerate, is ALWAYS a candidate and reliably
 * inherits its base's demoting belief state. This suite captures BOTH paths'
 * result sets across a representative set of proposed/belief/scope filter
 * combinations against a small purpose-built fixture
 * (`tests/fixtures/stashes/search-filter/`, see its MANIFEST.json) so BOTH
 * the parity case and the real divergence case are pinned in a reviewed
 * diff, not a silent behavior change, before Chunk 5 unifies the two filter
 * chains.
 *
 * Both search paths are driven exclusively through the PUBLIC `akmSearch`
 * entry point (`searchDatabase`/`enumerateEntries` are module-private and
 * capture-only work must not export them): a query with searchable FTS
 * tokens ("gridlock", present in every fixture asset) reaches the scored
 * path; an empty query reaches the enumerate path. Every call passes
 * `disableProjectContext`/`disableScopedUtility`/`skipLogging: true` and runs
 * against a `semanticSearchMode: "off"` config, so ranking is FTS5-BM25-only
 * over fixed fixture content with no CWD-, workflow-scope-, wall-clock-, or
 * usage-event-coupled inputs — deterministic byte-for-byte across runs
 * (verified by AKM_UPDATE_GOLDENS capture + a clean re-run producing an
 * empty diff).
 *
 * Also captures (WI-0b.5b) `buildWhyMatched`'s per-hit reasons alongside the
 * ranked hit set for one representative query, as the byte-level oracle
 * Chunk 5's consolidation of the parallel `buildWhyMatched`/
 * `metadataRankingContributor` scorers must reproduce (anchors D.2); and
 * (WI-0b.5c) a rank-metric snapshot via the canonical
 * `scripts/akm-eval/src/rank-metrics.ts` (NOT the removed `src/core/eval/*`,
 * anchors D.3) over one real-search-derived case and one hand-built synthetic
 * leapfrog case, both fed through the SAME pure scoring functions.
 *
 * Designation: `frozen-migration-input` (`DESIGNATIONS.json`) for all three
 * goldens this suite captures.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type CurateJudgment, scoreCurateCase, summarizeCurateMetrics } from "../../scripts/akm-eval/src/rank-metrics";
import { akmSearch } from "../../src/commands/read/search";
import { saveConfig } from "../../src/core/config/config";
import { akmIndex } from "../../src/indexer/indexer";
import type { StashEntryScope } from "../../src/indexer/passes/metadata";
import type { BeliefFilterMode, SourceSearchHit } from "../../src/sources/types";
import { expectGolden } from "../_helpers/golden";
import { type Cleanup, sandboxXdgCacheHome, sandboxXdgConfigHome, sandboxXdgDataHome } from "../_helpers/sandbox";
import { loadFixtureStash } from "../fixtures/stashes/load";

const SCORED_VS_ENUMERATE_GOLDEN_PATH = "tests/fixtures/goldens/filter-behavior/scored-vs-enumerate.json";
const WHY_MATCHED_GOLDEN_PATH = "tests/fixtures/goldens/filter-behavior/why-matched.json";
const RANK_METRICS_GOLDEN_PATH = "tests/fixtures/goldens/rank-metrics/search-filter.json";
const HEAD_SHA = "cd25a769443f4dbe566a418316b67e843ba1dbb9";

// The token every fixture asset's description/tags/body share (see
// tests/fixtures/stashes/search-filter/MANIFEST.json) — reaches the scored
// (FTS) path for every entry that survives the quality/belief/scope filters.
const FTS_QUERY = "gridlock";

// ── Fixture + index (built once; every test only reads it) ─────────────────

let FIXTURE_STASH: string;
let fixtureCleanup: (() => void) | undefined;
let fileDataHome = "";
let envCleanup: Cleanup = () => {};

beforeAll(async () => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const dataResult = sandboxXdgDataHome(cfgResult.cleanup);
  fileDataHome = dataResult.dir;
  envCleanup = dataResult.cleanup;

  const loaded = loadFixtureStash("search-filter", { skipIndex: true });
  FIXTURE_STASH = loaded.stashDir;
  fixtureCleanup = loaded.cleanup;

  process.env.AKM_STASH_DIR = FIXTURE_STASH;

  // semanticSearchMode: "off" — no embedding provider, no vector scores, so
  // rankingMode is always "fts" and the minScore floor never applies. This is
  // the determinism precondition documented in the file header.
  saveConfig({
    semanticSearchMode: "off",
    bundles: { stash: { path: FIXTURE_STASH } },
    defaultBundle: "stash",
    registries: [],
  });

  await akmIndex({ stashDir: FIXTURE_STASH, full: true });
});

beforeEach(() => {
  // Re-establish the env vars this file's pre-built index depends on — the
  // suite runs all files in one process sharing process.env, so a
  // concurrently-interleaved file's beforeEach could otherwise repoint
  // XDG_DATA_HOME/AKM_STASH_DIR mid-run (same guard as ranking-regression.test.ts).
  process.env.XDG_DATA_HOME = fileDataHome;
  process.env.AKM_STASH_DIR = FIXTURE_STASH;
});

afterAll(() => {
  envCleanup();
  envCleanup = () => {};
  if (process.env.AKM_STASH_DIR === FIXTURE_STASH) delete process.env.AKM_STASH_DIR;
  fixtureCleanup?.();
});

// ── Filter-combination matrix ───────────────────────────────────────────────

interface FilterCombo {
  id: string;
  description: string;
  includeProposed: boolean;
  belief: BeliefFilterMode;
  filters?: StashEntryScope;
}

const COMBOS: FilterCombo[] = [
  {
    id: "defaults",
    description: "includeProposed=false, belief=all, no scope filter (production default shape)",
    includeProposed: false,
    belief: "all",
  },
  {
    id: "includeProposedTrue",
    description: "includeProposed=true, belief=all, no scope filter",
    includeProposed: true,
    belief: "all",
  },
  {
    id: "beliefCurrent",
    description:
      "includeProposed=false, belief=current, no scope filter -- PINS BOTH the PARITY case (memory:" +
      "base-memory.derived, an FTS candidate for 'gridlock' on both paths, is INCLUDED on BOTH paths: its own " +
      "beliefState is undefined, but inheritDerivedTwinBeliefStates mutates it to base-memory's 'contradicted' " +
      "on BOTH paths before their respective belief filters, so it is actually EXCLUDED on both -- see the golden " +
      "for the verified byte-for-byte outcome) and the DIVERGENCE case (memory:silent-twin-base.derived, which " +
      "shares no FTS token with 'gridlock', is NEVER a scored-path candidate under this or any belief filter, but " +
      "IS an enumerate-path candidate and inherits silent-twin-base's 'contradicted' state, so it is likewise " +
      "excluded from 'current' there too -- membership under 'current' happens to agree for a different reason " +
      "than under 'historical'; see that combo for where the divergence becomes visible in SET MEMBERSHIP).",
    includeProposed: false,
    belief: "current",
  },
  {
    id: "beliefHistorical",
    description:
      "includeProposed=false, belief=historical, no scope filter -- PINS THE REAL ASYMMETRY: memory:" +
      "silent-twin-base.derived is INCLUDED on the enumerate path (unconditional candidate, inherits " +
      "silent-twin-base's 'contradicted' state, which passes 'historical') but ABSENT from the scored path's " +
      "result set entirely (never an FTS candidate for 'gridlock' -- not merely filtered out, never even " +
      "considered). memory:base-memory.derived, by contrast, is EXCLUDED from BOTH paths here (a PARITY case: " +
      "it IS an FTS candidate on the scored path too, so the same inheritance + filter outcome applies).",
    includeProposed: false,
    belief: "historical",
  },
  {
    id: "scopeUserAlice",
    description: "includeProposed=false, belief=all, filters={user: alice} -- scope-only narrowing, no asymmetry",
    includeProposed: false,
    belief: "all",
    filters: { user: "alice" },
  },
  {
    id: "scopeUserAliceIncludeProposed",
    description:
      "includeProposed=true, belief=all, filters={user: alice} -- scope narrowing plus the proposed-quality " +
      "opt-in, identical filter code on both paths (isProposedQuality/entryMatchesScope are the SAME functions " +
      "called from both searchDatabase and enumerateEntries), so no asymmetry expected here.",
    includeProposed: true,
    belief: "all",
    filters: { user: "alice" },
  },
  {
    id: "scopeAgentReviewerBot",
    description: "includeProposed=false, belief=all, filters={agent: reviewer-bot} -- scope-only narrowing",
    includeProposed: false,
    belief: "all",
    filters: { agent: "reviewer-bot" },
  },
  {
    id: "scopeUserBobHistoricalIncludeProposed",
    description:
      "includeProposed=true, belief=historical, filters={user: bob} -- combined scope+belief narrowing onto a " +
      "single non-memory (knowledge) entry; inheritDerivedTwinBeliefStates only ever touches type==='memory' " +
      "entries, so this combo is expected to be IDENTICAL across both paths (a contrast case to the two belief " +
      "combos above).",
    includeProposed: true,
    belief: "historical",
    filters: { user: "bob" },
  },
];

/** Project a hit down to the fields that distinguish filter outcomes. */
function projectHit(hit: SourceSearchHit): Record<string, unknown> {
  const out: Record<string, unknown> = { ref: hit.ref, type: hit.type, name: hit.name, score: hit.score };
  if (hit.quality !== undefined) out.quality = hit.quality;
  if (hit.beliefState !== undefined) out.beliefState = hit.beliefState;
  return out;
}

async function runScored(combo: FilterCombo): Promise<SourceSearchHit[]> {
  const result = await akmSearch({
    query: FTS_QUERY,
    type: "any",
    source: "stash",
    limit: 50,
    includeProposed: combo.includeProposed,
    belief: combo.belief,
    filters: combo.filters,
    disableProjectContext: true,
    disableScopedUtility: true,
    skipLogging: true,
  });
  return result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
}

async function runEnumerate(combo: FilterCombo): Promise<SourceSearchHit[]> {
  const result = await akmSearch({
    query: "",
    type: "any",
    source: "stash",
    limit: 50,
    includeProposed: combo.includeProposed,
    belief: combo.belief,
    filters: combo.filters,
    disableProjectContext: true,
    disableScopedUtility: true,
    skipLogging: true,
  });
  return result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
}

// ── 1. Pre-capture sanity: parity case + the real divergence, asserted directly

describe("WI-0b.5a: derived-twin belief inheritance -- parity case (base-memory pair)", () => {
  test("belief=historical: base-memory.derived (an FTS candidate) is excluded on BOTH paths", async () => {
    const combo = COMBOS.find((c) => c.id === "beliefHistorical");
    if (!combo) throw new Error("unreachable: beliefHistorical combo must exist");
    const scored = await runScored(combo);
    const enumerated = await runEnumerate(combo);

    // 'historical' keeps contradicted/superseded/deprecated/archived. The
    // twin inherits base-memory's 'contradicted' state on BOTH paths (it IS
    // an FTS candidate for 'gridlock' on the scored path too), so it PASSES
    // 'historical' and is present on both -- no divergence for this pair.
    expect(scored.some((h) => h.ref === "memories/base-memory.derived")).toBe(true);
    expect(enumerated.some((h) => h.ref === "memories/base-memory.derived")).toBe(true);
    const scoredTwin = scored.find((h) => h.ref === "memories/base-memory.derived");
    const enumeratedTwin = enumerated.find((h) => h.ref === "memories/base-memory.derived");
    expect(scoredTwin?.beliefState).toBe("contradicted");
    expect(enumeratedTwin?.beliefState).toBe("contradicted");
  });

  test("belief=current: base-memory.derived (an FTS candidate) is excluded on BOTH paths", async () => {
    const combo = COMBOS.find((c) => c.id === "beliefCurrent");
    if (!combo) throw new Error("unreachable: beliefCurrent combo must exist");
    const scored = await runScored(combo);
    const enumerated = await runEnumerate(combo);

    // Inherited 'contradicted' fails 'current' on BOTH paths -- no asymmetry
    // for a twin that IS a candidate on both paths.
    expect(scored.some((h) => h.ref === "memories/base-memory.derived")).toBe(false);
    expect(enumerated.some((h) => h.ref === "memories/base-memory.derived")).toBe(false);
  });
});

describe("WI-0b.5a: derived-twin belief inheritance -- the REAL two-path divergence (silent-twin-base pair)", () => {
  test("belief=historical: silent-twin-base.derived is INCLUDED via enumerate, ABSENT from scored (never a candidate)", async () => {
    const combo = COMBOS.find((c) => c.id === "beliefHistorical");
    if (!combo) throw new Error("unreachable: beliefHistorical combo must exist");
    const scored = await runScored(combo);
    const enumerated = await runEnumerate(combo);

    expect(scored.some((h) => h.ref === "memories/silent-twin-base.derived")).toBe(false);
    expect(enumerated.some((h) => h.ref === "memories/silent-twin-base.derived")).toBe(true);
    const enumeratedTwin = enumerated.find((h) => h.ref === "memories/silent-twin-base.derived");
    expect(enumeratedTwin?.beliefState).toBe("contradicted");
  });

  test("belief=all: silent-twin-base.derived is present via enumerate, ABSENT from scored even with no belief narrowing", async () => {
    const combo = COMBOS.find((c) => c.id === "defaults");
    if (!combo) throw new Error("unreachable: defaults combo must exist");
    const scored = await runScored(combo);
    const enumerated = await runEnumerate(combo);

    // belief=all applies no belief narrowing at all -- the twin's total
    // absence from the scored result set here proves the divergence is about
    // candidate-pool construction (FTS token match), not belief filtering.
    expect(scored.some((h) => h.ref === "memories/silent-twin-base.derived")).toBe(false);
    expect(enumerated.some((h) => h.ref === "memories/silent-twin-base.derived")).toBe(true);
  });

  test("a duskfall-token query DOES surface silent-twin-base.derived on the scored path too (confirms it's token-gated, not structurally excluded)", async () => {
    const result = await akmSearch({
      query: "duskfall",
      type: "any",
      source: "stash",
      limit: 50,
      belief: "all",
      disableProjectContext: true,
      disableScopedUtility: true,
      skipLogging: true,
    });
    const hits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    expect(hits.some((h) => h.ref === "memories/silent-twin-base.derived")).toBe(true);
    const hit = hits.find((h) => h.ref === "memories/silent-twin-base.derived");
    // Inheritance still applies once it IS a candidate.
    expect(hit?.beliefState).toBe("contradicted");
  });
});

describe("WI-0b.5a: scope+belief contrast case (non-memory entry, never inheritance-eligible)", () => {
  test("scopeUserBobHistoricalIncludeProposed: identical single-hit result on both paths", async () => {
    const combo = COMBOS.find((c) => c.id === "scopeUserBobHistoricalIncludeProposed");
    if (!combo) throw new Error("unreachable: scopeUserBobHistoricalIncludeProposed combo must exist");
    const scored = await runScored(combo);
    const enumerated = await runEnumerate(combo);

    expect(scored.map((h) => h.ref)).toEqual(["knowledge/contradicted-knowledge"]);
    expect(enumerated.map((h) => h.ref)).toEqual(["knowledge/contradicted-knowledge"]);
  });
});

// ── 2. Golden fixture captures ──────────────────────────────────────────────

describe("golden fixture: filter-behavior/scored-vs-enumerate.json (WI-0b.5a)", () => {
  test("golden fixture: scored-vs-enumerate.json", async () => {
    const combos: Record<string, unknown> = {};
    for (const combo of COMBOS) {
      const scored = await runScored(combo);
      const enumerated = await runEnumerate(combo);
      combos[combo.id] = {
        description: combo.description,
        params: {
          includeProposed: combo.includeProposed,
          belief: combo.belief,
          filters: combo.filters ?? null,
        },
        scored: { hits: scored.map(projectHit) },
        enumerate: { hits: enumerated.map(projectHit) },
      };
    }

    expectGolden(SCORED_VS_ENUMERATE_GOLDEN_PATH, {
      scenario:
        "searchDatabase (scored path, query='gridlock') vs enumerateEntries (enumerate path, query='') result " +
        "sets across proposed/belief/scope filter combinations, against tests/fixtures/stashes/search-filter/ " +
        "(WI-0b.5a)",
      capturedAtHead: HEAD_SHA,
      notes: [
        "Both paths driven exclusively through the public akmSearch entry point -- searchDatabase/enumerateEntries " +
          "are module-private in src/indexer/search/db-search.ts and this suite is capture-only (no src/ changes, " +
          "no new exports). The scored path is reached by a query with searchable FTS tokens ('gridlock', shared " +
          "by every fixture asset); the enumerate path by an empty query. Both requests in a combo pass identical " +
          "includeProposed/belief/filters plus disableProjectContext/disableScopedUtility/skipLogging=true so the " +
          "only variable between the 'scored' and 'enumerate' halves of an entry is which internal path ran.",
        "CORRECTED FINDING vs anchors.md Section D.1 (verified empirically, see this file's header comment and the " +
          "ledger): anchors.md characterizes the asymmetry as 'scored path lacks the inheritDerivedTwinBeliefStates " +
          "call'. Direct testing shows searchDatabase DOES call it (db-search.ts:459, before ranking), and because " +
          "its filter chain (:513-530) derives from the SAME mutated array via chained .filter() calls, the scored " +
          "path's own belief filter sees the inherited state too. memory:base-memory.derived (an FTS candidate for " +
          "'gridlock' on both paths, since it shares the 'gridlock' tag with its base) is therefore a PARITY case: " +
          "identical membership on both paths under every belief mode in this golden (see the 'beliefCurrent'/" +
          "'beliefHistorical' combos).",
        "FROZEN two-path asymmetry (the REAL mechanism, replacing anchors.md D.1's framing): the divergence is " +
          "candidate-POOL membership, not filter code. searchDatabase's candidate pool is built from searchFts/" +
          "vector matches for the query's own tokens; enumerateEntries's candidate pool is getAllEntries for the " +
          "type, independent of query text. memory:silent-twin-base.derived shares NO indexed token with 'gridlock' " +
          "(FTS indexes description/tags/searchHints/aliases, not body prose), so it is NEVER a scored-path " +
          "candidate for this query under ANY belief filter (visible in every combo's 'scored' half below as a " +
          "total absence) while it is ALWAYS an enumerate-path candidate and reliably inherits silent-twin-base's " +
          "'contradicted' state (present under belief=all/historical, absent under belief=current in the " +
          "'enumerate' half). Chunk 5's unification of the two filter chains must treat this diff as a reviewed " +
          "behavior change, not reproduce it silently.",
        "The 'scopeUserBobHistoricalIncludeProposed' combo is a deliberate CONTRAST case: scope+quality filtering " +
          "(entryMatchesScope/isProposedQuality) is literally the same function call on both paths, and the sole " +
          "matching entry (knowledge:contradicted-knowledge) is not a memory, so it is never eligible for " +
          "inheritDerivedTwinBeliefStates -- both paths' hit lists are identical here, isolating the divergence " +
          "above to the derived-twin candidate-pool-construction difference, not a general scored/enumerate split.",
        "Each hit is projected to {ref, type, name, score, quality?, beliefState?} -- the fields that distinguish " +
          "filter outcomes. Scored-path scores vary with FTS5 BM25 + ranking boosts; enumerate-path scores are " +
          "always the fixed browse score 1 (enumerateEntries never scores, db-search.ts:644).",
        "FROZEN behavior-parity oracle (D0b-1/D0b-3, same designation-reuse rationale as this registry's WI-0b.3/" +
          "WI-0b.4 entries): Chunk 5's filter-path unification must reproduce this byte-for-byte or land an " +
          "explicit re-baseline in the same reviewed change.",
      ],
      combos,
    });
  });
});

describe("golden fixture: filter-behavior/why-matched.json (WI-0b.5b)", () => {
  test("golden fixture: why-matched.json", async () => {
    const result = await akmSearch({
      query: FTS_QUERY,
      type: "any",
      source: "stash",
      limit: 50,
      includeProposed: false,
      belief: "all",
      disableProjectContext: true,
      disableScopedUtility: true,
      skipLogging: true,
    });
    const hits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    expect(hits.length).toBeGreaterThan(0);

    const byRef: Record<string, unknown> = {};
    for (const hit of hits) {
      byRef[hit.ref] = {
        name: hit.name,
        type: hit.type,
        score: hit.score,
        whyMatched: hit.whyMatched,
        ...(hit.quality !== undefined ? { quality: hit.quality } : {}),
        ...(hit.beliefState !== undefined ? { beliefState: hit.beliefState } : {}),
      };
    }

    expectGolden(WHY_MATCHED_GOLDEN_PATH, {
      scenario:
        "buildWhyMatched output (db-search.ts:837) alongside the ranked hit set for query='gridlock' against " +
        "tests/fixtures/stashes/search-filter/, default filters (includeProposed=false, belief=all) (WI-0b.5b)",
      capturedAtHead: HEAD_SHA,
      notes: [
        "buildWhyMatched is called once per hit from buildDbHit (:784). Per anchors.md Section D.2 (§14.2 finding " +
          "A2, Chunk-5-owned), it re-scans matches and recomputes boost constants that duplicate " +
          "metadataRankingContributor (ranking-contributors.ts:288) -- a drift-prone parallel scorer. This golden " +
          "is the byte-level oracle a future consolidation must reproduce.",
        "memory:active-memory is this fixture's richest signal case (see MANIFEST.json): curated quality, active " +
          "belief state, and tags/searchHints/aliases/description all sharing the query token 'gridlock', so its " +
          "whyMatched array exercises nearly every reason branch in one hit (fts ranking mode, matched name " +
          "tokens/tags/searchHints/aliases/description, curated metadata boost, metadata confidence boost, active " +
          "belief state) except the skill/command/agent type boost and the utility/graph boosts (this fixture has " +
          "no usage history and no graph.json).",
        "rankedRefOrder is the scored-path (searchDatabase) ordering; byRef is keyed by ref (not array order) so " +
          "a future diff against this fixture reads per-entry, not by fragile array index.",
        "FROZEN behavior-parity oracle (D0b-1/D0b-3): Chunk 5's consolidation of buildWhyMatched with " +
          "metadataRankingContributor must reproduce this byte-for-byte.",
      ],
      query: FTS_QUERY,
      rankedRefOrder: hits.map((h) => h.ref),
      byRef,
    });
  });
});

describe("golden fixture: rank-metrics/search-filter.json (WI-0b.5c)", () => {
  test("golden fixture: rank-metrics/search-filter.json", async () => {
    // Case A: a REAL search result (deterministic per the file-header
    // preconditions) scored against a hand-authored judgment.
    const result = await akmSearch({
      query: FTS_QUERY,
      type: "any",
      source: "stash",
      limit: 50,
      includeProposed: true,
      belief: "all",
      disableProjectContext: true,
      disableScopedUtility: true,
      skipLogging: true,
    });
    const hits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    const returnedA = hits.map((h) => h.ref);

    const judgmentA: CurateJudgment = {
      id: "search-filter-case-a-real-search",
      query: FTS_QUERY,
      relevant: ["memories/active-memory", "memories/asserted-memory"],
      idealOrder: ["memories/active-memory", "memories/asserted-memory"],
      banned: ["memories/archived-memory", "memories/base-memory"],
      limit: 10,
    };
    const metricsA = scoreCurateCase(returnedA, judgmentA);

    // Case B: a hand-built synthetic ranking with a DELIBERATE leapfrog (a
    // banned ref ranked above both relevant refs) -- no search involved, so
    // this half needs no determinism argument at all; it exists to prove
    // noBannedAboveRequired/bannedLeapfrogCount differentiate a bad ranking
    // from case A's real one, regardless of what case A's real order turns
    // out to be.
    const judgmentB: CurateJudgment = {
      id: "search-filter-case-b-synthetic-leapfrog",
      query: "synthetic-leapfrog",
      relevant: ["memories/active-memory", "memories/asserted-memory"],
      idealOrder: ["memories/active-memory", "memories/asserted-memory"],
      banned: ["memories/archived-memory"],
      limit: 5,
    };
    const returnedB = [
      "memories/archived-memory",
      "memories/plain-memory",
      "memories/active-memory",
      "memories/asserted-memory",
    ];
    const metricsB = scoreCurateCase(returnedB, judgmentB);

    const summary = summarizeCurateMetrics([metricsA, metricsB]);

    expectGolden(RANK_METRICS_GOLDEN_PATH, {
      scenario:
        "Rank-metric snapshot via scripts/akm-eval/src/rank-metrics.ts's scoreCurateCase/summarizeCurateMetrics " +
        "(ndcgAtK/recallAtK/mrr/noBannedAboveRequired) over one real-search-derived case and one hand-built " +
        "synthetic leapfrog case (WI-0b.5c)",
      capturedAtHead: HEAD_SHA,
      determinism: [
        "scoreCurateCase/summarizeCurateMetrics (scripts/akm-eval/src/rank-metrics.ts) are PURE functions over " +
          "string[] refs and a CurateJudgment -- no IO, no clock, no RNG -- so both cases are byte-stable given " +
          "fixed inputs.",
        "Case A's 'returned' list comes from a real akmSearch call, made deterministic by: " +
          "semanticSearchMode='off' (no embedding provider, no vector scores, rankingMode is always 'fts', the " +
          "minScore floor never applies); disableProjectContext=true (no CWD-derived token boost); " +
          "disableScopedUtility=true (no workflow-scope-keyed utility lookup); skipLogging=true (no usage-event " +
          "write feeding back into utility scores); no improve.utilityDecay configured (the only Date.now() call " +
          "in the ranking pipeline, ranking-contributors.ts:406, is gated behind that opt-in and never executes " +
          "here); and no graph.json in the fixture (graphContext is always null). FTS5 BM25 over fixed, committed " +
          "fixture content is itself deterministic, and searchDatabase's final sort has an explicit name " +
          "tiebreaker (db-search.ts:500) precisely so no residual floating-point epsilon can flip result order " +
          "run-to-run (Issue #14, cited in that file).",
        "Case B's 'returned' list is a literal hand-authored array (no search call at all) -- included as a " +
          "leapfrog-violation contrast so this golden differentiates a good ranking from a bad one regardless of " +
          "what case A's real search order turns out to be.",
      ],
      caseA: { judgment: judgmentA, returned: returnedA, metrics: metricsA },
      caseB: { judgment: judgmentB, returned: returnedB, metrics: metricsB },
      summary,
    });
  });
});
