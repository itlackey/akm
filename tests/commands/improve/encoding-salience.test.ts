// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unit tests for encoding-salience.ts (issue #608).
 *
 * All tests are pure-function — no I/O, no DB, no spawned processes.
 */

import { describe, expect, test } from "bun:test";
import { buildRefVocabulary, scoreEncodingSalience } from "../../../src/commands/improve/encoding-salience";

// ── novelty-only ────────────────────────────────────────────────────────────

describe("scoreEncodingSalience — novelty", () => {
  test("all-novel bigrams, no magnitude keywords, new asset → score > 0.60", () => {
    // Body uses unique words not in the vocabulary; no magnitude keywords.
    const body = "This completely unique content describes exotic zebra migration patterns in southern hemisphere";
    const result = scoreEncodingSalience({
      body,
      type: "lesson",
      existingRefVocabulary: new Set(),
      revisionCount: 0,
    });
    // revisionCount=0 → predictionError=1.0; novelty should be high (floor 0.5, all novel)
    expect(result.score).toBeGreaterThan(0.6);
    expect(result.novelty).toBeGreaterThanOrEqual(0.5);
    expect(result.predictionError).toBe(1.0);
  });

  test("skill/agent type gets novelty floor of 0.8", () => {
    // Even with all bigrams in vocab, skill floor is 0.8
    const body = "foo bar";
    const vocab = buildRefVocabulary(["foo bar", "foo", "bar"]);
    const result = scoreEncodingSalience({
      body,
      type: "skill",
      existingRefVocabulary: vocab,
      revisionCount: 0,
    });
    expect(result.novelty).toBeGreaterThanOrEqual(0.8);
  });

  test("memory type gets novelty floor of 0.4", () => {
    const body = "foo bar baz";
    const vocab = buildRefVocabulary(["foo bar", "bar baz", "foo", "bar", "baz"]);
    const result = scoreEncodingSalience({
      body,
      type: "memory",
      existingRefVocabulary: vocab,
      revisionCount: 5,
    });
    // memory floor is 0.4; with all bigrams in vocab, novelty = max(0.4, 0) = 0.4
    expect(result.novelty).toBeGreaterThanOrEqual(0.4);
  });
});

// ── magnitude-only ──────────────────────────────────────────────────────────

describe("scoreEncodingSalience — magnitude", () => {
  test("keywords from both severity+constraint buckets, no novel bigrams, revisionCount=5 → score > 0.30", () => {
    // All bigrams are in vocab; magnitude keywords drive the score.
    // Use 5+ keywords from both buckets.
    const body = "error critical warning must never blocked";
    // Build vocab from exact bigrams in the body so novelty fraction = 0
    const vocab = buildRefVocabulary([
      "error critical",
      "critical warning",
      "warning must",
      "must never",
      "never blocked",
    ]);
    const result = scoreEncodingSalience({
      body,
      type: "lesson",
      existingRefVocabulary: vocab,
      revisionCount: 5,
    });
    expect(result.score).toBeGreaterThan(0.3);
    expect(result.magnitude).toBeGreaterThan(0);
  });

  test("single-bucket magnitude cap: 4 severity words, no constraint words → magnitude ≤ 0.5", () => {
    const body = "error critical warning incident regression";
    const result = scoreEncodingSalience({
      body,
      type: "lesson",
      existingRefVocabulary: new Set(),
      revisionCount: 10,
    });
    // Only severity bucket matched → magnitude capped at 0.5
    expect(result.magnitude).toBeLessThanOrEqual(0.5);
  });

  test("dual-bucket produces higher magnitude than single-bucket (same keyword count)", () => {
    const singleBucket = scoreEncodingSalience({
      body: "error critical warning incident regression",
      type: "lesson",
      existingRefVocabulary: new Set(),
      revisionCount: 10,
    });
    const dualBucket = scoreEncodingSalience({
      body: "error critical warning must never",
      type: "lesson",
      existingRefVocabulary: new Set(),
      revisionCount: 10,
    });
    expect(dualBucket.magnitude).toBeGreaterThan(singleBucket.magnitude);
  });

  test("0 magnitude keywords → magnitude = 0", () => {
    const body = "the quick brown fox jumps over the lazy dog";
    const result = scoreEncodingSalience({
      body,
      type: "knowledge",
      existingRefVocabulary: new Set(),
      revisionCount: 0,
    });
    expect(result.magnitude).toBe(0);
  });

  test("4+ distinct keywords from both buckets → magnitude = 1.0", () => {
    const body = "error critical must never always blocked deprecated warning";
    const result = scoreEncodingSalience({
      body,
      type: "lesson",
      existingRefVocabulary: new Set(),
      revisionCount: 0,
    });
    // 4+ distinct matches from both buckets → magnitude = min(1.0, 8/4) = 1.0
    expect(result.magnitude).toBe(1.0);
  });
});

// ── combined scoring ────────────────────────────────────────────────────────

describe("scoreEncodingSalience — combined scoring", () => {
  test("novel body + high magnitude + new asset (revisionCount=0) → score ≥ 0.75", () => {
    const body =
      "critical security incident: auth token error detected must fix never deploy broken blocking regression";
    const result = scoreEncodingSalience({
      body,
      type: "lesson",
      existingRefVocabulary: new Set(), // all novel
      revisionCount: 0,
    });
    expect(result.score).toBeGreaterThanOrEqual(0.75);
  });

  test("score is always in [0, 1]", () => {
    const cases = [
      { body: "", type: "lesson", vocab: new Set<string>(), rev: 0 },
      { body: "error critical must never blocked", type: "skill", vocab: new Set<string>(), rev: 0 },
      { body: "ordinary content without keywords", type: "memory", vocab: new Set<string>(), rev: 100 },
    ];
    for (const c of cases) {
      const result = scoreEncodingSalience({
        body: c.body,
        type: c.type,
        existingRefVocabulary: c.vocab,
        revisionCount: c.rev,
      });
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
    }
  });
});

// ── threshold boundary behaviour (pure arithmetic) ───────────────────────────
// These tests exercise the SCORE produced by scoreEncodingSalience.
// The actual admission gate that reads encoding_salience from state.db and
// admits zero-feedback refs is in improve.ts; wiring tests live in
// tests/commands/improve/salience-wiring.test.ts.

describe("scoreEncodingSalience — threshold boundary scores", () => {
  test("high-magnitude + high-novelty body scores above default threshold (0.75)", () => {
    // Use a body with multiple severity + constraint keywords to drive magnitude up,
    // and a large ref vocabulary that differs from the body to keep novelty high.
    const vocab = buildRefVocabulary(["completely-unrelated-topic", "unrelated-other"]);
    const body =
      "This skill must never be called when a critical error or regression is blocked. " +
      "It is always required to handle deprecated endpoints correctly.";
    const result = scoreEncodingSalience({ body, type: "skill", existingRefVocabulary: vocab, revisionCount: 0 });
    expect(result.score).toBeGreaterThanOrEqual(0.75);
  });

  test("new asset with minimal content scores above 0 (predictionError alone contributes 0.25)", () => {
    const result = scoreEncodingSalience({
      body: "Short note.",
      type: "memory",
      existingRefVocabulary: new Set(),
      revisionCount: 0,
    });
    // predictionError = 1.0 → contributes 0.25; novelty floor for memory = 0.4 → contributes 0.16
    expect(result.score).toBeGreaterThan(0.2);
  });
});

// ── revision decay (predictionError) ────────────────────────────────────────

describe("scoreEncodingSalience — predictionError / revision decay", () => {
  test("revisionCount=0 → predictionError = 1.0", () => {
    const result = scoreEncodingSalience({
      body: "any content",
      type: "lesson",
      existingRefVocabulary: new Set(),
      revisionCount: 0,
    });
    expect(result.predictionError).toBe(1.0);
  });

  test("revisionCount=1 → predictionError ≈ 0.59", () => {
    const result = scoreEncodingSalience({
      body: "any content",
      type: "lesson",
      existingRefVocabulary: new Set(),
      revisionCount: 1,
    });
    const expected = 1 / (1 + Math.log(1 + 1));
    expect(result.predictionError).toBeCloseTo(expected, 6);
  });

  test("revisionCount=10 → predictionError ≈ 0.38", () => {
    const result = scoreEncodingSalience({
      body: "any content",
      type: "lesson",
      existingRefVocabulary: new Set(),
      revisionCount: 10,
    });
    const expected = 1 / (1 + Math.log(1 + 10));
    expect(result.predictionError).toBeCloseTo(expected, 6);
    expect(result.predictionError).toBeLessThan(0.5);
  });

  test("higher revisionCount → lower predictionError (monotone decay)", () => {
    const body = "same content every time";
    const r0 = scoreEncodingSalience({
      body,
      type: "lesson",
      existingRefVocabulary: new Set(),
      revisionCount: 0,
    });
    const r1 = scoreEncodingSalience({
      body,
      type: "lesson",
      existingRefVocabulary: new Set(),
      revisionCount: 1,
    });
    const r10 = scoreEncodingSalience({
      body,
      type: "lesson",
      existingRefVocabulary: new Set(),
      revisionCount: 10,
    });
    expect(r0.predictionError).toBeGreaterThan(r1.predictionError);
    expect(r1.predictionError).toBeGreaterThan(r10.predictionError);
  });

  test("same body: revisionCount=0 produces higher overall score than revisionCount=10", () => {
    const body = "ordinary content";
    const fresh = scoreEncodingSalience({
      body,
      type: "lesson",
      existingRefVocabulary: new Set(),
      revisionCount: 0,
    });
    const revised = scoreEncodingSalience({
      body,
      type: "lesson",
      existingRefVocabulary: new Set(),
      revisionCount: 10,
    });
    expect(fresh.score).toBeGreaterThan(revised.score);
  });
});

// ── buildRefVocabulary ──────────────────────────────────────────────────────

describe("buildRefVocabulary", () => {
  test("tokenizes ref names into bigrams", () => {
    const vocab = buildRefVocabulary(["my-lesson-on-auth", "security-token"]);
    // Hyphens should be treated as delimiters; bigrams from the resulting tokens
    expect(vocab.has("my lesson")).toBe(true);
    expect(vocab.has("lesson on")).toBe(true);
    expect(vocab.has("on auth")).toBe(true);
    expect(vocab.has("security token")).toBe(true);
  });

  test("empty refs list → empty vocabulary", () => {
    const vocab = buildRefVocabulary([]);
    expect(vocab.size).toBe(0);
  });

  test("single token ref → no bigrams (need 2+ tokens for a bigram)", () => {
    const vocab = buildRefVocabulary(["auth"]);
    expect(vocab.size).toBe(0);
  });

  test("duplicate refs produce same vocabulary as unique refs (idempotent)", () => {
    const vocab1 = buildRefVocabulary(["foo-bar"]);
    const vocab2 = buildRefVocabulary(["foo-bar", "foo-bar"]);
    expect(vocab1.size).toBe(vocab2.size);
  });
});
