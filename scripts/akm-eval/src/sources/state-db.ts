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
 *
 * Phase 6: `RecordingStateDbSources` wraps a live reader and captures every
 * `readEvents` / `readProposals` call (inputs and outputs) into a
 * `ReplayRecorder`. `PlaybackStateDbSources` is the symmetric replay path:
 * it returns previously-captured rows in FIFO order without touching disk.
 * Use `makeStateDbSources()` from `src/run.ts` and `src/replay.ts` so the
 * choice is one line and the runners stay variant-agnostic.
 */

import { Database } from "bun:sqlite";
import fs from "node:fs";
import { resolveStateDbPath } from "./paths";
import {
  getCurrentPlayer,
  getCurrentRecorder,
  ReplayDivergenceError,
  type ReplayPlayer,
  type ReplayRecorder,
} from "./replay-log";

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

/**
 * Shared interface that runners use. Both the live `StateDbSources` and the
 * Phase 6 wrappers below conform to it; runners only need `readEvents`,
 * `readProposals`, `available`, and `close`.
 */
export interface StateDbReader {
  available(): boolean;
  readEvents(opts?: ReadEventsOptions): EventRow[];
  readProposals(opts?: ReadProposalsOptions): ProposalRow[];
  close(): void;
}

/**
 * Records every query (inputs + outputs) into a `ReplayRecorder` while
 * still delegating to the live SQLite reader. Behaviour is otherwise
 * identical to `StateDbSources`.
 */
export class RecordingStateDbSources implements StateDbReader {
  private availableRecorded = false;

  constructor(
    private readonly inner: StateDbSources,
    private readonly recorder: ReplayRecorder,
  ) {}

  available(): boolean {
    const result = this.inner.available();
    // Record on first call so the player can return the same answer and the
    // runner picks the same branch (state-db vs stash-fs fallback). Only
    // recorded once per source — `available()` is a pure existence check
    // on a path that doesn't change during a run.
    if (!this.availableRecorded) {
      this.recorder.recordStateDbAvailable(result);
      this.availableRecorded = true;
    }
    return result;
  }

  close(): void {
    this.inner.close();
  }

  readEvents(opts: ReadEventsOptions = {}): EventRow[] {
    const result = this.inner.readEvents(opts);
    this.recorder.recordStateDbEvents(optsToPlain(opts), result);
    return result;
  }

  readProposals(opts: ReadProposalsOptions = {}): ProposalRow[] {
    const result = this.inner.readProposals(opts);
    this.recorder.recordStateDbProposals(optsToPlain(opts), result);
    return result;
  }
}

/**
 * Returns recorded rows in FIFO order; never opens a database. The Phase 6
 * `available()` contract is "true" so runners that gate on it (proposal-
 * quality, workflow-compliance) take the same code path as in the live
 * run that produced the recording.
 */
export class PlaybackStateDbSources implements StateDbReader {
  constructor(private readonly player: ReplayPlayer) {}

  available(): boolean {
    return this.player.nextStateDbAvailable();
  }

  close(): void {
    // no-op
  }

  readEvents(opts: ReadEventsOptions = {}): EventRow[] {
    return this.player.nextStateDbEvents(optsToPlain(opts)) as EventRow[];
  }

  readProposals(opts: ReadProposalsOptions = {}): ProposalRow[] {
    return this.player.nextStateDbProposals(optsToPlain(opts)) as ProposalRow[];
  }
}

export interface MakeStateDbOptions {
  /** Override the database path (live mode only). */
  dbPath?: string;
  /**
   * Opt into the process-level recording/playback singletons in
   * `replay-log.ts`. See `MakeAkmCliOptions.record` for the same semantics.
   */
  record?: boolean;
  /** Explicit override; bypasses the process singleton. */
  recorder?: ReplayRecorder;
  /** Explicit override; bypasses the process singleton. */
  player?: ReplayPlayer;
}

/**
 * Single factory used by `src/run.ts`, `src/replay.ts`, and every runner
 * that needs `state.db` access. The default returns a plain live reader,
 * preserving the pre-Phase-6 behaviour.
 */
export function makeStateDbSources(opts: MakeStateDbOptions = {}): StateDbReader {
  const player = opts.player ?? (opts.record ? getCurrentPlayer() : undefined);
  const recorder = opts.recorder ?? (opts.record ? getCurrentRecorder() : undefined);
  if (recorder && player) {
    throw new Error("makeStateDbSources: cannot record and play back simultaneously");
  }
  if (player) return new PlaybackStateDbSources(player);
  const live = new StateDbSources(opts.dbPath);
  if (recorder) return new RecordingStateDbSources(live, recorder);
  return live;
}

/**
 * Normalise an options bag for recording. We strip `undefined` values so the
 * recorded JSON matches what the replay player sees when the same options
 * are passed back in — `JSON.stringify` already drops `undefined`, but the
 * deep-equal we do on replay would distinguish `{ ref: undefined }` from
 * `{}`. Explicit normalisation makes that invariant defensive.
 */
function optsToPlain(opts: ReadEventsOptions | ReadProposalsOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(opts as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

export { ReplayDivergenceError };
