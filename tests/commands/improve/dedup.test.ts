// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  applyProvenance,
  type DedupMemory,
  loadDedupMemories,
  normalizeMemoryBody,
  planDedup,
  runDeterministicDedup,
} from "../../../src/commands/improve/dedup";
import { parseFrontmatter } from "../../../src/core/asset/frontmatter";
import type { AkmConfig } from "../../../src/core/config/config";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});
afterEach(() => storage.cleanup());

function writeMemory(name: string, frontmatter: Record<string, unknown>, body: string): string {
  const memoriesDir = path.join(storage.stashDir, "memories");
  fs.mkdirSync(memoriesDir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
  const content = `---\n${fm}\n---\n${body}\n`;
  const fp = path.join(memoriesDir, `${name}.md`);
  fs.writeFileSync(fp, content, "utf8");
  return fp;
}

// No embedding configured: only exact-hash collapse is reachable. Cosine tests
// inject a hand-built embeddings Map into planDedup directly (no network).
const noEmbedConfig = {} as AkmConfig;

describe("normalizeMemoryBody", () => {
  test("strips frontmatter, lowercases, collapses whitespace", () => {
    const a = normalizeMemoryBody("---\ndescription: x\n---\nHello   World\n\n\nFoo");
    const b = normalizeMemoryBody("---\ndescription: y\n---\nhello world foo");
    expect(a).toBe(b);
  });
});

describe("planDedup — derived ↔ origin", () => {
  test("collapses a .derived child identical to its origin (no LLM)", () => {
    writeMemory("alpha", { description: "origin" }, "The same body content here.");
    writeMemory(
      "alpha.derived",
      { description: "derived", inferred: true, derivedFrom: "alpha", source: "memory:alpha" },
      "The same body content here.",
    );
    const memories = loadDedupMemories(storage.stashDir);
    const plan = planDedup(memories, { cosineThreshold: 0.97 });
    expect(plan.collapses).toHaveLength(1);
    const c = plan.collapses[0];
    expect(c?.canonical).toBe("alpha");
    expect(c?.variant).toBe("alpha.derived");
    expect(c?.via).toBe("derived-hash");
  });

  test("does NOT collapse a .derived child whose body differs from origin", () => {
    writeMemory("beta", { description: "origin" }, "Original body about topic A.");
    writeMemory(
      "beta.derived",
      { inferred: true, derivedFrom: "beta" },
      "A completely different distilled note about topic B and C.",
    );
    const memories = loadDedupMemories(storage.stashDir);
    const plan = planDedup(memories, { cosineThreshold: 0.97 });
    expect(plan.collapses).toHaveLength(0);
  });
});

describe("planDedup — content twins", () => {
  test("merges two identical-body memories into the lexicographically smallest canonical", () => {
    writeMemory("zeta", { description: "x" }, "Identical twin body text.");
    writeMemory("aardvark", { description: "y" }, "Identical twin body text.");
    const memories = loadDedupMemories(storage.stashDir);
    const plan = planDedup(memories, { cosineThreshold: 0.97 });
    expect(plan.collapses).toHaveLength(1);
    expect(plan.collapses[0]?.canonical).toBe("aardvark");
    expect(plan.collapses[0]?.variant).toBe("zeta");
    expect(plan.collapses[0]?.via).toBe("twin-hash");
  });

  test("distinct memories are never merged (fall through to LLM)", () => {
    writeMemory("one", { description: "x" }, "Notes about the database indexing pipeline.");
    writeMemory("two", { description: "y" }, "Notes about the CLI argument parser.");
    const memories = loadDedupMemories(storage.stashDir);
    const plan = planDedup(memories, { cosineThreshold: 0.97 });
    expect(plan.collapses).toHaveLength(0);
  });

  test("cosine twins above the strict threshold collapse; below it fall through", () => {
    writeMemory("aaa", { description: "x" }, "Body one which is not hash-identical to body two.");
    writeMemory("bbb", { description: "y" }, "Body two which is not hash-identical to body one.");
    const memories = loadDedupMemories(storage.stashDir);
    // Hand-built near-parallel vectors → cosine ~0.999 (above 0.97).
    const high = new Map<string, number[]>([
      ["aaa", [1, 0, 0]],
      ["bbb", [0.999, 0.0447, 0]],
    ]);
    const planHigh = planDedup(memories, { cosineThreshold: 0.97, embeddings: high });
    expect(planHigh.collapses).toHaveLength(1);
    expect(planHigh.collapses[0]?.via).toBe("twin-cosine");

    // Orthogonal vectors → cosine 0 (below threshold): no collapse.
    const low = new Map<string, number[]>([
      ["aaa", [1, 0, 0]],
      ["bbb", [0, 1, 0]],
    ]);
    const planLow = planDedup(memories, { cosineThreshold: 0.97, embeddings: low });
    expect(planLow.collapses).toHaveLength(0);
  });
});

describe("planDedup — hot guard", () => {
  test("never collapses a captureMode:hot memory (as canonical or variant)", () => {
    writeMemory("hot-origin", { captureMode: "hot", description: "x" }, "Same body for both.");
    writeMemory("hot-origin.derived", { inferred: true, derivedFrom: "hot-origin" }, "Same body for both.");
    writeMemory("twin-hot", { captureMode: "hot" }, "Shared twin body unique here.");
    writeMemory("twin-plain", {}, "Shared twin body unique here.");
    const memories = loadDedupMemories(storage.stashDir);
    const plan = planDedup(memories, { cosineThreshold: 0.97 });
    expect(plan.collapses).toHaveLength(0);
  });
});

describe("applyProvenance", () => {
  test("adds dedupedFrom ref to the canonical frontmatter, deduplicated + sorted", () => {
    const canonical = "---\ndescription: keep\n---\nBody.";
    const variant: DedupMemory = {
      name: "var-b",
      filePath: "/x",
      derived: false,
      raw: "",
      normalizedBody: "",
      bodyHash: "",
      hot: false,
    };
    const out1 = applyProvenance(canonical, variant);
    const fm1 = parseFrontmatter(out1).data as Record<string, unknown>;
    expect(fm1.dedupedFrom).toEqual(["memory:var-b"]);
    // Idempotent + sorted when applied again with another variant.
    const variantA: DedupMemory = { ...variant, name: "var-a" };
    const out2 = applyProvenance(out1, variantA);
    const fm2 = parseFrontmatter(out2).data as Record<string, unknown>;
    expect(fm2.dedupedFrom).toEqual(["memory:var-a", "memory:var-b"]);
  });
});

describe("runDeterministicDedup — end to end (no LLM, no network)", () => {
  test("default OFF: disabled config is a no-op (byte-identical stash)", async () => {
    writeMemory("a", { description: "x" }, "Identical body.");
    writeMemory("b", { description: "y" }, "Identical body.");
    const before = fs.readdirSync(path.join(storage.stashDir, "memories")).sort();

    const r1 = await runDeterministicDedup(storage.stashDir, undefined, noEmbedConfig);
    expect(r1.collapsed).toBe(0);
    const r2 = await runDeterministicDedup(storage.stashDir, { enabled: false }, noEmbedConfig);
    expect(r2.collapsed).toBe(0);

    const after = fs.readdirSync(path.join(storage.stashDir, "memories")).sort();
    expect(after).toEqual(before);
  });

  test("enabled: collapses derived + twin to one asset each, preserves provenance, deletes variant", async () => {
    writeMemory("canon", { description: "x" }, "The canonical body text here.");
    writeMemory("canon.derived", { inferred: true, derivedFrom: "canon" }, "The canonical body text here.");
    // Content twins: canonical is the lexicographically smallest name ("twin-a").
    writeMemory("twin-a", { description: "k" }, "A duplicated twin body.");
    writeMemory("twin-z", { description: "d" }, "A duplicated twin body.");

    const result = await runDeterministicDedup(storage.stashDir, { enabled: true }, noEmbedConfig);
    expect(result.collapsed).toBe(2);
    expect(result.consumedRefs.sort()).toEqual(["memory:canon.derived", "memory:twin-z"]);

    const memoriesDir = path.join(storage.stashDir, "memories");
    // Variants gone, canonicals remain.
    expect(fs.existsSync(path.join(memoriesDir, "canon.derived.md"))).toBe(false);
    expect(fs.existsSync(path.join(memoriesDir, "twin-z.md"))).toBe(false);
    expect(fs.existsSync(path.join(memoriesDir, "canon.md"))).toBe(true);
    expect(fs.existsSync(path.join(memoriesDir, "twin-a.md"))).toBe(true);

    // Provenance recorded on the canonicals.
    const canonFm = parseFrontmatter(fs.readFileSync(path.join(memoriesDir, "canon.md"), "utf8")).data as Record<
      string,
      unknown
    >;
    expect(canonFm.dedupedFrom).toEqual(["memory:canon.derived"]);
    const twinFm = parseFrontmatter(fs.readFileSync(path.join(memoriesDir, "twin-a.md"), "utf8")).data as Record<
      string,
      unknown
    >;
    expect(twinFm.dedupedFrom).toEqual(["memory:twin-z"]);
  });

  test("enabled but no duplicates: distinct memories untouched", async () => {
    writeMemory("p", { description: "x" }, "Distinct content about A.");
    writeMemory("q", { description: "y" }, "Distinct content about B.");
    const before = fs
      .readdirSync(path.join(storage.stashDir, "memories"))
      .map((f) => fs.readFileSync(path.join(storage.stashDir, "memories", f), "utf8"))
      .join("|");
    const result = await runDeterministicDedup(storage.stashDir, { enabled: true }, noEmbedConfig);
    expect(result.collapsed).toBe(0);
    const after = fs
      .readdirSync(path.join(storage.stashDir, "memories"))
      .map((f) => fs.readFileSync(path.join(storage.stashDir, "memories", f), "utf8"))
      .join("|");
    expect(after).toBe(before);
  });
});
