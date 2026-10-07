// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Two files of one source can claim one ref: a skill's `references/a.md` and a
 * note at `knowledge/skills/x/references/a.md` are both
 * `knowledge/skills/x/references/a`. The index holds one row for the ref, and
 * the file with the smaller path holds it, whichever directories a run drains
 * and in whatever order the walk met them (#1050). Before, the first file the
 * run persisted held it, so a full build followed the filesystem's listing
 * order and the first incremental run, which drains only the directory that
 * lost, handed the row to the file that had lost.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getDbPath } from "../../../src/core/paths";
import { akmIndex } from "../../../src/indexer/indexer";
import { _setEmbedderForTests } from "../../../src/llm/embedder";
import { openDatabase } from "../../../src/storage/database";
import { git } from "../../_helpers/git";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";
import { overrideSeam } from "../../_helpers/seams";

const REF = "knowledge/skills/demo/references/a";
const IN_KNOWLEDGE = "knowledge/skills/demo/references/a.md";
const IN_SKILLS = "skills/demo/references/a.md";

let storage: IsolatedAkmStorage;

function write(rel: string, body: string): string {
  const file = path.join(storage.stashDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\ndescription: ${body}\n---\n\n# ${body}\n`, "utf8");
  return file;
}

interface Row {
  id: number;
  file: string;
  embedHash: string | null;
  documentJson: string;
}

/** The row the index holds for `REF`, its file relative to the stash. */
function holder(): Row | undefined {
  const db = openDatabase(getDbPath(), { readonly: true });
  try {
    const row = db
      .prepare("SELECT id, file_path, embed_hash, document_json FROM entries WHERE concept_id = ?")
      .get(REF) as { id: number; file_path: string; embed_hash: string | null; document_json: string } | undefined;
    return (
      row && {
        id: row.id,
        file: path.relative(storage.stashDir, row.file_path),
        embedHash: row.embed_hash,
        documentJson: row.document_json,
      }
    );
  } finally {
    db.close();
  }
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({ semanticSearchMode: "off" });
});

afterEach(() => storage.cleanup());

describe("a ref that two files claim", () => {
  test("is held by the file with the smaller path, and the first incremental run leaves the row alone", async () => {
    write(IN_KNOWLEDGE, "from knowledge");
    write(IN_SKILLS, "from skills");
    write("skills/demo/references/b.md", "only in skills");

    const full = await akmIndex({ stashDir: storage.stashDir, full: true });
    const afterFull = holder();
    expect(afterFull?.file).toBe(IN_KNOWLEDGE);
    // The collision is reported, naming the file indexed and the one skipped.
    expect(full.warnings).toEqual([
      `Two files claim stash//${REF}: indexed ${path.join(storage.stashDir, IN_KNOWLEDGE)}, skipped ${path.join(storage.stashDir, IN_SKILLS)}.`,
    ]);

    // No file is touched: nothing may change, the winner, its entry id, and the text its vector is embedded from.
    const incremental = await akmIndex({ stashDir: storage.stashDir });
    expect(incremental.mode).toBe("incremental");
    expect(holder()).toEqual(afterFull);
    expect(incremental.warnings).toHaveLength(1);

    // `--full` over an existing index agrees with both.
    await akmIndex({ stashDir: storage.stashDir, full: true });
    expect(holder()).toEqual(afterFull);
  });

  test("goes to a file with a smaller path that appears later, as a full index would give it", async () => {
    write(IN_SKILLS, "from skills");
    write("skills/demo/references/b.md", "only in skills");
    await akmIndex({ stashDir: storage.stashDir, full: true });
    expect(holder()?.file).toBe(IN_SKILLS);

    write(IN_KNOWLEDGE, "from knowledge");
    await akmIndex({ stashDir: storage.stashDir });
    const incremental = holder();
    expect(incremental?.file).toBe(IN_KNOWLEDGE);

    await akmIndex({ stashDir: storage.stashDir, full: true });
    expect(holder()).toEqual(incremental);
  });

  test("costs no embedding call on the first incremental run: the held row keeps its vector", async () => {
    writeSandboxConfig({ semanticSearchMode: "auto" });
    let providerCalls = 0;
    overrideSeam(_setEmbedderForTests, {
      embedBatch: async (texts, _config, _signal, _onSkip, onBatch) => {
        providerCalls++;
        const vectors = texts.map((_text, i) => [1 + i, 2 + i, 3 + i]);
        onBatch?.(
          texts.map((_text, i) => i),
          vectors,
        );
        return vectors;
      },
    });
    // A git stash is walked in sorted order, so the full build gives the row to the file with the smaller path
    // and the first incremental run is the one that used to take it away. (A plain directory is walked in the
    // filesystem's order, and only half of the orders did that.)
    git(storage.stashDir, ["init", "-q"]);
    write(IN_KNOWLEDGE, "from knowledge");
    write(IN_SKILLS, "from skills");
    write("skills/demo/references/b.md", "only in skills");

    await akmIndex({ stashDir: storage.stashDir, full: true });
    expect(providerCalls).toBe(1);
    const vectors = () => {
      const db = openDatabase(getDbPath(), { readonly: true });
      try {
        return db.prepare("SELECT id, embedding FROM entries JOIN embeddings USING (id) ORDER BY id").all();
      } finally {
        db.close();
      }
    };
    const before = vectors();
    expect(before).toHaveLength(2);

    // Before, this run gave the row to the other file, which dropped its vector and embedded that file's text.
    providerCalls = 0;
    await akmIndex({ stashDir: storage.stashDir });
    expect(providerCalls).toBe(0);
    expect(vectors()).toEqual(before);
  });

  test("falls back to the other file in the same run when the file that holds it is deleted", async () => {
    write(IN_SKILLS, "from skills");
    write("skills/demo/references/b.md", "only in skills");
    await akmIndex({ stashDir: storage.stashDir, full: true });
    write(IN_KNOWLEDGE, "from knowledge");
    await akmIndex({ stashDir: storage.stashDir });
    expect(holder()?.file).toBe(IN_KNOWLEDGE);

    // The skills directory was skipped when the other file took the ref over. It must drain again to take it
    // back; it used to stay skipped, and the ref left the index although its file was still on disk.
    fs.rmSync(path.join(storage.stashDir, "knowledge", "skills"), { recursive: true });
    const result = await akmIndex({ stashDir: storage.stashDir });
    expect(result.totalEntries).toBe(2);
    const afterDelete = holder();
    expect(afterDelete?.file).toBe(IN_SKILLS);

    await akmIndex({ stashDir: storage.stashDir });
    expect(holder()).toEqual(afterDelete);
    await akmIndex({ stashDir: storage.stashDir, full: true });
    expect(holder()).toEqual(afterDelete);
  });
});
