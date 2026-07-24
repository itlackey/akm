/**
 * Regression tests for the createProposal input validation gate and the
 * purgeOrphanProposals maintenance pass.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  archiveProposal,
  createProposal,
  isProposalSkipped,
  listProposals,
  purgeOrphanProposals,
} from "../../src/commands/proposal/repository";
import { deriveEntryProvenance, deriveInstallations, slugForPath } from "../../src/indexer/installations";

/** The durable `proposals.ref` item_ref (WI-8.5a): `<bundle>//<conceptId>`. */
function durableRef(stashDir: string, type: string, name: string): string {
  const bundleId = deriveInstallations([{ path: stashDir, writable: true }])[0]?.id ?? slugForPath(stashDir);
  return deriveEntryProvenance({ bundleId, componentId: bundleId, adapterId: "akm" }, type, name).itemRef;
}

const tempDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {
  AKM_STASH_DIR: process.env.AKM_STASH_DIR,
  AKM_DATA_DIR: process.env.AKM_DATA_DIR,
  AKM_STATE_DIR: process.env.AKM_STATE_DIR,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
};

function makeStashDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-proposal-validation-"));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  process.env.AKM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "akm-proposal-validation-data-"));
  tempDirs.push(process.env.AKM_DATA_DIR);
  // Pair AKM_STASH_DIR with AKM_STATE_DIR so the test-isolation guard in
  // src/core/paths.ts stays inert for getDataDir.
  process.env.AKM_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "akm-proposal-validation-state-"));
  tempDirs.push(process.env.AKM_STATE_DIR);
});

afterEach(() => {
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("createProposal validation", () => {
  test("rejects unparseable ref with INVALID_PROPOSAL", () => {
    const stash = makeStashDir();
    let caught: { code?: string } | undefined;
    try {
      createProposal(stash, {
        ref: "not-a-ref",
        source: "reflect",
        force: true,
        payload: { content: "x", frontmatter: { description: "ok" } },
      });
    } catch (err) {
      caught = err as { code?: string };
    }
    expect(caught?.code).toBe("INVALID_PROPOSAL");
  });

  test("rejects unparseable ref with bad type prefix", () => {
    const stash = makeStashDir();
    let caught: { code?: string; message?: string } | undefined;
    try {
      createProposal(stash, {
        ref: "bogusType:foo",
        source: "reflect",
        force: true,
        payload: { content: "x", frontmatter: { description: "ok" } },
      });
    } catch (err) {
      caught = err as { code?: string; message?: string };
    }
    expect(caught?.code).toBe("INVALID_PROPOSAL");
    // Post-Chunk-5/8 ref-grammar flip: `parseRefInput` is new-grammar only, so
    // a legacy `type:name` conceptId (`bogusType:foo` — no `<stash-subdir>/`
    // segment) fails at the parse boundary with a not-found ("has no known
    // asset-type prefix"), which createProposal wraps as INVALID_PROPOSAL. Same
    // rejection code as before, new-grammar message.
    expect(caught?.message).toMatch(/has no known asset-type prefix/i);
  });

  test("rejects empty content", () => {
    const stash = makeStashDir();
    let caught: { code?: string } | undefined;
    try {
      createProposal(stash, {
        ref: "memories/foo",
        source: "reflect",
        force: true,
        payload: { content: "   " },
      });
    } catch (err) {
      caught = err as { code?: string };
    }
    expect(caught?.code).toBe("INVALID_PROPOSAL");
  });

  test("rejects consolidate proposal with missing description in frontmatter", () => {
    const stash = makeStashDir();
    let caught: { code?: string; message?: string } | undefined;
    try {
      createProposal(stash, {
        ref: "memories/foo",
        source: "consolidate",
        force: true,
        payload: { content: "x", frontmatter: { tags: ["a"] } },
      });
    } catch (err) {
      caught = err as { code?: string; message?: string };
    }
    expect(caught?.code).toBe("INVALID_PROPOSAL");
    expect(caught?.message).toMatch(/description/i);
  });

  test("accepts reflect proposal with frontmatter but no description (description-only enforced for consolidate)", () => {
    const stash = makeStashDir();
    // Reflect proposals legitimately have varied content shapes — don't reject
    // for missing description, only consolidate does that.
    const result = createProposal(stash, {
      ref: "memories/bar",
      source: "reflect",
      force: true,
      payload: { content: "x", frontmatter: { tags: ["a"] } },
    });
    expect(isProposalSkipped(result)).toBe(false);
  });

  test("accepts valid proposal", () => {
    const stash = makeStashDir();
    const result = createProposal(stash, {
      ref: "memories/alpha",
      source: "reflect",
      force: true,
      payload: { content: "body text", frontmatter: { description: "good description" } },
    });
    expect(isProposalSkipped(result)).toBe(false);
  });

  test("accepts proposal without frontmatter", () => {
    const stash = makeStashDir();
    const result = createProposal(stash, {
      ref: "memories/beta",
      source: "reflect",
      force: true,
      payload: { content: "body text" },
    });
    expect(isProposalSkipped(result)).toBe(false);
  });

  test("rejects a workflow with numbered step headings before queueing", () => {
    const stash = makeStashDir();
    let caught: { code?: string; message?: string } | undefined;
    try {
      createProposal(stash, {
        ref: "workflows/ship-feature-from-spec",
        source: "reflect",
        force: true,
        payload: {
          content:
            "# Workflow: Ship Feature From Spec\n\n## Step 1: Validate inputs\nStep ID: validate\n\n### Instructions\nValidate the specification.\n",
        },
      });
    } catch (err) {
      caught = err as { code?: string; message?: string };
    }

    expect(caught?.code).toBe("INVALID_PROPOSAL");
    expect(caught?.message).toContain('Only "## Step: <title>" sections are allowed');
    expect(listProposals(stash)).toHaveLength(0);
  });
});

describe("purgeOrphanProposals", () => {
  function writeAsset(stash: string, subdir: string, name: string, body = "content"): void {
    const dir = path.join(stash, subdir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.md`), `---\ndescription: ${name}\n---\n\n${body}\n`);
  }

  test("does not touch lesson proposals (lessons are new assets)", () => {
    const stash = makeStashDir();
    createProposal(stash, {
      ref: "lessons/new-lesson",
      source: "reflect",
      force: true,
      payload: {
        content: "x",
        frontmatter: { description: "a lesson", when_to_use: "always" },
      },
    });
    const result = purgeOrphanProposals(stash, [stash]);
    expect(result.rejected).toBe(0);
    expect(result.checked).toBe(1);
  });

  test("does not touch non-reflect proposals", () => {
    const stash = makeStashDir();
    // distill proposal for an asset that doesn't exist
    createProposal(stash, {
      ref: "memories/never-existed",
      source: "distill",
      force: true,
      payload: { content: "x", frontmatter: { description: "ok" } },
    });
    const result = purgeOrphanProposals(stash, [stash]);
    expect(result.rejected).toBe(0);
  });

  test("rejects reflect proposals whose target asset is missing", () => {
    const stash = makeStashDir();
    // Create a reflect proposal for a memory that doesn't exist on disk
    createProposal(stash, {
      ref: "memories/orphaned",
      source: "reflect",
      force: true,
      payload: { content: "x", frontmatter: { description: "ok" } },
    });
    const result = purgeOrphanProposals(stash, [stash]);
    expect(result.rejected).toBe(1);
    expect(result.checked).toBe(1);
    expect(result.byType.memory).toBe(1);
    expect(result.orphans[0]!.ref).toBe(durableRef(stash, "memory", "orphaned"));
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    // The orphan must now be archived as rejected
    const stillPending = listProposals(stash, { status: "pending" });
    expect(stillPending.length).toBe(0);
  });

  test("keeps reflect proposals whose target exists in any source dir", () => {
    const primary = makeStashDir();
    const secondary = makeStashDir();
    writeAsset(secondary, "memories", "shared");
    createProposal(primary, {
      ref: "memories/shared",
      source: "reflect",
      force: true,
      payload: { content: "x", frontmatter: { description: "ok" } },
    });
    const result = purgeOrphanProposals(primary, [primary, secondary]);
    expect(result.rejected).toBe(0);
    expect(result.checked).toBe(1);
  });

  test("skips proposals whose status is already accepted (checked stays 0)", () => {
    const stash = makeStashDir();
    // Create then immediately accept a reflect proposal — it moves to the
    // archive with status "accepted" and must never be counted by the purge.
    const created = createProposal(stash, {
      ref: "memories/already-accepted",
      source: "reflect",
      force: true,
      payload: { content: "x", frontmatter: { description: "ok" } },
    });
    if (!isProposalSkipped(created)) {
      // Archive it as accepted so it disappears from the pending queue.
      archiveProposal(stash, created.id, "accepted", undefined);
    }
    const result = purgeOrphanProposals(stash, [stash]);
    // No pending reflect proposals → nothing checked, nothing rejected.
    expect(result.checked).toBe(0);
    expect(result.rejected).toBe(0);
  });

  test("durationMs is a non-negative integer", () => {
    const stash = makeStashDir();
    const result = purgeOrphanProposals(stash, [stash]);
    expect(Number.isInteger(result.durationMs)).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("reflect proposal for script:never-existed is treated as an orphan and rejected", () => {
    const stash = makeStashDir();
    createProposal(stash, {
      ref: "scripts/never-existed",
      source: "reflect",
      force: true,
      payload: { content: "console.log('hi')", frontmatter: { description: "ok" } },
    });
    const result = purgeOrphanProposals(stash, [stash]);
    expect(result.rejected).toBeGreaterThanOrEqual(1);
  });
});
