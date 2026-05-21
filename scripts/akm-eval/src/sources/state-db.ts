/**
 * Read-only SQLite reader for akm's `state.db`.
 *
 * Schema reference: `src/core/state-db.ts` in this repo. Indexed columns:
 *
 *   events:    id INTEGER PK, event_type TEXT, ts TEXT, ref TEXT, metadata_json TEXT
 *   proposals: id TEXT PK, stash_dir TEXT, ref TEXT, status TEXT, source TEXT,
 *              created_at TEXT, updated_at TEXT, content TEXT, frontmatter_json TEXT,
 *              metadata_json TEXT
 *
 * The toolkit only reads. It never writes.
 */

import { Database } from "bun:sqlite";
import fs from "node:fs";
import { resolveStateDbPath } from "./paths";

export interface EventRow {
  id: number;
  eventType: string;
  ts: string;
  ref?: string;
  metadata: Record<string, unknown>;
}

export interface ProposalRow {
  id: string;
  stashDir: string;
  ref: string;
  status: "pending" | "accepted" | "rejected" | "reverted";
  source: string;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface ReadEventsOptions {
  types?: string[];
  ref?: string;
  refs?: string[];
  since?: string;
  until?: string;
  limit?: number;
}

export interface ReadProposalsOptions {
  status?: ProposalRow["status"];
  ref?: string;
  source?: string;
  stashDir?: string;
  since?: string;
  limit?: number;
}

function safeJson(s: string | null | undefined): Record<string, unknown> {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class StateDbSources {
  private db: Database | null = null;
  private readonly path: string;

  constructor(dbPath?: string) {
    this.path = dbPath ?? resolveStateDbPath();
  }

  available(): boolean {
    return fs.existsSync(this.path);
  }

  private open(): Database {
    if (this.db) return this.db;
    this.db = new Database(this.path, { readonly: true });
    return this.db;
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // ignore
    }
    this.db = null;
  }

  readEvents(opts: ReadEventsOptions = {}): EventRow[] {
    if (!this.available()) return [];
    const db = this.open();
    const where: string[] = [];
    const params: Record<string, string | number> = {};
    if (opts.types && opts.types.length > 0) {
      const placeholders = opts.types.map((_, i) => `$type${i}`).join(",");
      where.push(`event_type IN (${placeholders})`);
      opts.types.forEach((t, i) => {
        params[`$type${i}`] = t;
      });
    }
    if (opts.ref) {
      where.push("ref = $ref");
      params.$ref = opts.ref;
    } else if (opts.refs && opts.refs.length > 0) {
      const placeholders = opts.refs.map((_, i) => `$ref${i}`).join(",");
      where.push(`ref IN (${placeholders})`);
      opts.refs.forEach((r, i) => {
        params[`$ref${i}`] = r;
      });
    }
    if (opts.since) {
      where.push("ts >= $since");
      params.$since = opts.since;
    }
    if (opts.until) {
      where.push("ts <= $until");
      params.$until = opts.until;
    }
    const sql = `SELECT id, event_type, ts, ref, metadata_json
                 FROM events
                 ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
                 ORDER BY id ASC
                 ${opts.limit ? `LIMIT ${Number(opts.limit)}` : ""}`;
    const rows = db.query(sql).all(params) as Array<{
      id: number;
      event_type: string;
      ts: string;
      ref: string | null;
      metadata_json: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      eventType: r.event_type,
      ts: r.ts,
      ref: r.ref ?? undefined,
      metadata: safeJson(r.metadata_json),
    }));
  }

  readProposals(opts: ReadProposalsOptions = {}): ProposalRow[] {
    if (!this.available()) return [];
    const db = this.open();
    const where: string[] = [];
    const params: Record<string, string | number> = {};
    if (opts.status) {
      where.push("status = $status");
      params.$status = opts.status;
    }
    if (opts.ref) {
      where.push("ref = $ref");
      params.$ref = opts.ref;
    }
    if (opts.source) {
      where.push("source = $source");
      params.$source = opts.source;
    }
    if (opts.stashDir) {
      where.push("stash_dir = $stashDir");
      params.$stashDir = opts.stashDir;
    }
    if (opts.since) {
      where.push("created_at >= $since");
      params.$since = opts.since;
    }
    const sql = `SELECT id, stash_dir, ref, status, source, created_at, updated_at, metadata_json
                 FROM proposals
                 ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
                 ORDER BY created_at ASC
                 ${opts.limit ? `LIMIT ${Number(opts.limit)}` : ""}`;
    const rows = db.query(sql).all(params) as Array<{
      id: string;
      stash_dir: string;
      ref: string;
      status: ProposalRow["status"];
      source: string;
      created_at: string;
      updated_at: string;
      metadata_json: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      stashDir: r.stash_dir,
      ref: r.ref,
      status: r.status,
      source: r.source,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      metadata: safeJson(r.metadata_json),
    }));
  }
}
