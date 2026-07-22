// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #627 — default search/curate excludes `session` assets via config.search.defaultExcludeTypes.
 *
 * Session assets are a first-class indexed `entry_type` (so search can find
 * them when explicitly requested), but they pollute the DEFAULT untyped
 * `akm search` / `akm curate` results. #627 adds a pure query-layer policy:
 *
 *   - `config.search.defaultExcludeTypes` (default applied as ['session'] when
 *     the key is ABSENT; explicit `[]` disables = pre-#627 behavior).
 *   - The exclusion only applies on the untyped ('any') path. An explicit
 *     `--type session` bypasses it.
 *   - `akmSearch({ includeSessions: true })` re-includes sessions on the
 *     otherwise-default path.
 *
 * Verifies `akmSearch` / `akmCurate` exclude `session` assets by default (via
 * `config.search.defaultExcludeTypes`) and re-include them on request.
 *
 * Tests use `withIsolatedAkmStorage` + a real index, never touch host state.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmCurate } from "../../../src/commands/read/curate";
import { akmSearch } from "../../../src/commands/read/search";
import { akmIndex } from "../../../src/indexer/indexer";
import type { SearchResponse, SourceSearchHit } from "../../../src/sources/types";
import { withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

/** Stash (non-registry) hits — the local-search path only ever returns these. */
function stashHits(res: SearchResponse): SourceSearchHit[] {
  return res.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
}
function hitRefs(res: SearchResponse): string[] {
  return stashHits(res).map((h) => h.ref);
}
function hitTypes(res: SearchResponse): string[] {
  return stashHits(res).map((h) => h.type);
}

const TIMEOUT_MS = 20_000;
const cleanups: Array<() => void> = [];

function isolatedStash(): string {
  const iso = withIsolatedAkmStorage();
  cleanups.push(iso.cleanup);
  return iso.stashDir;
}

/** A unique-ish token all seeded assets share, so one query matches all. */
const TOKEN = "widgetflux";

/** Write a skill asset whose body matches TOKEN. */
function writeSkill(stashDir: string, name: string): void {
  const filePath = path.join(stashDir, "skills", name, "SKILL.md");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `---\nname: ${name}\ndescription: A skill about ${TOKEN} handling.\n---\n\n# ${name}\n\nThis skill explains ${TOKEN} workflows.\n`,
    "utf8",
  );
}

/** Write a memory asset whose body matches TOKEN. */
function writeMemory(stashDir: string, name: string): void {
  const filePath = path.join(stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `---\ndescription: A memory about ${TOKEN} state.\ntags: ["${TOKEN}"]\n---\n\nThe ${TOKEN} subsystem remembers prior runs.\n`,
    "utf8",
  );
}

/** Write a session asset (sessions/<harness>/<id>.md) whose body matches TOKEN. */
function writeSession(stashDir: string, harness: string, id: string): string {
  const filePath = path.join(stashDir, "sessions", harness, `${id}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `---\ndescription: Session summary touching ${TOKEN}.\ntags: ["session", "${harness}", "${TOKEN}"]\n---\n\nDuring this session we debugged the ${TOKEN} pipeline.\n`,
    "utf8",
  );
  // Canonical ref shape (F4b): the 0.9.0 conceptId spelling sessions/<harness>/<id>.
  return `sessions/${harness}/${id}`;
}

async function buildIndex(stashDir: string): Promise<void> {
  await akmIndex({ stashDir, full: true });
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

// ── AC1b: default search excludes session assets ────────────────────────────

describe("#627 default search excludes sessions (AC1b)", () => {
  test(
    "config.search.defaultExcludeTypes=['session'] → default query returns zero session hits",
    async () => {
      const stash = isolatedStash();
      writeSkill(stash, "flux-skill");
      writeMemory(stash, "flux-memory");
      const sessionRef = writeSession(stash, "claude", "sess-aaa");
      writeSandboxConfig({ semanticSearchMode: "off", search: { defaultExcludeTypes: ["session"] } });
      await buildIndex(stash);

      const res = await akmSearch({ query: TOKEN });
      const types = hitTypes(res);
      const refs = hitRefs(res);

      // Non-session types still returned.
      expect(types).toContain("skill");
      expect(types).toContain("memory");
      // Session excluded from the default path.
      expect(types).not.toContain("session");
      expect(refs).not.toContain(sessionRef);
    },
    TIMEOUT_MS,
  );
});

// ── AC1c: curate inherits the exclusion ─────────────────────────────────────

describe("#627 curate inherits session exclusion (AC1c)", () => {
  test(
    "akmCurate default query yields no session items but still returns non-session types",
    async () => {
      const stash = isolatedStash();
      writeSkill(stash, "flux-skill");
      writeMemory(stash, "flux-memory");
      writeSession(stash, "claude", "sess-bbb");
      writeSandboxConfig({ semanticSearchMode: "off", search: { defaultExcludeTypes: ["session"] } });
      await buildIndex(stash);

      const res = await akmCurate({ query: TOKEN });
      const stashItems = res.items.filter((i) => i.source === "stash");
      const types = stashItems.map((i) => i.type);

      expect(types).not.toContain("session");
      // Regression: non-session assets still curated.
      expect(types.some((t) => t === "skill" || t === "memory")).toBe(true);
    },
    TIMEOUT_MS,
  );
});

// ── AC2: explicit --type session bypasses the exclusion ─────────────────────

describe("#627 explicit type:session bypasses exclusion (AC2)", () => {
  test(
    "akmSearch({ query, type:'session' }) still returns the session asset",
    async () => {
      const stash = isolatedStash();
      writeSkill(stash, "flux-skill");
      const sessionRef = writeSession(stash, "claude", "sess-ccc");
      writeSandboxConfig({ semanticSearchMode: "off", search: { defaultExcludeTypes: ["session"] } });
      await buildIndex(stash);

      const res = await akmSearch({ query: TOKEN, type: "session" });
      const refs = hitRefs(res);
      expect(stashHits(res).every((h) => h.type === "session")).toBe(true);
      expect(refs).toContain(sessionRef);
    },
    TIMEOUT_MS,
  );
});

// ── AC3: includeSessions re-includes on the default path ────────────────────

describe("#627 includeSessions re-includes sessions (AC3)", () => {
  test(
    "akmSearch({ query, includeSessions:true }) re-includes the session hit",
    async () => {
      const stash = isolatedStash();
      writeSkill(stash, "flux-skill");
      const sessionRef = writeSession(stash, "claude", "sess-ddd");
      writeSandboxConfig({ semanticSearchMode: "off", search: { defaultExcludeTypes: ["session"] } });
      await buildIndex(stash);

      // Excluded by default…
      const excluded = await akmSearch({ query: TOKEN });
      expect(hitRefs(excluded)).not.toContain(sessionRef);

      // …re-included with the opt-in flag.
      const included = await akmSearch({ query: TOKEN, includeSessions: true });
      expect(hitRefs(included)).toContain(sessionRef);
    },
    TIMEOUT_MS,
  );
});

// ── AC4a: unset/empty defaultExcludeTypes preserves current behavior ─────────

describe("#627 regression guard for default-exclude config (AC4)", () => {
  test(
    "explicit empty defaultExcludeTypes=[] → sessions ARE returned (pre-#627 behavior)",
    async () => {
      const stash = isolatedStash();
      writeSkill(stash, "flux-skill");
      const sessionRef = writeSession(stash, "claude", "sess-eee");
      writeSandboxConfig({ semanticSearchMode: "off", search: { defaultExcludeTypes: [] } });
      await buildIndex(stash);

      const res = await akmSearch({ query: TOKEN });
      expect(hitRefs(res)).toContain(sessionRef);
    },
    TIMEOUT_MS,
  );

  test(
    "key ABSENT → default-applied exclusion hides sessions (default ['session'])",
    async () => {
      const stash = isolatedStash();
      writeSkill(stash, "flux-skill");
      const sessionRef = writeSession(stash, "claude", "sess-fff");
      // No search.defaultExcludeTypes key at all.
      writeSandboxConfig({ semanticSearchMode: "off" });
      await buildIndex(stash);

      const res = await akmSearch({ query: TOKEN });
      expect(hitRefs(res)).not.toContain(sessionRef);
      expect(hitTypes(res)).toContain("skill");
    },
    TIMEOUT_MS,
  );
});

// ── Empty-query (enumerate-all) path also honors exclusion ──────────────────

describe("#627 empty-query enumerate path honors exclusion", () => {
  test(
    "akmSearch({ query:'' }) excludes sessions via the getAllEntries branch",
    async () => {
      const stash = isolatedStash();
      writeSkill(stash, "flux-skill");
      const sessionRef = writeSession(stash, "claude", "sess-ggg");
      writeSandboxConfig({ semanticSearchMode: "off", search: { defaultExcludeTypes: ["session"] } });
      await buildIndex(stash);

      const res = await akmSearch({ query: "" });
      const refs = hitRefs(res);
      expect(refs).not.toContain(sessionRef);
      // The non-session asset is still enumerated.
      expect(stashHits(res).some((h) => h.type === "skill")).toBe(true);
    },
    TIMEOUT_MS,
  );
});
