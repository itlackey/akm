// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  akmCurate,
  type CuratedRegistryItem,
  type CuratedStashItem,
  type CurateResponse,
  packCuratedHits,
} from "../src/commands/read/curate";
import { saveConfig } from "../src/core/config/config";
import { akmIndex } from "../src/indexer/indexer";
import { withIsolatedAkmStorage } from "./_helpers/sandbox";

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

async function withIndexedStash<T>(fn: (stashDir: string) => Promise<T>): Promise<T> {
  const storage = withIsolatedAkmStorage();
  try {
    saveConfig({
      semanticSearchMode: "off",
      bundles: { stash: { path: storage.stashDir } },
      defaultBundle: "stash",
      registries: [],
    });
    return await fn(storage.stashDir);
  } finally {
    storage.cleanup();
  }
}

function stashItem(ref: string, overrides: Partial<CuratedStashItem> = {}): CuratedStashItem {
  return {
    source: "local",
    type: "knowledge",
    name: ref.split("/").pop() ?? ref,
    ref,
    path: "",
    editable: true,
    followUp: `akm show ${ref}`,
    reason: "test",
    ...overrides,
  };
}

function registryItem(overrides: Partial<CuratedRegistryItem> = {}): CuratedRegistryItem {
  return {
    source: "registry",
    type: "registry",
    name: "some-registry-pack",
    id: "some-registry-pack",
    followUp: "akm bundle add some-registry-pack",
    reason: "test",
    ...overrides,
  };
}

function curateResponse(items: CurateResponse["items"], query = "test query"): CurateResponse {
  return { query, summary: "test summary", items };
}

describe("packCuratedHits", () => {
  test("packs hits in ranked order and stops before exceeding the budget (tail-drop)", async () => {
    await withIndexedStash(async (stashDir) => {
      // 400 chars each ⇒ estimateTokenCount (len/4) = 100 tokens exactly.
      writeFile(path.join(stashDir, "knowledge", "first.md"), "a".repeat(400));
      writeFile(path.join(stashDir, "knowledge", "second.md"), "b".repeat(400));
      writeFile(path.join(stashDir, "knowledge", "third.md"), "c".repeat(400));
      await akmIndex({ stashDir, full: true });

      const result = curateResponse([
        stashItem("knowledge/first"),
        stashItem("knowledge/second"),
        stashItem("knowledge/third"),
      ]);

      // Budget fits exactly the first two 100-token hits; the third would
      // push total to 300 > 250, so it's dropped from the tail.
      const packed = await packCuratedHits(result, 250);

      expect(packed.items.map((item) => item.ref)).toEqual(["knowledge/first", "knowledge/second"]);
      expect(packed.items[0]?.tokens).toBe(100);
      expect(packed.items[1]?.tokens).toBe(100);
      expect(packed.tokens).toBe(200);
      expect(packed.budget).toBe(250);
    });
  });

  test("drops lower-ranked hits from the tail before touching earlier ones", async () => {
    await withIndexedStash(async (stashDir) => {
      writeFile(path.join(stashDir, "knowledge", "keep-one.md"), "a".repeat(400));
      writeFile(path.join(stashDir, "knowledge", "keep-two.md"), "b".repeat(400));
      writeFile(path.join(stashDir, "knowledge", "drop-me.md"), "c".repeat(4000));
      await akmIndex({ stashDir, full: true });

      const result = curateResponse([
        stashItem("knowledge/keep-one"),
        stashItem("knowledge/keep-two"),
        stashItem("knowledge/drop-me"),
      ]);

      const packed = await packCuratedHits(result, 250);

      // Both fully-fitting leaders survive; the oversized trailing hit is
      // dropped entirely rather than truncated, because packed is non-empty
      // by the time it's considered.
      expect(packed.items.map((item) => item.ref)).toEqual(["knowledge/keep-one", "knowledge/keep-two"]);
    });
  });

  test("truncates a single hit that alone exceeds the budget instead of dropping it", async () => {
    await withIndexedStash(async (stashDir) => {
      // 2000 chars ⇒ 500 tokens, more than the 100-token budget below.
      writeFile(path.join(stashDir, "knowledge", "huge.md"), "x".repeat(2000));
      await akmIndex({ stashDir, full: true });

      const result = curateResponse([stashItem("knowledge/huge")]);
      const packed = await packCuratedHits(result, 100);

      expect(packed.items).toHaveLength(1);
      expect(packed.items[0]?.ref).toBe("knowledge/huge");
      expect(packed.items[0]?.content.length).toBe(400); // 100 tokens * 4 chars/token
      expect(packed.items[0]?.tokens).toBe(100);
      expect(packed.tokens).toBe(100);
    });
  });

  test("never packs registryHits, even when interleaved with stash items", async () => {
    await withIndexedStash(async (stashDir) => {
      writeFile(path.join(stashDir, "knowledge", "only-stash.md"), "hello world");
      await akmIndex({ stashDir, full: true });

      const result = curateResponse([registryItem(), stashItem("knowledge/only-stash"), registryItem({ id: "other" })]);

      const packed = await packCuratedHits(result, 10_000);

      expect(packed.items).toHaveLength(1);
      expect(packed.items[0]?.ref).toBe("knowledge/only-stash");
    });
  });

  test("skips a hit whose content can no longer be resolved without failing the whole pack", async () => {
    await withIndexedStash(async (stashDir) => {
      writeFile(path.join(stashDir, "knowledge", "real.md"), "a".repeat(40));
      await akmIndex({ stashDir, full: true });

      const result = curateResponse([stashItem("knowledge/does-not-exist"), stashItem("knowledge/real")]);
      const packed = await packCuratedHits(result, 10_000);

      expect(packed.items.map((item) => item.ref)).toEqual(["knowledge/real"]);
    });
  });

  // index-redesign-contract.md B5f item 1 — a search hit's primary `ref` is
  // always the bare entry now, even when the best match was a Markdown
  // fragment; `selectedRef` carries the fragment-qualified ref instead. This
  // proves the two consumers that genuinely need the fragment (curate's
  // `followUp` and `packCuratedHits`'s content fetch) still reach it via that
  // explicit field rather than regressing to whole-document packing.
  test("a body-only match packs just the matched fragment via selectedRef, not the whole entry", async () => {
    await withIndexedStash(async (stashDir) => {
      const filler = Array.from({ length: 500 }, () => "background filler material").join(" ");
      writeFile(
        path.join(stashDir, "knowledge", "fragment-curate.md"),
        `---\ndescription: fragment curate fixture\n---\n\n${filler}\n\nNeedleCurateProof: unique curated marker!`,
      );
      await akmIndex({ stashDir, full: true });

      const result = await akmCurate({ query: "NeedleCurateProof" });
      const item = result.items.find(
        (candidate): candidate is CuratedStashItem =>
          candidate.source === "local" && candidate.ref === "knowledge/fragment-curate",
      );
      if (!item) throw new Error("expected the fragment-curate item in the curated result");

      expect(item.ref).toBe("knowledge/fragment-curate");
      expect(item.selectedRef).toMatch(/^knowledge\/fragment-curate#akm-fragment-/);
      expect(item.followUp).toBe(`akm show ${item.selectedRef}`);

      const packed = await packCuratedHits(curateResponse([item], result.query), 10_000);
      expect(packed.items).toHaveLength(1);
      expect(packed.items[0]?.ref).toBe("knowledge/fragment-curate");
      expect(packed.items[0]?.content).toContain("NeedleCurateProof");
      // Fragment-scoped: the filler paragraph elsewhere in the same document
      // is NOT pulled in — proof this packed the matched section, not the
      // whole entry `item.ref` now always addresses.
      expect(packed.items[0]?.content).not.toContain("background filler material");
    });
  });
});
