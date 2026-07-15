// CONTRACT TEST: ref-resolver
// ----------------------------------------------------------------------------
// This test pins the behavior of the asset-ref resolver in
// `src/commands/lint/base-linter.ts` (functions `refToRelPath` +
// `refExistsInAnyStash`).
//
// A SISTER COPY of this fixture lives in the akm-plugins repo at
// `tests/ref-resolver-contract.test.ts`, where it drives the resolver inside
// `shared/ref-extraction.ts` against the SAME canonical inputs. The fixture
// below MUST stay byte-identical (modulo the per-repo glue that selects which
// implementation is exercised). If you change a case here, change it there.
// If you add a new asset type, add it to BOTH `refToRelPath` implementations
// AND extend the fixture in BOTH tests.
//
// Why a hand-mirrored fixture instead of a shared package: the akm-plugins
// repo has no dependency on akm-core (and adding one would bloat the
// post-tool hot-path). The fixture is small, deliberate, and stable; drift
// across repos shows up as a contract-test failure on one side as soon as
// the resolver behavior diverges.
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { refExistsInAnyStash, refToRelPath } from "../../../src/commands/lint/base-linter";

// ── Fixture builder ──────────────────────────────────────────────────────────
//
// Builds a single canonical stash layout that exercises every reachability
// rule the resolver implements. The same layout is built by the akm-plugins
// sister test.

function buildFixtureStash(root: string): void {
  // Standard single-file asset types.
  touch(path.join(root, "memories", "rollout-notes.md"));
  touch(path.join(root, "agents", "bunjs-coder.md"));
  touch(path.join(root, "commands", "akm-help.md"));
  touch(path.join(root, "workflows", "release-train.md"));
  touch(path.join(root, "knowledge", "release-notes.md"));
  touch(path.join(root, "lessons", "no-fine-tuning.md"));
  touch(path.join(root, "tasks", "ship-0.8.0.yml"));
  touch(path.join(root, "wikis", "akm-internals.md"));
  touch(path.join(root, "agents", "release-captain.md"));
  touch(path.join(root, "commands", "akm-sync.md"));
  touch(path.join(root, "lessons", "ship-small.md"));

  // Skill multi-file layout.
  touch(path.join(root, "skills", "rollout", "SKILL.md"));

  // Memory `.derived.md` sibling (no plain .md, only the derived file).
  touch(path.join(root, "memories", "session-derived.derived.md"));

  // Knowledge subdirectory layout (knowledge/<category>/<slug>.md).
  touch(path.join(root, "knowledge", "projects", "akm-release.md"));

  // Namespaced slug containing `/` — knowledge ref pointing at a file the
  // ref consumer has spelled with the full subpath.
  touch(path.join(root, "knowledge", "projects", "akm", "deep-dive.md"));
}

function touch(file: string, contents = ""): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

// ── Canonical fixture ────────────────────────────────────────────────────────
//
// Each case is { type, slug, reachable }. The contract is: given the stash
// layout above, the resolver returns `reachable` for every case.

interface ContractCase {
  description: string;
  type: string;
  slug: string;
  reachable: boolean;
}

const CONTRACT_CASES: ContractCase[] = [
  // ── reachable ─────────────────────────────────────────────────────────
  { description: "existing memory", type: "memory", slug: "rollout-notes", reachable: true },
  { description: "existing agent", type: "agent", slug: "bunjs-coder", reachable: true },
  { description: "existing command", type: "command", slug: "akm-help", reachable: true },
  { description: "existing workflow", type: "workflow", slug: "release-train", reachable: true },
  { description: "existing knowledge (top level)", type: "knowledge", slug: "release-notes", reachable: true },
  { description: "existing lesson", type: "lesson", slug: "no-fine-tuning", reachable: true },
  { description: "existing task", type: "task", slug: "ship-0.8.0", reachable: true },
  { description: "existing wiki", type: "wiki", slug: "akm-internals", reachable: true },
  { description: "existing agent (2)", type: "agent", slug: "release-captain", reachable: true },
  { description: "existing command (2)", type: "command", slug: "akm-sync", reachable: true },
  { description: "existing lesson (2)", type: "lesson", slug: "ship-small", reachable: true },
  { description: "skill multi-file layout (SKILL.md inside dir)", type: "skill", slug: "rollout", reachable: true },
  {
    description: "memory backed only by .derived.md sibling",
    type: "memory",
    slug: "session-derived",
    reachable: true,
  },
  {
    description: "knowledge under subdirectory (knowledge/<cat>/<slug>.md)",
    type: "knowledge",
    slug: "akm-release",
    reachable: true,
  },
  {
    description: "namespaced knowledge slug (slug contains '/')",
    type: "knowledge",
    slug: "projects/akm/deep-dive",
    reachable: true,
  },

  // ── not reachable ─────────────────────────────────────────────────────
  { description: "memory pointing at non-existent slug", type: "memory", slug: "no-such-memory", reachable: false },
  {
    description: "agent pointing at non-existent slug",
    type: "agent",
    slug: "no-such-agent",
    reachable: false,
  },
  {
    description: "knowledge pointing at non-existent slug",
    type: "knowledge",
    slug: "no-such-knowledge",
    reachable: false,
  },
  {
    description: "skill pointing at non-existent slug",
    type: "skill",
    slug: "no-such-skill",
    reachable: false,
  },
  // `script` is intentionally unresolvable by the contract — the type is
  // skipped in `refToRelPath`. Both implementations must agree it never
  // resolves regardless of layout.
  { description: "script type is always unresolvable", type: "script", slug: "any-script", reachable: false },
];

// ── Tests ────────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeStash(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-ref-contract-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * Drive the akm-core resolver: compose `refToRelPath` + `refExistsInAnyStash`.
 * Returns `true` iff the ref is reachable under the given stash roots.
 *
 * Mirrors the validate-side glue in
 * `akm-plugins/shared/ref-extraction.ts#refExistsInAnyStash`, which inlines
 * the `refToRelPath` -> `existsSync` chain into a single function.
 */
function resolveRef(type: string, slug: string, stashRoots: string[]): boolean {
  const relPath = refToRelPath(type, slug);
  if (relPath === null) return false;
  return refExistsInAnyStash(relPath, type, slug, stashRoots);
}

describe("ref-resolver contract", () => {
  test("canonical fixture: every case resolves as the contract specifies", () => {
    const stash = makeStash();
    buildFixtureStash(stash);
    const stashRoots = [stash];

    const failures: string[] = [];
    for (const c of CONTRACT_CASES) {
      const actual = resolveRef(c.type, c.slug, stashRoots);
      if (actual !== c.reachable) {
        failures.push(`  - [${c.type}:${c.slug}] (${c.description}): expected reachable=${c.reachable}, got ${actual}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `ref-resolver contract drift detected (${failures.length} case(s)):\n${failures.join("\n")}\n\n` +
          "If you intentionally changed the resolver behavior, update BOTH this fixture\n" +
          "and the sister fixture in the akm-plugins repo at\n" +
          "  tests/ref-resolver-contract.test.ts\n" +
          "in the same coordinated change.",
      );
    }
    // Sanity check: assert we actually ran every case (catch accidental
    // empty fixture).
    expect(CONTRACT_CASES.length).toBeGreaterThanOrEqual(20);
  });

  test("script type is always unresolvable regardless of layout", () => {
    // The contract pins this explicitly: `script` lives in nested dirs and
    // is never resolvable by the slug-based walker. Both implementations
    // return `null` from refToRelPath (-> false from the composed resolver).
    const stash = makeStash();
    buildFixtureStash(stash);
    // Even if a file named "any-script.md" exists somewhere, the type maps
    // to null and the resolver returns false.
    touch(path.join(stash, "scripts", "any-script.md"));
    expect(resolveRef("script", "any-script", [stash])).toBe(false);
  });

  test("unknown asset type is unresolvable", () => {
    // Defends against silent additions: if either side adds a new asset
    // type without the other, the new type maps to null and resolution
    // fails — the contract test catches the missing case once added to the
    // fixture.
    const stash = makeStash();
    buildFixtureStash(stash);
    expect(resolveRef("not-a-real-type", "anything", [stash])).toBe(false);
  });
});
