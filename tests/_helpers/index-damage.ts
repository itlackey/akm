// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Real on-disk damage to an `index.db`, as a power cut or a bad disk leaves it.
 * Both helpers checkpoint the WAL first so the damage lands in the one file
 * SQLite reads.
 */

import { Database } from "bun:sqlite";
import fs from "node:fs";

const PAGE = 4096;

function checkpoint(dbPath: string): Buffer {
  const db = new Database(dbPath);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  for (const suffix of ["-wal", "-shm"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  return fs.readFileSync(dbPath);
}

/** The file header is gone: SQLite reports SQLITE_NOTADB ("file is not a database"). */
export function damageIndexHeader(dbPath: string): void {
  const bytes = checkpoint(dbPath);
  bytes.fill(0xab, 0, 100);
  fs.writeFileSync(dbPath, bytes);
}

/** Page 1 (the schema) is intact, so the open succeeds, but the pages between a third and two thirds of the file are overwritten: SQLITE_CORRUPT on the first query that reaches them. */
export function damageIndexInterior(dbPath: string): void {
  const bytes = checkpoint(dbPath);
  const pages = Math.floor(bytes.length / PAGE);
  if (pages < 12) throw new Error(`index.db has only ${pages} pages; seed more entries`);
  bytes.fill(0xff, Math.floor(pages / 3) * PAGE, Math.floor((pages * 2) / 3) * PAGE);
  fs.writeFileSync(dbPath, bytes);
}
