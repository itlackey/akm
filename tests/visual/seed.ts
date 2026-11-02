// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The visual-harness dataset. Every timestamp is written
 * explicitly and relative to FIXED_NOW, because SQLite's `datetime('now')`
 * default and `git commit` would otherwise stamp the real clock.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Proposal } from "../../src/commands/proposal/proposal-types";
import { appendEvent } from "../../src/core/events";
import { openStateDatabase } from "../../src/core/state-db";
import type { Database } from "../../src/storage/database";
import { recordImproveRun } from "../../src/storage/repositories/improve-runs-repository";
import { upsertProposal } from "../../src/storage/repositories/proposals-repository";
import { upsertTaskHistory } from "../../src/storage/repositories/task-history-repository";
import { FIXED_NOW, LONG_NAME, LONG_QUERY } from "./constants";

const NOW = Date.parse(FIXED_NOW);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BUNDLE = "stash";

const iso = (agoMs: number): string => new Date(NOW - agoMs).toISOString();
/** `usage_events.created_at` uses SQLite's `YYYY-MM-DD HH:MM:SS` spelling. */
const sqlTime = (agoMs: number): string => iso(agoMs).slice(0, 19).replace("T", " ");

/** A small seeded generator, so the dataset is the same on every machine. */
function prng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Stash content and git history ────────────────────────────────────────────

const DEPLOY_GUIDE = `---
description: How to deploy the service
tags: [deploy, runbook]
---
# Deploy guide

Run the deploy script from the release branch. See [[knowledge/rollback]] for the way back.

## Checklist

- Check that the build is green.
- Run \`./deploy.sh --env prod\`.
- Watch the dashboards for ten minutes.
`;

const ROLLBACK = `---
description: Roll back a bad deploy
---
# Rollback

Redeploy the previous tag, then open an incident note.
`;

const RELEASE_NOTES_COMMAND = `---
description: Draft release notes from merged pull requests
---
Draft release notes for \`$ARGUMENTS\`.

1. List the pull requests merged since the last tag.
2. Group them under Added, Changed and Fixed.
3. Keep each line to one sentence.
`;

const RG_LESSON = `---
description: Prefer ripgrep for repository search
when_to_use: Searching a repository for text
---

Prefer \`rg\` over \`grep -r\`: it skips ignored files and is faster.
`;

function runGit(cwd: string, args: string[], dateIso: string): void {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: dateIso,
      GIT_COMMITTER_DATE: dateIso,
      GIT_AUTHOR_NAME: "visual",
      GIT_AUTHOR_EMAIL: "visual@akm.invalid",
      GIT_COMMITTER_NAME: "visual",
      GIT_COMMITTER_EMAIL: "visual@akm.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

/** Write the stash files and six dated commits, one naming an accepted ref. */
export function seedStash(stashDir: string): void {
  const files: Array<[string, string, string]> = [
    ["knowledge/deploy-guide.md", DEPLOY_GUIDE, "akm save"],
    ["knowledge/rollback.md", ROLLBACK, "akm improve auto-sync"],
    ["commands/release-notes.md", RELEASE_NOTES_COMMAND, "akm save"],
    ["lessons/rg.md", RG_LESSON, `akm accept: reflect 3f9a1c20 ${BUNDLE}//lessons/rg`],
    ["knowledge/onboarding.md", "# Onboarding\n\nRequest access, clone the repo, run the setup script.\n", "akm save"],
    ["memories/standup.md", "Standup moved to 09:30.\n", "akm improve auto-sync"],
  ];
  commitFiles(stashDir, files);
}

/** One dated commit per file, the last one a day ago and each earlier one a day before it. */
function commitFiles(stashDir: string, files: Array<[string, string, string]>): void {
  runGit(stashDir, ["init", "-q", "-b", "main"], iso(30 * DAY));
  files.forEach(([file, body, subject], i) => {
    const target = path.join(stashDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
    const committedAt = iso((files.length - i) * DAY);
    fs.utimesSync(target, new Date(committedAt), new Date(committedAt));
    runGit(stashDir, ["add", file], committedAt);
    runGit(stashDir, ["commit", "-q", "-m", subject], committedAt);
  });
}

// ── usage_events ─────────────────────────────────────────────────────────────

const QUERIES = [
  "deploy script",
  "rollback steps",
  "release notes",
  "ripgrep flags",
  "standup time",
  "incident template",
  "on-call handoff",
  "database backup",
  "feature flags",
  "code review checklist",
];
const REPEAT_MISSES = ["kubernetes rollout", "terraform state lock", "oauth device flow"];
const BURST_QUERY = "flaky test quarantine";

interface UsageRow {
  eventType: string;
  query?: string | null;
  ref?: string | null;
  signal?: string | null;
  metadata?: Record<string, unknown>;
  source?: string;
  agoMs: number;
}

function insertUsage(db: Database, rows: UsageRow[]): void {
  const insert = db.prepare(
    "INSERT INTO usage_events (event_type, query, entry_ref, signal, metadata, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const row of rows) {
    insert.run(
      row.eventType,
      row.query ?? null,
      row.ref ?? null,
      row.signal ?? null,
      row.metadata ? JSON.stringify(row.metadata) : null,
      row.source ?? "user",
      sqlTime(row.agoMs),
    );
  }
}

function searchRows(): UsageRow[] {
  const random = prng(1319);
  const rows: UsageRow[] = [];
  for (let week = 0; week < 13; week++) {
    for (let i = 0; i < 40; i++) {
      const agoMs = week * 7 * DAY + Math.floor(random() * 6.5 * DAY) + 2 * HOUR;
      const missed = i % 17 === 8;
      rows.push({
        eventType: "search",
        query: missed ? `missing topic ${week}-${i}` : QUERIES[Math.floor(random() * QUERIES.length)],
        metadata: {
          resultCount: missed ? 0 : 1 + Math.floor(random() * 9),
          ...(i % 10 === 9 ? {} : { totalMs: 20 + Math.floor(random() * 180) }),
        },
        agoMs,
      });
    }
  }
  REPEAT_MISSES.forEach((query, i) => {
    for (const days of [2 + i, 9 + i]) {
      rows.push({ eventType: "search", query, metadata: { resultCount: 0, totalMs: 41 }, agoMs: days * DAY + HOUR });
    }
  });
  for (let i = 0; i < 8; i++) {
    rows.push({
      eventType: "search",
      query: BURST_QUERY,
      metadata: { resultCount: 0, totalMs: 37 },
      agoMs: 3 * DAY + (10 - i) * MINUTE,
    });
  }
  rows.push({
    eventType: "search",
    query: "improve internal",
    source: "improve",
    metadata: { resultCount: 3 },
    agoMs: HOUR,
  });
  return rows;
}

function showAndCurateRows(): UsageRow[] {
  const rows: UsageRow[] = [];
  for (let day = 0; day < 91; day++) {
    rows.push({
      eventType: "curate",
      query: "session start",
      metadata: { resultCount: 4, totalMs: 120 },
      agoMs: day * DAY + 8 * HOUR,
    });
  }
  for (let i = 0; i < 24; i++) {
    const ref = [`${BUNDLE}//knowledge/deploy-guide`, `${BUNDLE}//lessons/rg`, `${BUNDLE}//commands/release-notes`][
      i % 3
    ];
    rows.push({ eventType: "show", ref, agoMs: i * 2 * DAY + 3 * HOUR });
  }
  return rows;
}

function feedbackRows(): UsageRow[] {
  const guide = `${BUNDLE}//knowledge/deploy-guide`;
  const rows: UsageRow[] = [8, 15, 22, 30, 41, 57].map((days) => ({
    eventType: "feedback",
    ref: guide,
    signal: "positive",
    metadata: { reason: "Clear and complete" },
    agoMs: days * DAY,
  }));
  rows.push({
    eventType: "feedback",
    ref: guide,
    signal: "negative",
    metadata: { reason: "The rollback link is wrong" },
    agoMs: 2 * DAY,
  });
  rows.push({
    eventType: "feedback",
    ref: `${BUNDLE}//lessons/rg`,
    signal: "negative",
    metadata: { reason: "outdated flag" },
    agoMs: 4 * DAY,
  });
  return rows;
}

// ── proposals ────────────────────────────────────────────────────────────────

const stashTarget = (stashDir: string) => ({ source: BUNDLE, root: stashDir });

interface ProposalSpec {
  id: string;
  ref: string;
  source: string;
  status: Proposal["status"];
  createdAgoMs: number | null;
  body?: string;
  op?: "create" | "update" | "delete";
  extra?: Partial<Proposal>;
}

function buildProposal(stashDir: string, spec: ProposalSpec): Proposal {
  const body = spec.body ?? `${DEPLOY_GUIDE}\n- Announce the deploy in the team channel.\n`;
  const op = spec.op ?? "update";
  const createdAt = spec.createdAgoMs === null ? "unknown" : iso(spec.createdAgoMs);
  const file = `${spec.ref.split("//")[1]}.md`;
  return {
    id: spec.id,
    ref: spec.ref,
    status: spec.status,
    source: spec.source,
    sourceRun: "run-13",
    createdAt,
    updatedAt: spec.status === "pending" ? createdAt : iso((spec.createdAgoMs ?? DAY) - 20 * MINUTE),
    payload: { content: op === "delete" ? "" : body },
    changes: [{ path: file, op, ...(op === "delete" ? {} : { after: body }) }],
    proposedTarget: stashTarget(stashDir),
    confidence: 0.8,
    ...spec.extra,
  };
}

function decided(agoMs: number, outcome: "accepted" | "rejected", reason?: string) {
  return { outcome, decidedAt: iso(agoMs), ...(reason ? { reason } : {}) };
}

function gate(
  agoMs: number,
  outcome: "auto-accepted" | "staged" | "auto-rejected" | "deferred",
  reason: string,
  gateName: "triage" | "quality-gate" | "retention",
) {
  return { outcome, reason, gate: gateName, decidedAt: iso(agoMs), judgeReason: "The change is accurate and scoped." };
}

function proposalSpecs(): ProposalSpec[] {
  const guide = `${BUNDLE}//knowledge/deploy-guide`;
  const rollback = `${BUNDLE}//knowledge/rollback`;
  const rg = `${BUNDLE}//lessons/rg`;
  const release = `${BUNDLE}//commands/release-notes`;
  const retirement = {
    retiredRef: rollback,
    successorRef: guide,
    cosine: 0.93,
    judgeLabel: "subsumed" as const,
    judgeReason: "The deploy guide now covers every rollback step.",
    onlyInRetired: ["Open an incident note after a rollback"],
    onlyInSuccessor: [],
    retiredContentHash: "a".repeat(64),
    successorContentHash: "b".repeat(64),
    reason: "subsumed" as const,
    continuityRisk: {
      failingQueries: 2,
      ranks: [
        { query: "rollback steps", retiredRank: 1, successorRank: null },
        { query: "undo deploy", retiredRank: 3, successorRank: null },
      ],
    },
  };
  return [
    { id: "p-pending-reflect", ref: guide, source: "reflect", status: "pending", createdAgoMs: 3 * HOUR },
    {
      id: "p-pending-distill",
      ref: rg,
      source: "distill",
      status: "pending",
      createdAgoMs: 3 * DAY,
      body: `${RG_LESSON}\nAdd \`--hidden\` when the file is dotted.\n`,
    },
    {
      id: "p-pending-consolidate",
      ref: release,
      source: "consolidate",
      status: "pending",
      createdAgoMs: 20 * DAY,
      body: `${RELEASE_NOTES_COMMAND}4. Link each pull request.\n`,
    },
    {
      id: "p-pending-extract",
      ref: `${BUNDLE}//memories/standup`,
      source: "extract",
      status: "pending",
      createdAgoMs: 30 * HOUR,
      body: "Standup moved to 09:30. Retro is on Fridays.\n",
    },
    {
      id: "p-pending-feedback",
      ref: guide,
      source: "feedback",
      status: "pending",
      createdAgoMs: 2 * DAY,
      extra: { feedback: { reason: "The rollback link is wrong", source: "knowledge/rollback" } },
    },
    {
      id: "p-pending-unknown-age",
      ref: `${BUNDLE}//knowledge/onboarding`,
      source: "reflect",
      status: "pending",
      createdAgoMs: null,
      body: "# Onboarding\n\nRequest access, clone the repo, run the setup script.\nThen read the deploy guide.\n",
    },
    {
      id: "p-pending-create",
      ref: `${BUNDLE}//knowledge/incident-template`,
      source: "distill",
      status: "pending",
      createdAgoMs: 5 * HOUR,
      op: "create",
      body: "# Incident template\n\nWhat happened, impact, timeline, follow-ups.\n",
    },
    {
      id: "p-pending-retire",
      ref: rollback,
      source: "consolidate-pair",
      status: "pending",
      createdAgoMs: 4 * DAY,
      op: "delete",
      extra: { retirement, gateDecision: gate(4 * DAY, "deferred", "judgment-deferred", "triage") },
    },
    {
      id: "p-pending-reopened",
      ref: rg,
      source: "reflect",
      status: "pending",
      createdAgoMs: 12 * DAY,
      extra: {
        reviewHistory: [
          {
            review: decided(11 * DAY, "rejected", "too broad"),
            reopenedAt: iso(6 * HOUR),
            reopenReason: "scope is now narrower",
          },
        ],
      },
    },
    {
      id: "p-pending-noop",
      ref: rollback,
      source: "reflect",
      status: "pending",
      createdAgoMs: 2 * HOUR,
      body: ROLLBACK,
    },
    {
      id: "p-judge-accepted",
      ref: guide,
      source: "reflect",
      status: "accepted",
      createdAgoMs: 2 * DAY,
      extra: {
        gateDecision: gate(2 * DAY, "auto-accepted", "judgment-accept", "triage"),
        review: decided(2 * DAY, "accepted"),
      },
    },
    {
      id: "p-you-accepted",
      ref: release,
      source: "distill",
      status: "accepted",
      createdAgoMs: 3 * DAY,
      extra: { review: decided(2 * DAY, "accepted", "Good catch") },
    },
    {
      id: "p-staged-accepted",
      ref: rg,
      source: "consolidate",
      status: "accepted",
      createdAgoMs: 5 * DAY,
      extra: {
        gateDecision: gate(5 * DAY, "staged", "quality-judge", "quality-gate"),
        review: decided(4 * DAY, "accepted"),
      },
    },
    {
      id: "p-judge-rejected",
      ref: guide,
      source: "extract",
      status: "rejected",
      createdAgoMs: 6 * DAY,
      extra: {
        gateDecision: gate(6 * DAY, "auto-rejected", "judgment-reject", "triage"),
        review: decided(6 * DAY, "rejected"),
      },
    },
    {
      id: "p-you-rejected",
      ref: release,
      source: "reflect",
      status: "rejected",
      createdAgoMs: 7 * DAY,
      extra: { review: decided(6 * DAY, "rejected", "Not our wording") },
    },
    {
      id: "p-expired",
      ref: rollback,
      source: "reflect",
      status: "rejected",
      createdAgoMs: 40 * DAY,
      extra: {
        gateDecision: gate(10 * DAY, "auto-rejected", "expired", "retention"),
        review: decided(10 * DAY, "rejected", "expired"),
      },
    },
    ...["old-runbook", "old-notes", "stale-note"].map((name, i) => ({
      id: `p-retired-${name}`,
      ref: `${BUNDLE}//knowledge/${name}`,
      source: "consolidate-pair" as const,
      status: "accepted" as const,
      createdAgoMs: 3 * DAY,
      op: "delete" as const,
      extra: {
        retirement: { ...retirement, retiredRef: `${BUNDLE}//knowledge/${name}` },
        review: decided(2 * DAY + 5 * HOUR + 20 * MINUTE - i * 5 * MINUTE, "accepted"),
      },
    })),
    {
      id: "p-reverted",
      ref: guide,
      source: "distill",
      status: "reverted",
      createdAgoMs: 9 * DAY,
      extra: { review: decided(9 * DAY, "accepted") },
    },
  ];
}

function seedProposals(db: Database, stashDir: string): void {
  for (const spec of proposalSpecs()) upsertProposal(db, buildProposal(stashDir, spec), stashDir);
}

// ── improve runs, tasks, llm usage, index events ─────────────────────────────

function improveResult(index: number, ok: boolean, dryRun: boolean) {
  return {
    schemaVersion: 2,
    ok,
    dryRun,
    plannedRefs: [],
    scope: { mode: "all" },
    memorySummary: { eligible: 0, derived: 0 },
    strategy: "default",
    triage: { promoted: index % 3, rejected: index % 2, deferred: 1, failed: 0, skippedByCap: 0 },
    sync: { committed: ok, pushed: false, skipped: !ok },
    preRunSync: { committed: false, pushed: false, skipped: true, reason: "no remote" },
    usageReport: {
      byProcessEngineModel: [
        { process: "reflect", engine: "default", model: "chat-model", calls: 3 + (index % 4), failures: ok ? 0 : 3 },
        { process: "triage.judgment", engine: "default", model: "chat-model", calls: 2, failures: 0 },
      ],
      noCalls: [],
    },
  };
}

function seedImproveRuns(db: Database, stashDir: string): void {
  for (let i = 0; i < 14; i++) {
    const startedAgo = (13 - i) * DAY + 6 * HOUR;
    const failed = i === 4;
    const dryRun = i === 9;
    recordImproveRun(db, {
      id: `run-${i + 1}`,
      startedAt: iso(startedAgo),
      completedAt: iso(startedAgo - 4 * MINUTE),
      stashDir,
      dryRun,
      strategy: "default",
      scopeMode: "all",
      scopeValue: null,
      guidance: null,
      ok: !failed,
      // biome-ignore lint/suspicious/noExplicitAny: the persisted envelope is read back tolerantly, so a reduced fixture is enough
      result: improveResult(i, !failed, dryRun) as any,
    });
  }
}

function seedTasks(db: Database): void {
  const row = (taskId: string, status: string, startedAgo: number, completedAgo: number | null, failed: boolean) => ({
    task_id: taskId,
    status,
    started_at: iso(startedAgo),
    completed_at: completedAgo === null || failed ? null : iso(completedAgo),
    failed_at: failed && completedAgo !== null ? iso(completedAgo) : null,
    log_path: null,
    target_kind: "workflow",
    target_ref: `${BUNDLE}//commands/release-notes`,
    metadata_json: "{}",
  });
  upsertTaskHistory(db, row("nightly-improve", "failed", 26 * HOUR, 26 * HOUR - 3 * MINUTE, true));
  upsertTaskHistory(db, row("hourly-sync", "active", 8 * HOUR, null, false));
}

function seedLlmUsage(db: Database): void {
  const random = prng(576);
  for (let day = 0; day < 91; day++) {
    for (const [process, calls] of [
      ["reflect", 2],
      ["triage.judgment", 1],
    ] as const) {
      for (let call = 0; call < calls; call++) {
        const agoMs = day * DAY + (3 + call) * HOUR;
        // One week at 40% token coverage: the usage the provider did not report.
        const reported = day >= 14 && day < 21 ? random() < 0.4 : true;
        const promptTokens = 800 + Math.floor(random() * 600);
        const completionTokens = 150 + Math.floor(random() * 200);
        appendEvent(
          {
            eventType: "llm_usage",
            metadata: {
              process,
              engine: "default",
              model: "chat-model",
              durationMs: 900 + Math.floor(random() * 900),
              outcome: "ok",
              modelSource: "config",
              ...(reported ? { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens } : {}),
            },
          },
          { db, now: () => NOW - agoMs },
        );
      }
    }
  }
}

function seedIndexEvents(db: Database): void {
  // Indexing under the frozen clock logs its own zero-duration run; the seeded run replaces it.
  db.prepare("DELETE FROM events WHERE event_type = 'index_completed'").run();
  appendEvent(
    {
      eventType: "index_completed",
      metadata: { mode: "full", totalMs: 4200, walkMs: 800, llmMs: 0, embedMs: 0, ftsMs: 300, finalizeMs: 90 },
    },
    { db, now: () => NOW - 6 * DAY },
  );
}

/** Write the whole dataset. Run after the stash exists and before the server starts. */
export function seedVisualState(stashDir: string): void {
  const db = openStateDatabase();
  try {
    insertUsage(db, [...searchRows(), ...showAndCurateRows(), ...feedbackRows()]);
    seedProposals(db, stashDir);
    seedImproveRuns(db, stashDir);
    seedTasks(db);
    seedLlmUsage(db);
    seedIndexEvents(db);
  } finally {
    db.close();
  }
}

// ── Low-data and long-content variants ───────────────────────────

/** One note, one commit, and six searches on a single day. */
export function seedLowData(stashDir: string): void {
  commitFiles(stashDir, [["knowledge/onboarding.md", "# Onboarding\n\nRequest access, clone the repo.\n", "akm save"]]);
  const db = openStateDatabase();
  try {
    insertUsage(
      db,
      QUERIES.slice(0, 6).map((query, i) => ({
        eventType: "search",
        query,
        metadata: { resultCount: i === 5 ? 0 : 2, totalMs: 30 + i },
        agoMs: 2 * HOUR + i * MINUTE,
      })),
    );
  } finally {
    db.close();
  }
}

/** A path of 40 segments, each short enough to wrap on a phone. */
const DEEP_DIRS = Array.from({ length: 39 }, (_, i) => `level-${i + 1}`).join("/");

/** An 80-char ref, a 120-char query, a 6-digit count and a 40-segment path. */
export function seedLongContent(stashDir: string): void {
  commitFiles(stashDir, [
    [
      `knowledge/${LONG_NAME}.md`,
      `---\ndescription: ${LONG_QUERY}\n---\n# Long runbook\n\nEscalate early.\n`,
      "akm save",
    ],
    [`knowledge/${DEEP_DIRS}/deep.md`, "# Deep note\n\nBuried forty segments down.\n", "akm save"],
  ]);
  const db = openStateDatabase();
  try {
    db.exec("BEGIN");
    insertUsage(
      db,
      Array.from({ length: 123_456 }, (_, i) => ({
        eventType: "search",
        query: i % 2 === 0 ? LONG_QUERY : QUERIES[i % QUERIES.length],
        metadata: { resultCount: 1, totalMs: 25 },
        agoMs: (i % (60 * 24)) * MINUTE + HOUR,
      })),
    );
    db.exec("COMMIT");
    upsertProposal(
      db,
      buildProposal(stashDir, {
        id: "p-long-ref",
        ref: `${BUNDLE}//knowledge/${LONG_NAME}`,
        source: "reflect",
        status: "pending",
        createdAgoMs: 3 * HOUR,
      }),
      stashDir,
    );
  } finally {
    db.close();
  }
}
