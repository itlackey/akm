import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  akmProposalAccept,
  akmProposalDiff,
  akmProposalList,
  akmProposalReject,
  akmProposalShow,
} from "../src/commands/proposal";
import type { AkmConfig } from "../src/core/config";
import { readEvents } from "../src/core/events";
import { createProposal, diffProposal, getProposal, listProposals, validateProposal } from "../src/core/proposals";

// ── Test setup ──────────────────────────────────────────────────────────────

const tempDirs: string[] = [];
const savedEnv = {
  AKM_STASH_DIR: process.env.AKM_STASH_DIR,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeStashDir(): string {
  const stash = makeTempDir("akm-proposals-stash-");
  // Pre-create the canonical type directories the writer expects.
  for (const dir of ["lessons", "skills", "memories"]) {
    fs.mkdirSync(path.join(stash, dir), { recursive: true });
  }
  return stash;
}

function makeConfig(stashDir: string): AkmConfig {
  return {
    stashDir,
    sources: [{ type: "filesystem", name: "stash", path: stashDir, writable: true }],
    defaultWriteTarget: "stash",
  } as AkmConfig;
}

beforeEach(() => {
  process.env.XDG_CACHE_HOME = makeTempDir("akm-proposals-cache-");
  process.env.XDG_CONFIG_HOME = makeTempDir("akm-proposals-config-");
});

afterEach(() => {
  if (savedEnv.AKM_STASH_DIR === undefined) delete process.env.AKM_STASH_DIR;
  else process.env.AKM_STASH_DIR = savedEnv.AKM_STASH_DIR;
  if (savedEnv.XDG_CACHE_HOME === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = savedEnv.XDG_CACHE_HOME;
  if (savedEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedEnv.XDG_CONFIG_HOME;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Tests ───────────────────────────────────────────────────────────────────

const VALID_LESSON = `---\ndescription: Use ripgrep before grep\nwhen_to_use: Searching large repos for patterns\n---\n\nPrefer rg over grep when scanning large code repos.\n`;

describe("createProposal / listProposals / getProposal", () => {
  test("round-trip: create → list → show → accept materialises asset and emits promoted event", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);

    const created = createProposal(stash, {
      ref: "lesson:rg-over-grep",
      source: "distill",
      sourceRun: "run-123",
      payload: { content: VALID_LESSON },
    });

    expect(created.id).toBeDefined();
    expect(created.status).toBe("pending");

    // list
    const listResult = akmProposalList({ stashDir: stash });
    expect(listResult.totalCount).toBe(1);
    expect(listResult.proposals[0]?.id).toBe(created.id);

    // show
    const showResult = akmProposalShow({ stashDir: stash, id: created.id });
    expect(showResult.proposal.ref).toBe("lesson:rg-over-grep");
    expect(showResult.validation.ok).toBe(true);

    // accept
    const acceptResult = await akmProposalAccept({ stashDir: stash, id: created.id, config });
    expect(acceptResult.ok).toBe(true);
    expect(acceptResult.ref).toBe("lesson:rg-over-grep");
    expect(fs.existsSync(acceptResult.assetPath)).toBe(true);
    expect(fs.readFileSync(acceptResult.assetPath, "utf8")).toContain("Prefer rg over grep");

    // status promoted
    const promoted = getProposal(stash, created.id);
    expect(promoted.status).toBe("accepted");
    expect(promoted.review?.outcome).toBe("accepted");

    // promoted event emitted
    const events = readEvents({ type: "promoted" });
    expect(events.events.length).toBe(1);
    expect(events.events[0]?.ref).toBe("lesson:rg-over-grep");
    expect((events.events[0]?.metadata as Record<string, unknown> | undefined)?.proposalId).toBe(created.id);
  });

  test("reject path: archive contains entry, status rejected, rejected event emitted", () => {
    const stash = makeStashDir();
    const created = createProposal(stash, {
      ref: "lesson:bad-idea",
      source: "reflect",
      payload: { content: VALID_LESSON },
    });

    const result = akmProposalReject({ stashDir: stash, id: created.id, reason: "duplicate of existing lesson" });
    expect(result.ok).toBe(true);
    expect(result.proposal.status).toBe("rejected");
    expect(result.proposal.review?.reason).toBe("duplicate of existing lesson");

    // archive directory contains it
    const archivePath = path.join(stash, ".akm", "proposals", "archive", created.id, "proposal.json");
    expect(fs.existsSync(archivePath)).toBe(true);

    // live queue empty
    const live = listProposals(stash);
    expect(live).toHaveLength(0);

    // rejected event
    const events = readEvents({ type: "rejected" });
    expect(events.events.length).toBe(1);
    expect((events.events[0]?.metadata as Record<string, unknown> | undefined)?.reason).toBe(
      "duplicate of existing lesson",
    );
  });

  test("multiple proposals for same ref: distinct ids, no path collision", () => {
    const stash = makeStashDir();
    const a = createProposal(stash, { ref: "lesson:dup", source: "reflect", payload: { content: VALID_LESSON } });
    const b = createProposal(stash, { ref: "lesson:dup", source: "distill", payload: { content: VALID_LESSON } });
    expect(a.id).not.toBe(b.id);

    const list = listProposals(stash);
    expect(list.length).toBe(2);
    const ids = list.map((p) => p.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });
});

describe("diff path", () => {
  test("new asset: shows new-asset diff with /dev/null marker", () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    const proposal = createProposal(stash, {
      ref: "lesson:fresh",
      source: "reflect",
      payload: { content: VALID_LESSON },
    });
    const diff = diffProposal(stash, config, proposal.id);
    expect(diff.isNew).toBe(true);
    expect(diff.unified).toContain("/dev/null");
    expect(diff.unified).toContain("Prefer rg over grep");
  });

  test("existing asset + proposal: produces unified diff", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    // Pre-write an existing lesson so the diff has a left-hand side.
    const lessonPath = path.join(stash, "lessons", "rg-over-grep.md");
    fs.writeFileSync(
      lessonPath,
      `---\ndescription: Use ripgrep before grep\nwhen_to_use: Searching repos\n---\n\nOriginal body.\n`,
      "utf8",
    );
    const proposal = createProposal(stash, {
      ref: "lesson:rg-over-grep",
      source: "reflect",
      payload: { content: VALID_LESSON },
    });

    const diffResult = akmProposalDiff({ stashDir: stash, id: proposal.id, config });
    expect(diffResult.isNew).toBe(false);
    expect(diffResult.unified).toContain("---");
    expect(diffResult.unified).toContain("+++");
    expect(diffResult.unified).toContain("Prefer rg over grep");
  });
});

describe("validation failure", () => {
  test("invalid lesson frontmatter → accept fails non-zero with clear error", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    const proposal = createProposal(stash, {
      ref: "lesson:no-fields",
      source: "distill",
      payload: { content: `---\ndescription: ""\nwhen_to_use: ""\n---\n\nbody\n` },
    });

    const report = validateProposal(proposal);
    expect(report.ok).toBe(false);
    expect(report.findings.length).toBeGreaterThan(0);

    let threw = false;
    try {
      await akmProposalAccept({ stashDir: stash, id: proposal.id, config });
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain("validation");
    }
    expect(threw).toBe(true);

    // Proposal still pending; no asset materialised
    const stillPending = getProposal(stash, proposal.id);
    expect(stillPending.status).toBe("pending");
    expect(fs.existsSync(path.join(stash, "lessons", "no-fields.md"))).toBe(false);
  });

  test("empty content → validation fails", () => {
    const stash = makeStashDir();
    const proposal = createProposal(stash, {
      ref: "lesson:empty",
      source: "distill",
      payload: { content: "" },
    });
    const report = validateProposal(proposal);
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.kind === "empty-content")).toBe(true);
  });
});

// ── #284 GAP-HIGH backfill ───────────────────────────────────────────────────

describe("akmProposalReject — non-pending status (#284 HIGH 4)", () => {
  test("rejecting an already-archived proposal → UsageError with .code INVALID_FLAG_VALUE", async () => {
    const stash = makeStashDir();
    const created = createProposal(stash, {
      ref: "lesson:once",
      source: "reflect",
      payload: { content: VALID_LESSON },
    });
    // First reject moves it to the archive.
    akmProposalReject({ stashDir: stash, id: created.id });
    // Second reject must fail with a typed UsageError (.code load-bearing).
    let thrown: unknown;
    try {
      akmProposalReject({ stashDir: stash, id: created.id });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const e = thrown as Error & { code?: string; name: string };
    expect(e.name).toBe("UsageError");
    expect(e.code).toBe("INVALID_FLAG_VALUE");
    expect(e.message).toMatch(/not pending|already/i);
  });
});

describe("akmProposalShow / akmProposalDiff — missing id (#284 HIGH 5)", () => {
  test("akmProposalShow on missing id → NotFoundError with .code FILE_NOT_FOUND", () => {
    const stash = makeStashDir();
    let thrown: unknown;
    try {
      akmProposalShow({ stashDir: stash, id: "deadbeef-0000-0000-0000-000000000000" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const e = thrown as Error & { code?: string; name: string };
    expect(e.name).toBe("NotFoundError");
    expect(e.code).toBe("FILE_NOT_FOUND");
  });

  test("akmProposalDiff on missing id → NotFoundError with .code FILE_NOT_FOUND", () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    let thrown: unknown;
    try {
      akmProposalDiff({ stashDir: stash, id: "deadbeef-0000-0000-0000-000000000001", config });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const e = thrown as Error & { code?: string; name: string };
    expect(e.name).toBe("NotFoundError");
    expect(e.code).toBe("FILE_NOT_FOUND");
  });
});

describe("akmProposalAccept — validation failure (#284 HIGH 6)", () => {
  test("validation failure → no `promoted` event emitted; proposal stays pending", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    // Empty content — fails the lesson lint.
    const proposal = createProposal(stash, {
      ref: "lesson:invalid",
      source: "distill",
      payload: { content: "" },
    });

    let threw = false;
    try {
      await akmProposalAccept({ stashDir: stash, id: proposal.id, config });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Critical: `promoted` event must NOT be emitted on validation failure.
    const promoted = readEvents({ type: "promoted" });
    expect(promoted.events.length).toBe(0);

    // And the proposal stays pending.
    const stillPending = getProposal(stash, proposal.id);
    expect(stillPending.status).toBe("pending");
  });
});
