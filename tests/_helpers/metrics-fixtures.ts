import type { ImproveResultEnvelope } from "../../src/core/improve-result";
import type { Database } from "../../src/storage/database";
import { insertEvent } from "../../src/storage/repositories/events-repository";
import { recordImproveRun } from "../../src/storage/repositories/improve-runs-repository";

/** `YYYY-MM-DD` shifted by `days` (UTC). */
export function dayPlus(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function insertUsage(
  db: Database,
  row: {
    day: string;
    time?: string;
    type: "search" | "show" | "curate" | "feedback";
    ref?: string;
    query?: string;
    signal?: "positive" | "negative";
    source?: string;
    metadata?: Record<string, unknown>;
  },
): void {
  db.prepare(
    `INSERT INTO usage_events (event_type, query, entry_ref, signal, metadata, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.type,
    row.query ?? null,
    row.ref ?? null,
    row.signal ?? null,
    row.metadata ? JSON.stringify(row.metadata) : null,
    row.source ?? "user",
    `${row.day} ${row.time ?? "10:00:00"}`,
  );
}

export function insertLlm(
  db: Database,
  day: string,
  record: { durationMs: number; stage?: string; model?: string; promptTokens?: number; outcome?: "success" | "error" },
): void {
  insertEvent(db, {
    eventType: "llm_usage",
    ts: `${day}T09:00:00.000Z`,
    metadata: { outcome: "success", process: "reflect", engine: "e1", ...record },
  });
}

/** A recorded improve run on `day` carrying a persisted ref list, so the slimming is visible. */
export function insertRun(db: Database, id: string, day: string, opts: { refs?: number; dryRun?: boolean } = {}): void {
  const refs = Array.from({ length: opts.refs ?? 3 }, (_, i) => ({ ref: `knowledge/r${i}`, reason: "x" }));
  recordImproveRun(db, {
    id,
    startedAt: `${day}T08:00:00.000Z`,
    completedAt: `${day}T08:05:00.000Z`,
    stashDir: "/s",
    dryRun: opts.dryRun ?? false,
    strategy: "default",
    scopeMode: "all",
    scopeValue: null,
    guidance: null,
    ok: true,
    result: {
      schemaVersion: 2,
      ok: true,
      strategy: "default",
      scope: { mode: "all" },
      dryRun: opts.dryRun ?? false,
      memorySummary: { eligible: 0, derived: 0 },
      plannedRefs: [],
      actions: [],
      strategyFilteredRefs: refs,
    } as unknown as ImproveResultEnvelope,
  });
}

export function count(db: Database, table: string, where = "1=1"): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
}
