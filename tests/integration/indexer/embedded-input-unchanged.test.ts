// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * An entry is re-embedded only when the text its vector is made from changed.
 *
 * That text is the entry's search text cut to `embedding.maxInputTokens`
 * (default 512, about 2,048 characters). The first `akm index` after a release
 * that changes what is indexed (the fenced-code identifiers of akm#1272, which
 * land after the prose) rewrites every entry's search text, but for a document
 * longer than the cut the part that changed is never embedded: the vector would
 * come out identical. Keyword rows still follow the full text.
 *
 * Drives the real `akmIndex` against a counting stub embedding endpoint. The
 * previous release's index is made by indexing the notes without their fenced
 * code (what the previous projection produced for them), then restoring the
 * fences.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getDbPath } from "../../../src/core/paths";
import { akmIndex } from "../../../src/indexer/indexer";
import { deriveEntryProvenance, deriveInstallations } from "../../../src/indexer/installations";
import {
  closeDatabase,
  openExistingDatabase,
  openIndexDatabase,
} from "../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import { searchFts } from "../../../src/storage/repositories/index-fts-repository";
import { hasStoredEmbedding, upsertEmbedding } from "../../../src/storage/repositories/index-vec-repository";
import { runCliCapture } from "../../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

const SHORT_NOTES = ["short-one", "short-two", "short-three"];
const LONG_NOTES = ["long-one", "long-two", "long-three"];

/** Well past the 2,048 characters an embedding input is cut to. */
const LONG_PROSE = Array.from(
  { length: 40 },
  (_unused, i) => `Paragraph ${i} explains how startup checks the configured provider and retries politely.`,
).join("\n\n");

/** The identifier the fenced code of a note contributes to its search text. */
const identifier = (name: string): string =>
  `Quokka${name.replace(/(^|-)(\w)/g, (_m, _d, c: string) => c.toUpperCase())}`;

describe("re-embedding follows the embedded input, not the whole search text", () => {
  let storage: IsolatedAkmStorage;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let inputs: string[] = [];
  let requests = 0;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    inputs = [];
    requests = 0;
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { input: string[] };
        requests++;
        inputs.push(...body.input);
        const data = body.input.map((_text, index) => ({ embedding: [1, 0, 0], index }));
        return Response.json({ data, model: "stub" });
      },
    });
    writeSandboxConfig({
      semanticSearchMode: "auto",
      embedding: { endpoint: `http://localhost:${server.port}`, model: "stub", dimension: 3, batchSize: 50 },
    });
  });

  afterEach(() => {
    server?.stop(true);
    server = undefined;
    storage.cleanup();
  });

  function writeNote(name: string, options: { prose: string; fenced: boolean }): void {
    const lines = ["---", `description: Note ${name}`, "---", `# ${name}`, "", options.prose, ""];
    if (options.fenced) lines.push("```ts", `throw new ${identifier(name)}(code)`, "```", "");
    fs.writeFileSync(path.join(storage.stashDir, "knowledge", `${name}.md`), lines.join("\n"));
  }

  function writeAll(options: { fenced: boolean }): void {
    for (const name of SHORT_NOTES) writeNote(name, { prose: "Short prose about the provider.", ...options });
    for (const name of LONG_NOTES) writeNote(name, { prose: LONG_PROSE, ...options });
  }

  /** Names of the notes whose text went to the embedding endpoint since the last call. */
  function embeddedNames(): string[] {
    const names = [...SHORT_NOTES, ...LONG_NOTES].filter((name) => inputs.some((text) => text.includes(`${name} `)));
    inputs = [];
    return names;
  }

  function withIndex<T>(fn: (db: ReturnType<typeof openExistingDatabase>) => T): T {
    const db = openExistingDatabase(getDbPath());
    try {
      return fn(db);
    } finally {
      closeDatabase(db);
    }
  }

  const keywordHits = (term: string): number => withIndex((db) => searchFts(db, term, 10).length);
  const vectorCount = (): number =>
    withIndex(
      (db) =>
        (db.prepare("SELECT id FROM entries").all() as Array<{ id: number }>).filter((row) =>
          hasStoredEmbedding(db, row.id),
        ).length,
    );

  test("gaining fenced identifiers re-embeds the short notes only; the long notes keep their vectors", async () => {
    writeAll({ fenced: false });
    await akmIndex({ stashDir: storage.stashDir, full: true });
    expect(embeddedNames().sort()).toEqual([...LONG_NOTES, ...SHORT_NOTES].sort());
    expect(vectorCount()).toBe(6);
    expect(keywordHits(identifier("long-one"))).toBe(0);

    writeAll({ fenced: true });
    requests = 0;
    const upgraded = await akmIndex({ stashDir: storage.stashDir });
    expect(upgraded.verification.ok).toBe(true);

    // The keyword rows of every note follow the new text…
    for (const name of [...SHORT_NOTES, ...LONG_NOTES]) expect(keywordHits(identifier(name))).toBe(1);
    // …but only the notes whose embedded part changed go back to the provider, and no note loses its vector.
    expect(embeddedNames().sort()).toEqual([...SHORT_NOTES].sort());
    expect(requests).toBe(1);
    expect(vectorCount()).toBe(6);

    // And once only.
    requests = 0;
    await akmIndex({ stashDir: storage.stashDir });
    expect(requests).toBe(0);
  });

  test("a change to the prose inside the embedded prefix of a long note re-embeds it", async () => {
    writeAll({ fenced: true });
    await akmIndex({ stashDir: storage.stashDir, full: true });
    embeddedNames();

    writeNote("long-two", { prose: `Revised opening paragraph.\n\n${LONG_PROSE}`, fenced: true });
    await akmIndex({ stashDir: storage.stashDir });
    expect(embeddedNames()).toEqual(["long-two"]);
    expect(vectorCount()).toBe(6);

    // A change past the cut only touches the keyword rows.
    writeNote("long-two", {
      prose: `Revised opening paragraph.\n\n${LONG_PROSE}\n\nTail mentioning Wombat.`,
      fenced: true,
    });
    requests = 0;
    await akmIndex({ stashDir: storage.stashDir });
    expect(requests).toBe(0);
    expect(keywordHits("Wombat")).toBe(1);
  });

  test("the decision is exact at the cut: the last embedded character re-embeds, the first one past it does not", () => {
    const db = openIndexDatabase();
    try {
      const installation = deriveInstallations([{ path: storage.stashDir, writable: true }])[0];
      const component = installation?.components[0];
      if (!installation || !component) throw new Error("failed to derive a test bundle installation");
      const provenance = deriveEntryProvenance(
        { bundleId: installation.id, componentId: component.id, adapterId: component.adapter },
        "knowledge",
        "edge",
      );
      const filePath = path.join(storage.stashDir, "knowledge", "edge.md");
      // The search text is `edge <content>`; a 10-token cap embeds its first 40 characters.
      const capTokens = 10;
      const embeddedContentChars = capTokens * 4 - "edge ".length;
      const document = (content: string) => ({
        name: "edge",
        type: "knowledge" as const,
        filename: "edge.md",
        content,
      });
      const original = "a".repeat(200);
      const withCharChanged = (at: number) => `${original.slice(0, at)}b${original.slice(at + 1)}`;
      const id = upsertEntry(db, filePath, document(original), provenance, undefined, capTokens);
      const store = () => upsertEmbedding(db, id, [1, 0, 0], "stub");

      store();
      upsertEntry(db, filePath, document(withCharChanged(embeddedContentChars)), provenance, undefined, capTokens);
      expect(hasStoredEmbedding(db, id)).toBe(true);

      upsertEntry(db, filePath, document(withCharChanged(embeddedContentChars - 1)), provenance, undefined, capTokens);
      expect(hasStoredEmbedding(db, id)).toBe(false);

      // A larger cap embeds the character that was past the cut.
      store();
      upsertEntry(db, filePath, document(original), provenance, undefined, capTokens + 1);
      expect(hasStoredEmbedding(db, id)).toBe(false);

      // A stored document its hash does not vouch for has no known input: even a change past the cut re-embeds.
      store();
      db.prepare("UPDATE entries SET embed_hash = NULL WHERE id = ?").run(id);
      upsertEntry(db, filePath, document(withCharChanged(embeddedContentChars)), provenance, undefined, capTokens);
      expect(hasStoredEmbedding(db, id)).toBe(false);
    } finally {
      closeDatabase(db);
    }
  });

  test("`akm index --format json` names the embedding work on stderr and leaves stdout as the JSON result", async () => {
    writeAll({ fenced: false });
    const first = await runCliCapture(["index", "--format", "json"]);
    expect(first.code).toBe(0);
    expect(first.stderr).toContain("[index:embeddings] Embedding 6 changed entries (0 unchanged)");

    // The next index re-embeds the three short notes; the three long notes keep their vectors.
    writeAll({ fenced: true });
    const second = await runCliCapture(["index", "--format", "json"]);
    expect(second.code).toBe(0);
    expect(second.stderr).toContain("[index:embeddings] Embedding 3 changed entries (3 unchanged)");

    // stdout is the one JSON result, with none of the progress in it.
    expect(JSON.parse(second.stdout)).toMatchObject({ mode: "incremental", totalEntries: 6 });
    expect(second.stdout).not.toContain("Embedding");

    // Nothing to embed: no line about it beyond the up-to-date notice.
    const settled = await runCliCapture(["index", "--format", "json"]);
    expect(settled.stderr).not.toContain("changed entries");
  });
});
