// This integration suite opens real index.db files to pin what each opener does with the layout marker: an
// older layout is served, a newer one is refused, naming the upgrade.

import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { _setWarnSinkForTests } from "../../../src/core/warn";
import { openDatabase } from "../../../src/storage/database";
import {
  closeDatabase,
  openExistingDatabase,
  openIndexDatabase,
  openReadonlyExistingDatabase,
} from "../../../src/storage/repositories/index-connection";
import { getEntryCount } from "../../../src/storage/repositories/index-entries-repository";
import { CANONICAL_INDEX_DB_VERSION } from "../../../src/storage/repositories/index-entry-schema";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

function stampGeneration(dbPath: string, version: string | undefined): void {
  const db = openIndexDatabase(dbPath);
  try {
    if (version === undefined) db.exec("DELETE FROM index_meta WHERE key = 'version'");
    else db.prepare("UPDATE index_meta SET value = ? WHERE key = 'version'").run(version);
  } finally {
    closeDatabase(db);
  }
}

function expectServed(open: () => ReturnType<typeof openExistingDatabase> | undefined): void {
  const db = open();
  if (!db) throw new Error("expected a queryable handle");
  try {
    expect(getEntryCount(db)).toBe(0);
  } finally {
    closeDatabase(db);
  }
}

describe("index openers and the layout marker", () => {
  let storage: IsolatedAkmStorage;
  let warnings: string[] = [];
  afterEach(() => {
    _setWarnSinkForTests(undefined);
    storage?.cleanup();
  });

  function setup(version: string | undefined): string {
    storage = withIsolatedAkmStorage();
    const dbPath = path.join(storage.root, "index.db");
    stampGeneration(dbPath, version);
    warnings = [];
    _setWarnSinkForTests((_level, args) => warnings.push(args.map(String).join(" ")));
    return dbPath;
  }

  test("preserves the absent-index result for the read-only opener", () => {
    storage = withIsolatedAkmStorage();
    expect(openReadonlyExistingDatabase(path.join(storage.root, "absent.db"))).toBeUndefined();
  });

  test("an older layout is served by both readers with one line naming akm index", () => {
    const dbPath = setup(String(CANONICAL_INDEX_DB_VERSION - 1));
    expectServed(() => openExistingDatabase(dbPath));
    expectServed(() => openReadonlyExistingDatabase(dbPath));
    expect(warnings.filter((line) => line.includes("older layout"))).toHaveLength(1);
    expect(warnings[0]).toContain("akm index");
  });

  test("a newer layout is refused by every opener, naming the upgrade, and left as it is", () => {
    const newer = CANONICAL_INDEX_DB_VERSION + 1;
    const dbPath = setup(String(newer));
    for (const open of [
      () => openExistingDatabase(dbPath),
      () => openReadonlyExistingDatabase(dbPath),
      () => openIndexDatabase(dbPath),
    ]) {
      let refusal: unknown;
      try {
        closeDatabase(open() as NonNullable<ReturnType<typeof open>>);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toMatchObject({ code: "INDEX_SCHEMA_INCOMPATIBLE" });
      expect(String((refusal as Error).message)).toContain(`newer akm (layout ${newer}`);
      expect(String((refusal as Error).message)).toContain("Upgrade akm to use this index.");
    }
    const raw = openDatabase(dbPath, { readonly: true, create: false });
    try {
      expect(raw.prepare("SELECT value FROM index_meta WHERE key = 'version'").get()).toEqual({ value: String(newer) });
    } finally {
      raw.close();
    }
  });

  test("a missing layout marker is served, and the writable open stamps it", () => {
    const dbPath = setup(undefined);
    expectServed(() => openReadonlyExistingDatabase(dbPath));
    const db = openIndexDatabase(dbPath);
    try {
      expect((db.prepare("SELECT value FROM index_meta WHERE key = 'version'").get() as { value: string }).value).toBe(
        String(CANONICAL_INDEX_DB_VERSION),
      );
    } finally {
      closeDatabase(db);
    }
  });
});
