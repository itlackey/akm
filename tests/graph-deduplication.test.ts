/**
 * Unit tests for `deduplicateGraph` (#207 graph deduplication).
 *
 * These tests are intentionally pure — no file I/O, no LLM calls.
 * They exercise `deduplicateGraph` as a standalone function so the
 * deduplication logic can be verified without the indexer pipeline.
 *
 * Covered scenarios:
 *   (a) Two assets with the same entity → one entity in the output.
 *   (b) Casing variants ("Docker" and "docker") → one canonical entity
 *       (first-seen casing preserved).
 *   (c) Duplicate relation → one relation in the output.
 *   (d) Dangling relation (endpoint not in entity set) → dropped.
 *   (e) Source provenance is recorded per-entity and per-relation.
 *   (f) Empty input → empty output.
 *   (g) Relations between identical (same-normalised) from/to are kept once.
 */

import { describe, expect, test } from "bun:test";
import type { GraphExtraction } from "../src/indexer/graph-dedup";
import { deduplicateGraph } from "../src/indexer/graph-dedup";

describe("deduplicateGraph", () => {
  // ── (a) Same entity across two assets → one entity ─────────────────────────
  test("(a) two assets with the same entity produce one entity in the output", () => {
    const extractions: GraphExtraction[] = [
      { entities: ["Docker"], relations: [] },
      { entities: ["Docker"], relations: [] },
    ];
    const result = deduplicateGraph(extractions, ["asset:a", "asset:b"]);

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]).toBe("Docker");
  });

  // ── (b) Casing variants → canonical first-seen casing ──────────────────────
  test("(b) casing variants collapse to the first-seen canonical form", () => {
    const extractions: GraphExtraction[] = [
      { entities: ["Docker"], relations: [] },
      { entities: ["docker"], relations: [] },
      { entities: ["DOCKER"], relations: [] },
    ];
    const result = deduplicateGraph(extractions, ["asset:a", "asset:b", "asset:c"]);

    expect(result.entities).toHaveLength(1);
    // First-seen casing ("Docker") must be preserved.
    expect(result.entities[0]).toBe("Docker");
  });

  // ── (c) Duplicate relation → one relation ──────────────────────────────────
  test("(c) duplicate relation across assets produces one relation in the output", () => {
    const extractions: GraphExtraction[] = [
      {
        entities: ["akm", "sqlite"],
        relations: [{ from: "akm", to: "sqlite", type: "uses" }],
      },
      {
        entities: ["akm", "sqlite"],
        relations: [{ from: "akm", to: "sqlite", type: "uses" }],
      },
    ];
    const result = deduplicateGraph(extractions, ["asset:a", "asset:b"]);

    expect(result.relations).toHaveLength(1);
    expect(result.relations[0]).toMatchObject({ from: "akm", to: "sqlite", type: "uses" });
  });

  // ── (d) Dangling relation → dropped ────────────────────────────────────────
  test("(d) a dangling relation whose endpoint is absent from the entity set is dropped", () => {
    const extractions: GraphExtraction[] = [
      {
        // Only "akm" is in the entity list; "postgres" is mentioned in a
        // relation but never declared as an entity → dangling.
        entities: ["akm"],
        relations: [{ from: "akm", to: "postgres", type: "uses" }],
      },
    ];
    const result = deduplicateGraph(extractions, ["asset:a"]);

    // The entity "akm" survives; the dangling relation is dropped.
    expect(result.entities).toHaveLength(1);
    expect(result.relations).toHaveLength(0);
  });

  // ── (e) Source provenance ───────────────────────────────────────────────────
  test("(e) entitySources records all contributing asset refs for a shared entity", () => {
    const extractions: GraphExtraction[] = [
      { entities: ["Docker"], relations: [] },
      { entities: ["docker"], relations: [] },
    ];
    const result = deduplicateGraph(extractions, ["asset:first", "asset:second"]);

    const sources = result.entitySources.get("docker");
    expect(sources).toBeDefined();
    expect(sources).toContain("asset:first");
    expect(sources).toContain("asset:second");
  });

  test("(e) relationSources records all contributing asset refs for a shared relation", () => {
    const extractions: GraphExtraction[] = [
      {
        entities: ["akm", "sqlite"],
        relations: [{ from: "akm", to: "sqlite", type: "uses" }],
      },
      {
        entities: ["akm", "sqlite"],
        relations: [{ from: "akm", to: "sqlite", type: "uses" }],
      },
    ];
    const result = deduplicateGraph(extractions, ["asset:x", "asset:y"]);

    // The relation key is "akm\0sqlite\0uses".
    const sources = result.relationSources.get("akm\0sqlite\0uses");
    expect(sources).toBeDefined();
    expect(sources).toContain("asset:x");
    expect(sources).toContain("asset:y");
  });

  // ── (f) Empty input ─────────────────────────────────────────────────────────
  test("(f) empty extractions list returns an empty graph", () => {
    const result = deduplicateGraph([]);
    expect(result.entities).toHaveLength(0);
    expect(result.relations).toHaveLength(0);
    expect(result.entitySources.size).toBe(0);
    expect(result.relationSources.size).toBe(0);
  });

  // ── Canonical casing on deduplicated relations ──────────────────────────────
  test("relation endpoints use canonical entity casing even when the relation used a different case", () => {
    const extractions: GraphExtraction[] = [
      // First asset defines canonical casing "ServiceA" and "ServiceB".
      {
        entities: ["ServiceA", "ServiceB"],
        relations: [{ from: "ServiceA", to: "ServiceB", type: "calls" }],
      },
      // Second asset uses lowercase variants in its relation; they should
      // still resolve to the canonical casing.
      {
        entities: ["servicea", "serviceb"],
        relations: [{ from: "servicea", to: "serviceb", type: "calls" }],
      },
    ];
    const result = deduplicateGraph(extractions, ["asset:p", "asset:q"]);

    expect(result.entities).toHaveLength(2);
    expect(result.relations).toHaveLength(1);
    // The surviving relation must use canonical casing.
    expect(result.relations[0].from).toBe("ServiceA");
    expect(result.relations[0].to).toBe("ServiceB");
  });

  // ── Multiple distinct entities and relations all survive ────────────────────
  test("distinct entities and relations from different assets are all preserved", () => {
    const extractions: GraphExtraction[] = [
      {
        entities: ["Alpha", "Beta"],
        relations: [{ from: "Alpha", to: "Beta", type: "uses" }],
      },
      {
        entities: ["Gamma", "Delta"],
        relations: [{ from: "Gamma", to: "Delta", type: "depends on" }],
      },
    ];
    const result = deduplicateGraph(extractions, ["asset:1", "asset:2"]);

    expect(result.entities).toHaveLength(4);
    expect(result.relations).toHaveLength(2);
  });

  // ── Missing assetRefs defaults to "unknown" ─────────────────────────────────
  test("missing assetRefs defaults provenance to 'unknown'", () => {
    const extractions: GraphExtraction[] = [{ entities: ["Node"], relations: [] }];
    // No assetRefs argument.
    const result = deduplicateGraph(extractions);

    const sources = result.entitySources.get("node");
    expect(sources).toEqual(["unknown"]);
  });

  test("relation type hygiene normalizes common verb-phrase variants", () => {
    const extractions: GraphExtraction[] = [
      {
        entities: ["ServiceA", "ServiceB"],
        relations: [
          { from: "ServiceA", to: "ServiceB", type: "use" },
          { from: "ServiceA", to: "ServiceB", type: "uses" },
          { from: "ServiceA", to: "ServiceB", type: "utilizes" },
        ],
      },
    ];
    const result = deduplicateGraph(extractions, ["asset:t"]);

    expect(result.relations).toHaveLength(1);
    expect(result.relations[0]?.type).toBe("uses");
  });

  test("relation confidence keeps the highest score for duplicates", () => {
    const extractions: GraphExtraction[] = [
      {
        entities: ["ServiceA", "ServiceB"],
        relations: [{ from: "ServiceA", to: "ServiceB", type: "uses", confidence: 0.4 }],
      },
      {
        entities: ["ServiceA", "ServiceB"],
        relations: [{ from: "ServiceA", to: "ServiceB", type: "use", confidence: 0.8 }],
      },
    ];

    const result = deduplicateGraph(extractions, ["asset:1", "asset:2"]);
    expect(result.relations).toHaveLength(1);
    expect(result.relations[0]?.confidence).toBe(0.8);
    expect(result.relations[0]?.type).toBe("uses");
  });
});
