// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm index --export-vectors` / `--import-vectors`: a vector file lets a cold
 * index skip the embedder for every entry whose (model, embedded text) it
 * holds. The embedder is the deterministic one, wrapped to count its calls.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDbPath } from "../src/core/paths";
import { _setWarnSinkForTests } from "../src/core/warn";
import { _setEmbedderForTests } from "../src/llm/embedder";
import { deterministicEmbed } from "../src/llm/embedders/deterministic";
import { openDatabase } from "../src/storage/database";
import { runCliCapture } from "./_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "./_helpers/sandbox";

const BODY_SENTENCE = "Zebras compose quiet limericks about cartography";
const NOTES = 5;

let storage: IsolatedAkmStorage | undefined;
/** Holds the vector files, outside the per-test storage that `useStorage` replaces. */
let filesDir: string;
let embedCalls: string[][];
let warnings: string[];

function useStorage(config: Record<string, unknown> = {}): IsolatedAkmStorage {
  storage?.cleanup();
  storage = withIsolatedAkmStorage({ AKM_EMBED_DETERMINISTIC: "1" });
  writeSandboxConfig({ semanticSearchMode: "auto", ...config });
  for (let i = 0; i < NOTES; i++) {
    fs.writeFileSync(
      path.join(storage.stashDir, "knowledge", `note-${i}.md`),
      `---\ndescription: note ${i}\n---\n\n${BODY_SENTENCE} number ${i}.\n`,
    );
  }
  embedCalls = [];
  return storage;
}

function embeddingsByRef(): Map<string, string> {
  const db = openDatabase(getDbPath(), { readonly: true, create: false });
  try {
    const rows = db
      .prepare("SELECT e.item_ref AS ref, hex(b.embedding) AS hex FROM entries e JOIN embeddings b ON b.id = e.id")
      .all() as Array<{ ref: string; hex: string }>;
    return new Map(rows.map((r) => [r.ref.replace(/^.*\/\//, ""), r.hex]));
  } finally {
    db.close();
  }
}

async function indexWith(...flags: string[]): Promise<void> {
  const result = await runCliCapture(["index", "--full", ...flags]);
  expect(result.code).toBe(0);
}

beforeEach(() => {
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-vector-file-"));
  warnings = [];
  embedCalls = [];
  _setWarnSinkForTests((level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
  _setEmbedderForTests({
    embedBatch: async (texts, _config, _signal, _onSkip, onBatch) => {
      embedCalls.push(texts);
      const vectors = texts.map((t) => deterministicEmbed(t));
      onBatch?.(
        vectors.map((_v, i) => i),
        vectors,
      );
      return vectors;
    },
  });
});

afterEach(() => {
  _setEmbedderForTests(undefined);
  _setWarnSinkForTests(undefined);
  storage?.cleanup();
  storage = undefined;
  fs.rmSync(filesDir, { recursive: true, force: true });
});

/** Index a bundle, export its vectors, and return the file and the vectors per entry. */
async function exportedBundle(): Promise<{ file: string; vectors: Map<string, string> }> {
  useStorage();
  await indexWith();
  expect(embedCalls.flat()).toHaveLength(NOTES);
  const file = path.join(filesDir, "vectors.db");
  const result = await runCliCapture(["index", "--export-vectors", file]);
  expect(result.code).toBe(0);
  return { file, vectors: embeddingsByRef() };
}

describe("akm index --export-vectors / --import-vectors", () => {
  test("import into an empty data directory with unchanged content makes no embedder calls", async () => {
    const { file, vectors } = await exportedBundle();
    useStorage();
    await indexWith("--import-vectors", file);
    expect(embedCalls).toHaveLength(0);
    expect(embeddingsByRef()).toEqual(vectors);
  });

  test("one edited entry makes exactly one embedder call", async () => {
    const { file } = await exportedBundle();
    const dir = useStorage();
    fs.appendFileSync(path.join(dir.stashDir, "knowledge", "note-2.md"), "An edit.\n");
    await indexWith("--import-vectors", file);
    expect(embedCalls.flat()).toHaveLength(1);
  });

  test("a different model embeds every entry and warns", async () => {
    const { file } = await exportedBundle();
    useStorage({ embedding: { endpoint: "http://127.0.0.1:1/v1/embeddings", model: "other-model" } });
    const previous = process.env.AKM_EMBED_DETERMINISTIC;
    delete process.env.AKM_EMBED_DETERMINISTIC;
    try {
      await indexWith("--import-vectors", file);
    } finally {
      process.env.AKM_EMBED_DETERMINISTIC = previous;
    }
    expect(embedCalls.flat()).toHaveLength(NOTES);
    expect(warnings.some((w) => w.includes("no vectors for the current embedding model"))).toBe(true);
  });

  test.each([
    ["a missing file", (dir: string) => path.join(dir, "absent.db")],
    [
      "a corrupt file",
      (dir: string) => {
        const file = path.join(dir, "corrupt.db");
        fs.writeFileSync(file, "this is not a database".repeat(50));
        return file;
      },
    ],
    [
      "a SQLite file with no vectors table",
      (dir: string) => {
        const file = path.join(dir, "foreign.db");
        const db = openDatabase(file, { create: true });
        db.exec("CREATE TABLE other (x INTEGER)");
        db.close();
        return file;
      },
    ],
  ])("%s warns, indexes normally and exits 0", async (_label, make) => {
    useStorage();
    const file = make(filesDir);
    await indexWith("--import-vectors", file);
    expect(embedCalls.flat()).toHaveLength(NOTES);
    expect(warnings.some((w) => w.includes("--import-vectors"))).toBe(true);
  });

  test("--reembed with an import warns and re-embeds everything", async () => {
    const { file } = await exportedBundle();
    useStorage();
    await indexWith("--reembed", "--import-vectors", file);
    expect(embedCalls.flat()).toHaveLength(NOTES);
    expect(warnings.some((w) => w.includes("ignored with --reembed"))).toBe(true);
  });

  test("with semantic search off the import is ignored with a warning", async () => {
    const { file } = await exportedBundle();
    useStorage({ semanticSearchMode: "off" });
    await indexWith("--import-vectors", file);
    expect(embedCalls).toHaveLength(0);
    expect(warnings.some((w) => w.includes("semantic search is off"))).toBe(true);
  });

  test("the file holds no document text and no paths", async () => {
    const { file } = await exportedBundle();
    const bytes = fs.readFileSync(file).toString("latin1");
    expect(bytes).not.toContain("Zebras");
    expect(bytes).not.toContain("cartography");
    expect(bytes).not.toContain(path.basename(path.dirname(file)));
    expect(bytes).not.toContain("note-");
    const db = openDatabase(file, { readonly: true, create: false });
    expect(db.prepare("SELECT COUNT(*) AS n FROM vectors").get()).toEqual({ n: NOTES });
    db.close();
  });

  test("export starts no embedder, does not rebuild, and leaves an earlier file intact on failure", async () => {
    const { file } = await exportedBundle();
    const indexBefore = fs.statSync(getDbPath()).mtimeMs;
    const callsBefore = embedCalls.length;
    const again = path.join(path.dirname(file), "again.db");
    expect((await runCliCapture(["index", "--export-vectors", again])).code).toBe(0);
    expect(embedCalls).toHaveLength(callsBefore);
    expect(fs.statSync(getDbPath()).mtimeMs).toBe(indexBefore);
    const before = fs.readFileSync(file);
    const failed = await runCliCapture(["index", "--export-vectors", path.join(file, "nested", "x.db")]);
    expect(failed.code).not.toBe(0);
    expect(fs.readFileSync(file)).toEqual(before);
  });

  test("an export with no vectors is an empty valid file and exits 0", async () => {
    useStorage();
    const file = path.join(filesDir, "empty.db");
    expect((await runCliCapture(["index", "--export-vectors", file])).code).toBe(0);
    const db = openDatabase(file, { readonly: true, create: false });
    expect(db.prepare("SELECT COUNT(*) AS n FROM vectors").get()).toEqual({ n: 0 });
    expect(warnings.some((w) => w.includes("no vectors"))).toBe(true);
    db.close();
  });
});
