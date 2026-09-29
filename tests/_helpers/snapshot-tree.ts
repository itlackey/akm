// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Directory-tree snapshotting for "nothing changed" before/after assertions.
 *
 * A naive snapshot hashes every file's raw bytes. That is wrong for a `.db`
 * file in WAL mode: SQLite (or a GC'd zombie bun:sqlite connection — see
 * `src/storage/database.ts`'s `openDatabaseFinalizing` doc comment for the
 * `close()`-with-unfinalized-`prepare()` mechanism) can checkpoint the WAL
 * into the main file and remove `-wal`/`-shm` at any moment a connection
 * finally closes for real, independent of anything the test itself did. That
 * rewrites the main file's bytes and deletes its sidecars with zero logical
 * change, which made a byte-snapshot comparison flake on GC timing: a
 * `before` snapshot taken right after a real write could catch the WAL
 * pre-checkpoint, and an `after` snapshot taken moments later — with no
 * logical write in between — could catch it post-checkpoint.
 *
 * This snapshots what SQLite itself considers the data instead: for a `.db`
 * file, every table's schema and rows, read through an ordinary read-only
 * connection (which sees WAL content already merged logically, whether or
 * not it has been physically checkpointed yet); `-wal`/`-shm` sidecars are
 * skipped outright since their presence/size reflects checkpoint timing, not
 * data written. Ordinary files are still hashed by raw bytes.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function encodeValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value instanceof Uint8Array) return `blob:${Buffer.from(value).toString("hex")}`;
  if (typeof value === "bigint") return `int:${value.toString()}`;
  if (typeof value === "number") return `num:${value}`;
  if (typeof value === "string") return `str:${value}`;
  return `json:${JSON.stringify(value)}`;
}

/**
 * Digest one SQLite file's logical content: every table's schema and rows,
 * tables sorted by name, rows ordered by rowid — or by every column, for a
 * `WITHOUT ROWID` table, which has none.
 */
function digestSqliteFile(filePath: string): string {
  const db = new Database(filePath, { readonly: true, create: false });
  try {
    const hash = createHash("sha256");
    const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
      name: string;
      sql: string | null;
    }>;
    for (const { name, sql } of tables) {
      hash.update(`table:${name}\n${sql ?? ""}\n`);
      const columns = (db.prepare(`PRAGMA table_info(${quoteIdent(name)})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
      );
      const selectList = columns.map(quoteIdent).join(", ");
      const withoutRowid = /\bwithout\s+rowid\b/i.test(sql ?? "");
      const orderBy = withoutRowid ? selectList : "rowid";
      const rows = db.prepare(`SELECT ${selectList} FROM ${quoteIdent(name)} ORDER BY ${orderBy}`).all() as Array<
        Record<string, unknown>
      >;
      for (const row of rows) {
        hash.update("row:");
        for (const column of columns) hash.update(`|${column}=${encodeValue(row[column])}`);
        hash.update("\n");
      }
    }
    return hash.digest("hex");
  } finally {
    db.close();
  }
}

/** A SQLite sidecar whose presence/size reflects checkpoint timing, not data written. */
function isSqliteSidecar(fileName: string): boolean {
  return fileName.endsWith("-wal") || fileName.endsWith("-shm");
}

/**
 * Snapshot a directory tree for a before/after "nothing changed" comparison.
 * Ordinary files are hashed by raw bytes (`<byteLength>:<sha256>`). A `.db`
 * file is instead represented by a digest of its logical SQLite content (see
 * {@link digestSqliteFile}), and its `-wal`/`-shm` sidecars are skipped, so a
 * WAL checkpoint with no logical write does not read as a change. Returns an
 * empty snapshot for a root that does not exist yet.
 */
export function snapshotTree(root: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  if (!fs.existsSync(root)) return snapshot;
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) {
        snapshot.set(`${relative}/`, "directory");
        visit(absolute);
      } else if (entry.isFile()) {
        if (isSqliteSidecar(entry.name)) continue;
        if (path.extname(entry.name) === ".db") {
          snapshot.set(relative, `db:${digestSqliteFile(absolute)}`);
        } else {
          const bytes = fs.readFileSync(absolute);
          snapshot.set(relative, `${bytes.length}:${createHash("sha256").update(bytes).digest("hex")}`);
        }
      }
    }
  };
  visit(root);
  return snapshot;
}
