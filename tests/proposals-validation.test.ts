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
  type CreateProposalInput,
  createProposal as createProposalRaw,
  listProposals,
  purgeOrphanProposals,
} from "../src/commands/proposal/repository";
import { deriveEntryProvenance, deriveInstallations, slugForPath } from "../src/indexer/installations";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

function bundleIdFor(stashDir: string): string {
  return deriveInstallations([{ path: stashDir, writable: true }])[0]?.id ?? slugForPath(stashDir);
}

function createProposal(stashDir: string, input: CreateProposalInput) {
  return createProposalRaw(stashDir, {
    ...input,
    target: { source: bundleIdFor(stashDir), root: stashDir },
  });
}

/** The durable `proposals.ref` item_ref (WI-8.5a): `<bundle>//<conceptId>`. */
function durableRef(stashDir: string, type: string, name: string): string {
  const bundleId = bundleIdFor(stashDir);
  return deriveEntryProvenance({ bundleId, componentId: bundleId, adapterId: "akm" }, type, name).itemRef;
}

const tempDirs: string[] = [];

function makeStashDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-proposal-validation-"));
  tempDirs.push(dir);
  return dir;
}

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
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
    createProposal(stash, {
      ref: "memories/bar",
      source: "reflect",
      payload: { content: "x", frontmatter: { tags: ["a"] } },
    });
  });

  test("accepts valid proposal", () => {
    const stash = makeStashDir();
    createProposal(stash, {
      ref: "memories/alpha",
      source: "reflect",
      payload: { content: "body text", frontmatter: { description: "good description" } },
    });
  });

  test("accepts proposal without frontmatter", () => {
    const stash = makeStashDir();
    createProposal(stash, {
      ref: "memories/beta",
      source: "reflect",
      payload: { content: "body text" },
    });
  });

  // Ported for workflow-format-unification: the old grammar's authoring
  // mistake ("numbered step headings", e.g. "## Step 1: Validate inputs")
  // has no equivalent under the unified grammar's single rule — every
  // level-2 heading must be `## <declared-step-id>` exactly (spec §2.2 body
  // rule 1). A heading that doesn't match a declared step id is now
  // "Unexpected level-2 heading ...", pinned below with the new parser's
  // real message rather than an invented one.
  test("rejects a workflow whose body heading doesn't match a declared step id before queueing", () => {
    const stash = makeStashDir();
    let caught: { code?: string; message?: string } | undefined;
    try {
      createProposal(stash, {
        ref: "workflows/ship-feature-from-spec",
        source: "reflect",
        payload: {
          content:
            "---\ntype: workflow\ndescription: Ship Feature From Spec\nsteps:\n  - id: validate\n---\n\n## Step 1: Validate inputs\n\nValidate the specification.\n",
        },
      });
    } catch (err) {
      caught = err as { code?: string; message?: string };
    }

    expect(caught?.code).toBe("INVALID_PROPOSAL");
    expect(caught?.message).toContain('Unexpected level-2 heading "## Step 1: Validate inputs"');
    expect(caught?.message).toContain("Level-2 headings must exactly match a declared step id");
    expect(listProposals(stash)).toHaveLength(0);
  });

  test("rejects invalid task YAML before queueing", () => {
    const stash = makeStashDir();

    expect(() =>
      createProposal(stash, {
        ref: "tasks/nightly",
        source: "reflect",
        payload: {
          content: "version: 4\nuses: akm/command\nrun: akm index\nwith:\n  content: one\n",
        },
      }),
    ).toThrow(/invalid task structure.*exactly one.*uses or run/is);
    expect(listProposals(stash)).toHaveLength(0);
  });

  test("rejects invalid lesson metadata before queueing", () => {
    const stash = makeStashDir();

    expect(() =>
      createProposal(stash, {
        ref: "lessons/no-trigger",
        source: "distill",
        payload: { content: "---\ndescription: A complete description of the lesson.\n---\n\nBody.\n" },
      }),
    ).toThrow(/invalid lesson structure.*when_to_use/is);
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
      payload: {
        content:
          "---\ndescription: A complete lesson description for proposal validation.\nwhen_to_use: Apply this lesson when validating proposal retention behavior.\n---\n\nBody.\n",
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
      payload: { content: "x", frontmatter: { description: "ok" } },
    });
    // Archive it as accepted so it disappears from the pending queue.
    archiveProposal(stash, created.id, "accepted", undefined);
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
      payload: { content: "console.log('hi')", frontmatter: { description: "ok" } },
    });
    const result = purgeOrphanProposals(stash, [stash]);
    expect(result.rejected).toBeGreaterThanOrEqual(1);
  });
});
