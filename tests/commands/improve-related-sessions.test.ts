// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #627 — getRelatedSessions helper (RED — feature not yet implemented).
 *
 * Modeled on recombine.ts buildRelatednessClusters: relatedness is computed
 * from SHARED TAGS / GRAPH ENTITIES — NEVER embedding similarity. Two sessions
 * relate when they share at least one *topic* tag or graph entity; two
 * textually near-identical sessions with no shared topic signal do NOT relate.
 *
 * The generic base tags every session asset carries (`session` + the harness
 * id, see session-asset.ts:235) must be IGNORED for relatedness — otherwise
 * every session would trivially relate to every other.
 *
 * Planned API (does not exist yet — the import is the RED seam):
 *   getRelatedSessions(opts: {
 *     seedTags?: string[];
 *     seedEntities?: string[];
 *     db?: Database;
 *     minShared?: number;     // default 1
 *     limit?: number;         // default 5
 *     relatednessSource?: "tags" | "graph" | "both";
 *     excludeRefs?: string[];
 *   }): RelatedSession[]   // [{ ref, name, sharedCount }], sorted desc by sharedCount
 *
 * Tests use a sandbox + real index, inject the index DB, never touch host
 * state, and make NO network/embedding calls.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
// NOTE: this module does not exist yet — the RED import is intentional.
import { getRelatedSessions } from "../../src/commands/improve/related-sessions";
import { closeDatabase, getAllEntries, openExistingDatabase } from "../../src/indexer/db/db";
import { akmIndex } from "../../src/indexer/indexer";
import { insertGraphEntities } from "../_helpers/graph-store";
import { withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

const TIMEOUT_MS = 20_000;
const cleanups: Array<() => void> = [];

function isolatedStash(): string {
  const iso = withIsolatedAkmStorage();
  cleanups.push(iso.cleanup);
  return iso.stashDir;
}

/**
 * Write a session asset under sessions/<harness>/<id>.md. Every session carries
 * the generic base tags `session` + the harness id PLUS any supplied topic
 * tags (mirrors session-asset.ts).
 */
function writeSession(stashDir: string, harness: string, id: string, topicTags: string[], body: string): string {
  const filePath = path.join(stashDir, "sessions", harness, `${id}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const allTags = ["session", harness, ...topicTags];
  const tagsYaml = `tags: [${allTags.map((t) => JSON.stringify(t)).join(", ")}]`;
  fs.writeFileSync(filePath, `---\ndescription: ${id} summary.\n${tagsYaml}\n---\n\n${body}\n`, "utf8");
  return `session:${harness}/${id}`;
}

/** Write a non-session asset that shares a topic tag (must never be returned). */
function writeMemory(stashDir: string, name: string, tags: string[], body: string): void {
  const filePath = path.join(stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tagsYaml = tags.length ? `tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]\n` : "";
  fs.writeFileSync(filePath, `---\ndescription: ${name}\n${tagsYaml}---\n\n${body}\n`, "utf8");
}

async function buildIndex(stashDir: string): Promise<void> {
  writeSandboxConfig({ semanticSearchMode: "off" });
  await akmIndex({ stashDir, full: true });
}

/**
 * Insert raw graph entities for a file (simulates graph extraction).
 *
 * #624-P1: graph rows are keyed on (stash_root, file_path, body_hash), NOT
 * entry_id. getEntitiesByEntryIds resolves entry id -> graph rows by JOINing
 * entries(stash_dir, file_path) -> graph_files, so the file_path here must
 * match the indexed entries row's file_path. entryId is retained in the
 * signature (callers pass it) only to derive a stable file_order/body_hash.
 */
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

// ── AC5a: tag-based relatedness, ranking, seed/non-session exclusion ─────────

describe("#627 getRelatedSessions — tag relatedness (AC5a)", () => {
  test(
    "returns sessions sharing >=1 topic tag, ranked by shared-tag count, excludes seed + non-session types",
    async () => {
      const stash = isolatedStash();
      // Seed session carries topic tags [auth, oauth].
      const seedRef = writeSession(stash, "claude", "seed", ["auth", "oauth"], "Seed session about auth.");
      // Shares BOTH auth + oauth → highest rank.
      const bothRef = writeSession(stash, "claude", "both", ["auth", "oauth"], "Token refresh design.");
      // Shares ONLY auth → lower rank.
      const oneRef = writeSession(stash, "claude", "one", ["auth"], "MFA escalation rules.");
      // Shares NO topic tag → not related.
      writeSession(stash, "claude", "none", ["billing"], "Invoice scheduling.");
      // A memory sharing the auth tag — must NOT be returned (sessions only).
      writeMemory(stash, "auth-memory", ["auth"], "Memory about auth.");
      await buildIndex(stash);

      const related = getRelatedSessions({
        seedTags: ["auth", "oauth"],
        relatednessSource: "tags",
        excludeRefs: [seedRef],
        minShared: 1,
        limit: 5,
      });

      const refs = related.map((r) => r.ref);
      // Both-tag session ranks above single-tag session.
      expect(refs[0]).toBe(bothRef);
      expect(refs).toContain(oneRef);
      // Seed itself excluded.
      expect(refs).not.toContain(seedRef);
      // No-shared-tag session excluded.
      expect(refs.some((r) => r.endsWith("/none"))).toBe(false);
      // No non-session asset returned.
      expect(refs.every((r) => r.startsWith("session:"))).toBe(true);
    },
    TIMEOUT_MS,
  );

  test(
    "generic base tags (`session`, harness id) do NOT create relatedness",
    async () => {
      const stash = isolatedStash();
      // Two sessions with NO topic tags — they share only `session` + `claude`.
      writeSession(stash, "claude", "a", [], "Some session A.");
      const bRef = writeSession(stash, "claude", "b", [], "Some session B.");
      await buildIndex(stash);

      // Seeding on the generic base tags must NOT relate every session.
      const related = getRelatedSessions({
        seedTags: ["session", "claude"],
        relatednessSource: "tags",
        excludeRefs: [],
        minShared: 1,
      });
      expect(related.map((r) => r.ref)).not.toContain(bRef);
    },
    TIMEOUT_MS,
  );
});

// ── AC5b: relatedness is signal-based, NOT embedding similarity ──────────────

describe("#627 getRelatedSessions — relatedness not similarity (AC5b)", () => {
  test(
    "textually DIFFERENT sessions sharing a tag relate; textually SIMILAR sessions with no shared signal do NOT",
    async () => {
      const stash = isolatedStash();
      // Two textually dissimilar bodies sharing topic tag `deploy`.
      const seedRef = writeSession(stash, "claude", "seed", ["deploy"], "Rolling restart of the API tier.");
      const relRef = writeSession(stash, "claude", "rel", ["deploy"], "The teal footer accent on the marketing site.");
      // Two near-identical bodies with NO shared topic tag.
      writeSession(stash, "claude", "dup1", ["topicX"], "The build script copies artifacts then restarts the service.");
      writeSession(
        stash,
        "claude",
        "dup2",
        ["topicY"],
        "The build script copies artifacts then restarts the service now.",
      );
      await buildIndex(stash);

      const related = getRelatedSessions({
        seedTags: ["deploy"],
        relatednessSource: "tags",
        excludeRefs: [seedRef],
        minShared: 1,
      });
      const refs = related.map((r) => r.ref);
      // Dissimilar-but-tag-sharing session relates.
      expect(refs).toContain(relRef);
      // Textually-similar but no-shared-signal sessions do NOT relate.
      expect(refs.some((r) => r.endsWith("/dup1") || r.endsWith("/dup2"))).toBe(false);
    },
    TIMEOUT_MS,
  );

  test(
    "graph-entity relatedness: sessions sharing an entity_norm cluster (relatednessSource:'graph')",
    async () => {
      const stash = isolatedStash();
      const seedRef = writeSession(stash, "claude", "seed", [], "Seed about the payment gateway.");
      const relRef = writeSession(stash, "claude", "rel", [], "Different prose entirely.");
      writeSession(stash, "claude", "other", [], "Unrelated content about caching.");
      await buildIndex(stash);

      // Attach graph entities directly to the indexed entries.
      const db = openExistingDatabase();
      try {
        const sessions = getAllEntries(db, "session");
        const byName = new Map(sessions.map((s) => [s.entry.name, s]));
        const stashRoot = sessions[0]?.stashDir ?? stash;
        const seed = byName.get("claude/seed");
        const rel = byName.get("claude/rel");
        const other = byName.get("claude/other");
        if (seed) insertGraphEntities(db, seed.id, stashRoot, seed.filePath, ["PaymentGateway"], "session");
        if (rel) insertGraphEntities(db, rel.id, stashRoot, rel.filePath, ["PaymentGateway"], "session");
        if (other) insertGraphEntities(db, other.id, stashRoot, other.filePath, ["Cache"], "session");
      } finally {
        closeDatabase(db);
      }

      const related = getRelatedSessions({
        seedEntities: ["paymentgateway"],
        relatednessSource: "graph",
        excludeRefs: [seedRef],
        minShared: 1,
      });
      const refs = related.map((r) => r.ref);
      expect(refs).toContain(relRef);
      expect(refs.some((r) => r.endsWith("/other"))).toBe(false);
    },
    TIMEOUT_MS,
  );
});

// ── AC5c: fail-open + empty-input ────────────────────────────────────────────

describe("#627 getRelatedSessions — fail open (AC5c)", () => {
  test(
    "empty graph table with relatednessSource:'graph' falls back to tags without throwing",
    async () => {
      const stash = isolatedStash();
      const seedRef = writeSession(stash, "claude", "seed", ["auth"], "Seed about auth.");
      const relRef = writeSession(stash, "claude", "rel", ["auth"], "Another auth session.");
      await buildIndex(stash);

      // No graph_file_entities rows exist → must fail open to tag relatedness.
      let related: ReturnType<typeof getRelatedSessions> = [];
      expect(() => {
        related = getRelatedSessions({
          seedTags: ["auth"],
          relatednessSource: "graph",
          excludeRefs: [seedRef],
          minShared: 1,
        });
      }).not.toThrow();
      expect(related.map((r) => r.ref)).toContain(relRef);
    },
    TIMEOUT_MS,
  );

  test(
    "empty seed input returns []",
    async () => {
      const stash = isolatedStash();
      writeSession(stash, "claude", "a", ["auth"], "Session A.");
      await buildIndex(stash);

      const related = getRelatedSessions({ seedTags: [], seedEntities: [], relatednessSource: "tags" });
      expect(related).toEqual([]);
    },
    TIMEOUT_MS,
  );
});
