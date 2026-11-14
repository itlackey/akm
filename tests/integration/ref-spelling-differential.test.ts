// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * One ref grammar for every reader: for each asset of the all-types fixture and a grid of ways to
 * spell its ref, `show` answers the same from the index and from the bundle's files, and `feedback`
 * accepts exactly the spellings `show` accepts and names the asset by the ref `show` returns.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../src/core/config/config";
import { getDbPath } from "../../src/core/paths";
import { akmIndex } from "../../src/indexer/indexer";
import { closeDatabase, openExistingDatabase } from "../../src/storage/repositories/index-connection";
import { namesMarkdownFile } from "../../src/storage/repositories/index-entries-repository";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withDefaultBundle, withIsolatedAkmStorage } from "../_helpers/sandbox";

const FIXTURE = path.resolve(import.meta.dir, "../fixtures/stashes/all-types");

interface Asset {
  /** The ref `show` returns for the asset. */
  conceptId: string;
  /** The asset's file, relative to the bundle. */
  file: string;
}

interface Answer {
  code: number;
  ref?: string;
  path?: string;
}

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  saveConfig(withDefaultBundle({ semanticSearchMode: "off" }, storage.stashDir));
  fs.cpSync(FIXTURE, storage.stashDir, { recursive: true });
});

afterEach(() => storage.cleanup());

function indexedAssets(): Asset[] {
  const db = openExistingDatabase(getDbPath());
  try {
    const rows = db.prepare("SELECT item_ref, file_path FROM entries ORDER BY item_ref").all() as {
      item_ref: string;
      file_path: string;
    }[];
    return rows.map((row) => ({
      conceptId: row.item_ref.slice(row.item_ref.indexOf("//") + 2),
      file: path.relative(storage.stashDir, row.file_path).replaceAll("\\", "/"),
    }));
  } finally {
    closeDatabase(db);
  }
}

function spellings({ conceptId, file }: Asset): string[] {
  const segments = conceptId.split("/");
  const last = segments[segments.length - 1]!;
  const withoutExt = conceptId.replace(/\.[^./]+$/, "");
  return [
    ...new Set([
      conceptId,
      `${conceptId}.md`,
      file,
      `stash//${conceptId}`,
      `stash//${file}`,
      conceptId.replaceAll("/", "\\"),
      [...segments.slice(0, -1), last.toUpperCase()].join("/"),
      `${conceptId}/`,
      `${segments[0]}/${conceptId}`,
      withoutExt,
    ]),
  ];
}

function answer(run: { code: number; stdout: string }): Answer {
  if (run.code !== 0) return { code: run.code };
  const body = JSON.parse(run.stdout) as { ref?: string; path?: string };
  return { code: 0, ref: body.ref, path: body.path };
}

async function show(spelling: string): Promise<Answer> {
  return answer(await runCliCapture(["show", spelling, "--format=json"]));
}

async function feedback(spelling: string): Promise<Answer> {
  return answer(await runCliCapture(["feedback", spelling, "--positive", "--format=json"]));
}

describe("ref spellings", () => {
  test("show from the index equals show from the files, and feedback accepts what show accepts under the same ref", async () => {
    // Cold library: no index, so `show` can only answer from the bundle's files.
    await akmIndex({ stashDir: storage.stashDir, full: true });
    const library = indexedAssets();
    expect(library.length).toBe(13);
    fs.rmSync(getDbPath(), { force: true });
    fs.rmSync(`${getDbPath()}-wal`, { force: true });
    fs.rmSync(`${getDbPath()}-shm`, { force: true });

    const fromFiles = new Map<string, Answer>();
    for (const asset of library) {
      for (const spelling of spellings(asset)) fromFiles.set(spelling, await show(spelling));
    }

    await akmIndex({ stashDir: storage.stashDir, full: true });

    const problems: string[] = [];
    for (const asset of library) {
      const canonical = await show(asset.conceptId);
      expect(canonical.code).toBe(0);
      for (const spelling of spellings(asset)) {
        const files = fromFiles.get(spelling)!;
        const index = await show(spelling);
        const fb = await feedback(spelling);
        if (JSON.stringify(files) !== JSON.stringify(index)) {
          problems.push(`${spelling}: show from files ${JSON.stringify(files)} != from index ${JSON.stringify(index)}`);
        }
        if ((index.code === 0) !== (fb.code === 0)) {
          problems.push(`${spelling}: show exit ${index.code}, feedback exit ${fb.code}`);
        } else if (index.code === 0 && fb.ref !== index.ref) {
          problems.push(`${spelling}: show ref ${index.ref}, feedback ref ${fb.ref}`);
        }
      }
    }
    expect(problems).toEqual([]);
  }, 60_000);
});

describe("the .md toggle", () => {
  test("names a markdown file by its own name, wherever the adapter keeps it", () => {
    expect(namesMarkdownFile("knowledge/x.md", "/b/knowledge/x.md")).toBe(true);
    expect(namesMarkdownFile("x", "/b/.claude/anything/x.md")).toBe(true);
    expect(namesMarkdownFile("skills/x.md", "/b/skills/x/SKILL.md")).toBe(false);
    expect(namesMarkdownFile("tasks/x.md", "/b/tasks/x.yml")).toBe(false);
    expect(namesMarkdownFile("scripts/x.sh.md", "/b/scripts/x.sh")).toBe(false);
  });
});
