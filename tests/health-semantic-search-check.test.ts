import { describe, expect, test } from "bun:test";
import { HEALTH_CHECKS } from "../src/commands/health/checks";
import { type SemanticSearchState, semanticSearchCheck } from "../src/commands/health/semantic-search-check";
import type { SemanticSearchRecord } from "../src/indexer/walk/index-context";

// `semantic-search` projects what the last `akm index` recorded (and the index's
// counts, read at health time) into one check. Driven here with synthetic state.

const BUILT_AT = "2026-10-26T12:00:00.000Z";

function indexed(record: SemanticSearchRecord, entryCount = 4, embeddingCount = 4): SemanticSearchState {
  return { mode: "auto", index: { record, builtAt: BUILT_AT, entryCount, embeddingCount } };
}

describe("semantic-search check", () => {
  test("is registered as a hard check", () => {
    expect(HEALTH_CHECKS.find((c) => c.name === "semantic-search")?.channel).toBe("hard");
  });

  test("passes when every entry has a vector on the native runtime", () => {
    const r = semanticSearchCheck(indexed({ status: "ready-js", provider: "local", runtime: "onnxruntime-node" }));
    expect(r).toMatchObject({ name: "semantic-search", kind: "deterministic", status: "pass" });
    expect(r.message).toBe("Semantic search ready (4/4 embeddings on onnxruntime-node).");
    expect(r.evidence).toMatchObject({ status: "ready-js", builtAt: BUILT_AT, entryCount: 4, embeddingCount: 4 });
  });

  test("passes for a remote provider, which records no local runtime", () => {
    const r = semanticSearchCheck(indexed({ status: "ready-js", provider: "remote" }));
    expect(r.status).toBe("pass");
    expect(r.message).toBe("Semantic search ready (4/4 embeddings).");
  });

  test("warns when embeddings lag the entries the index holds now", () => {
    const r = semanticSearchCheck(indexed({ status: "ready-js", provider: "local" }, 5, 3));
    expect(r.status).toBe("warn");
    expect(r.message).toContain("Embeddings lag entries (3/5)");
  });

  test("warns when local embeddings ran on a runtime other than the native one", () => {
    const r = semanticSearchCheck(indexed({ status: "ready-js", provider: "local", runtime: "onnxruntime-web" }));
    expect(r.status).toBe("warn");
    expect(r.message).toContain("onnxruntime-web, not the native onnxruntime-node");
  });

  test("fails when blocked, with the recorded reason", () => {
    const r = semanticSearchCheck(
      indexed({ status: "blocked", provider: "remote", reason: "All 3 embedding batch(es) failed: refused" }, 3, 0),
    );
    expect(r.status).toBe("fail");
    expect(r.message).toBe(
      `Semantic search was blocked at the last index (${BUILT_AT}): All 3 embedding batch(es) failed: refused`,
    );
  });

  test("fails when unavailable on this machine, with the recorded reason", () => {
    const r = semanticSearchCheck(
      indexed({ status: "unavailable", provider: "local", reason: "no native library is available" }, 3, 0),
    );
    expect(r.status).toBe("fail");
    expect(r.message).toContain("unavailable on this machine");
    expect(r.message).toContain("no native library is available");
    expect(r.evidence?.status).toBe("unavailable");
  });

  test("passes when the config turns semantic search off, whatever the last index recorded", () => {
    const r = semanticSearchCheck({ ...indexed({ status: "blocked", provider: "local", reason: "x" }), mode: "off" });
    expect(r.status).toBe("pass");
    expect(r.evidence).toEqual({ mode: "off" });
  });

  test("is unknown with no index, no record, a run with semantic search off, or no entries", () => {
    expect(semanticSearchCheck({ mode: "auto" }).status).toBe("unknown");
    expect(semanticSearchCheck({ mode: "auto", index: { entryCount: 2, embeddingCount: 0 } }).message).toContain(
      "run `akm index`",
    );
    expect(semanticSearchCheck(indexed({ status: "disabled", provider: "local" })).status).toBe("unknown");
    expect(semanticSearchCheck(indexed({ status: "pending", provider: "local" }, 0, 0)).status).toBe("unknown");
    expect(semanticSearchCheck({ mode: "auto", error: "unreadable" }).message).toBe(
      "Could not read the index: unreadable",
    );
  });
});
