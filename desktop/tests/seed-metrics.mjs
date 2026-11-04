// Synthetic stored history, using the same repository functions and row shapes
// as AKM's own UI integration tests. Never import AKM before asserting isolation.
import assert from "node:assert/strict";
import path from "node:path";
const root = process.env.AKM_DESKTOP_TEST_ROOT;
assert.ok(root && path.basename(root).startsWith("akm-desktop-fixture-"));
assert.equal(process.env.AKM_BUNDLE_DIR, path.join(root, "personal"));
assert.equal(process.env.AKM_DATA_DIR, path.join(root, "data"));
await import("akm-cli/workspace");
const { openStateDatabase } = await import("akm-cli/dist/core/state-db.js");
const { appendEvent } = await import("akm-cli/dist/core/events.js");
const { upsertTaskHistory } = await import("akm-cli/dist/storage/repositories/task-history-repository.js");
const { recordImproveRun } = await import("akm-cli/dist/storage/repositories/improve-runs-repository.js");
const { createProposal } = await import("akm-cli/dist/commands/proposal/repository.js");
const { upsertProposal } = await import("akm-cli/dist/storage/repositories/proposals-repository.js");
const db = openStateDatabase();
const day = 86_400_000,
  now = Date.now() - 60000;
const at = (daysAgo) => new Date(now - daysAgo * day).toISOString();
// usage_events uses SQLite timestamps; proposal/task repositories use ISO.
const eventAt = (daysAgo) =>
  at(daysAgo)
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
try {
  const insert = db.prepare(
    "INSERT INTO usage_events (event_type, query, entry_ref, signal, metadata, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (let d = 0; d < 84; d++) {
    for (let n = 0; n < 4; n++) {
      insert.run(
        "search",
        n === 0 ? "missing restore steps" : "backup",
        null,
        null,
        JSON.stringify({ resultCount: n === 0 && d % 3 === 0 ? 0 : 3, totalMs: 12 + (d % 7) + n }),
        "user",
        eventAt(d),
      );
    }
    insert.run("show", null, "personal//knowledge/restore-laptop", null, null, "user", eventAt(d));
    if (d % 5 === 0)
      insert.run(
        "feedback",
        null,
        "personal//knowledge/restore-laptop",
        d % 10 === 0 ? "negative" : "positive",
        JSON.stringify({ reason: "Synthetic review evidence", tags: ["clarity"] }),
        "user",
        eventAt(d),
      );
    if (d % 7 === 0) {
      appendEvent(
        {
          eventType: "llm_usage",
          metadata: {
            stage: "reflect",
            process: "reflect",
            engine: "synthetic",
            model: "fixture-small",
            outcome: "success",
            durationMs: 1250,
            promptTokens: 700,
            completionTokens: 240,
            totalTokens: 940,
          },
        },
        { db, now: () => now - d * day },
      );
      appendEvent(
        {
          eventType: "llm_usage",
          metadata: {
            stage: "triage",
            process: "triage.judgment",
            engine: "synthetic",
            model: "fixture-judge",
            outcome: "error",
            durationMs: 500,
          },
        },
        { db, now: () => now - d * day },
      );
      appendEvent(
        {
          eventType: "index_completed",
          metadata: {
            mode: "incremental",
            totalEntries: 200 - d,
            totalMs: 220,
            walkMs: 50,
            llmMs: 0,
            embedMs: 0,
            ftsMs: 150,
            finalizeMs: 20,
          },
        },
        { db, now: () => now - d * day },
      );
    }
  }
  for (const [i, status, decidedBy] of [
    [0, "accepted", "human"],
    [1, "accepted", "triage"],
    [2, "accepted", undefined],
    [3, "rejected", "human"],
    [4, "reverted", "triage"],
  ]) {
    const proposal = createProposal(process.env.AKM_BUNDLE_DIR, {
      ref: "personal//knowledge/restore-laptop",
      source: i % 2 ? "reflect" : "feedback",
      sourceRun: "synthetic-metrics",
      payload: { content: "# Restore a laptop\n\nSynthetic proposal history only.\n" },
    });
    // Stored observations only: no accept operation or content mutation is run.
    upsertProposal(
      db,
      {
        ...proposal,
        createdAt: at(30 + i * 7),
        updatedAt: at(i * 7 + 2),
        status,
        review: {
          outcome: status === "accepted" ? "accepted" : "rejected",
          decidedAt: at(i * 7 + 3),
          ...(decidedBy ? { decidedBy } : {}),
        },
      },
      process.env.AKM_BUNDLE_DIR,
    );
  }
  for (let i = 0; i < 8; i++) {
    const failed = i === 2;
    upsertTaskHistory(db, {
      task_id: failed ? "synthetic-failure" : "synthetic-review",
      status: failed ? "failed" : "completed",
      started_at: at(i / 2),
      completed_at: failed ? null : at(i / 2 - 0.001),
      failed_at: failed ? at(i / 2 - 0.001) : null,
      log_path: null,
      target_kind: "agent",
      target_ref: "personal//agents/recovery-reviewer",
      metadata_json: JSON.stringify({
        metadataVersion: 2,
        durationMs: failed ? 60000 : 1400,
        detail: failed
          ? { reason: "timeout", error: "Synthetic timeout: no network request was made.", exitCode: 1 }
          : null,
      }),
    });
  }
  for (let i = 0; i < 3; i++)
    recordImproveRun(db, {
      id: `synthetic-improve-${i}`,
      startedAt: at(i),
      completedAt: at(i - 0.001),
      stashDir: process.env.AKM_BUNDLE_DIR,
      dryRun: false,
      strategy: "default",
      scopeMode: "all",
      scopeValue: null,
      guidance: null,
      ok: i !== 1,
      result: {
        schemaVersion: 2,
        ok: i !== 1,
        dryRun: false,
        plannedRefs: ["personal//knowledge/restore-laptop"],
        scope: { mode: "all" },
        strategy: "default",
        actions: [],
        memorySummary: { eligible: 0, derived: 0 },
        triage: { promoted: 2, rejected: 1, deferred: 0, failed: i === 1 ? 1 : 0, skippedByCap: 0 },
        sync: { committed: false, pushed: false, skipped: true, reason: "Synthetic fixture" },
        usageReport: {
          byProcessEngineModel: [
            { process: "reflect", engine: "synthetic", model: "fixture-small", calls: 3, failures: 0 },
          ],
          noCalls: [],
        },
      },
    });
} finally {
  db.close();
}
console.log("Synthetic metric history seeded.");
