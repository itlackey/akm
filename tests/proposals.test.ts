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
import {
  AUTOMATED_PROPOSAL_SOURCES,
  archiveProposal,
  createProposal,
  diffProposal,
  getProposal,
  isAutomatedProposalSource,
  isProposalSkipped,
  isValidProposalSource,
  listProposals,
  PROPOSAL_SOURCES,
  validateProposal,
} from "../src/core/proposals";

// ── Test setup ──────────────────────────────────────────────────────────────

const tempDirs: string[] = [];
const savedEnv = {
  AKM_STASH_DIR: process.env.AKM_STASH_DIR,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
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
  process.env.XDG_DATA_HOME = makeTempDir("akm-proposals-data-");
});

afterEach(() => {
  if (savedEnv.AKM_STASH_DIR === undefined) delete process.env.AKM_STASH_DIR;
  else process.env.AKM_STASH_DIR = savedEnv.AKM_STASH_DIR;
  if (savedEnv.XDG_CACHE_HOME === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = savedEnv.XDG_CACHE_HOME;
  if (savedEnv.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedEnv.XDG_DATA_HOME;
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

    const createdResult = createProposal(stash, {
      ref: "lesson:rg-over-grep",
      source: "distill",
      sourceRun: "run-123",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(createdResult)) throw new Error("unexpected skip");
    const created = createdResult;

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
    const createdResult2 = createProposal(stash, {
      ref: "lesson:bad-idea",
      source: "reflect",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(createdResult2)) throw new Error("unexpected skip");
    const created = createdResult2;

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
    // Both use force:true to bypass dedup guard — we are testing filesystem
    // isolation, not the dedup policy.
    const stash = makeStashDir();
    const aResult = createProposal(stash, {
      ref: "lesson:dup",
      source: "reflect",
      force: true,
      payload: { content: VALID_LESSON },
    });
    const bResult = createProposal(stash, {
      ref: "lesson:dup",
      source: "distill",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(aResult) || isProposalSkipped(bResult)) throw new Error("unexpected skip");
    const a = aResult;
    const b = bResult;
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
    const proposalResult = createProposal(stash, {
      ref: "lesson:fresh",
      source: "reflect",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(proposalResult)) throw new Error("unexpected skip");
    const proposal = proposalResult;
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
    const proposalResult2 = createProposal(stash, {
      ref: "lesson:rg-over-grep",
      source: "reflect",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(proposalResult2)) throw new Error("unexpected skip");
    const proposal = proposalResult2;

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
    const proposalResult3 = createProposal(stash, {
      ref: "lesson:no-fields",
      source: "distill",
      force: true,
      payload: { content: `---\ndescription: ""\nwhen_to_use: ""\n---\n\nbody\n` },
    });
    if (isProposalSkipped(proposalResult3)) throw new Error("unexpected skip");
    const proposal = proposalResult3;

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
    const proposalResult4 = createProposal(stash, {
      ref: "lesson:empty",
      source: "distill",
      force: true,
      payload: { content: "" },
    });
    if (isProposalSkipped(proposalResult4)) throw new Error("unexpected skip");
    const proposal = proposalResult4;
    const report = validateProposal(proposal);
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.kind === "empty-content")).toBe(true);
  });
});

// ── #284 GAP-HIGH backfill ───────────────────────────────────────────────────

describe("akmProposalReject — non-pending status (#284 HIGH 4)", () => {
  test("rejecting an already-archived proposal → UsageError with .code INVALID_FLAG_VALUE", async () => {
    const stash = makeStashDir();
    const createdResult3 = createProposal(stash, {
      ref: "lesson:once",
      source: "reflect",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(createdResult3)) throw new Error("unexpected skip");
    const created = createdResult3;
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
    const proposalResult5 = createProposal(stash, {
      ref: "lesson:invalid",
      source: "distill",
      force: true,
      payload: { content: "" },
    });
    if (isProposalSkipped(proposalResult5)) throw new Error("unexpected skip");
    const proposal = proposalResult5;

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

// ── F-2 / #363 — dedup / cooldown guard ─────────────────────────────────────

describe("createProposal dedup / cooldown guard (F-2 / #363)", () => {
  test("duplicate_pending: second proposal for same ref+source is skipped without force", () => {
    const stash = makeStashDir();
    const first = createProposal(stash, {
      ref: "lesson:dup-test",
      source: "reflect",
      payload: { content: VALID_LESSON },
    });
    expect(isProposalSkipped(first)).toBe(false);

    const second = createProposal(stash, {
      ref: "lesson:dup-test",
      source: "reflect",
      payload: { content: "Different content, but same ref+source." },
    });
    expect(isProposalSkipped(second)).toBe(true);
    if (!isProposalSkipped(second)) throw new Error("type guard");
    expect(second.reason).toBe("duplicate_pending");
  });

  test("content_hash_match: identical content for same ref+source is silently skipped", () => {
    const stash = makeStashDir();
    const first = createProposal(stash, {
      ref: "lesson:hash-test",
      source: "distill",
      payload: { content: VALID_LESSON },
    });
    expect(isProposalSkipped(first)).toBe(false);

    const second = createProposal(stash, {
      ref: "lesson:hash-test",
      source: "distill",
      payload: { content: VALID_LESSON },
    });
    expect(isProposalSkipped(second)).toBe(true);
    if (!isProposalSkipped(second)) throw new Error("type guard");
    expect(second.reason).toBe("content_hash_match");
  });

  test("cooldown: a proposal is skipped for ref+source within the cooldown window after rejection", () => {
    const stash = makeStashDir();
    const first = createProposal(stash, {
      ref: "lesson:cooldown-test",
      source: "reflect",
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(first)) throw new Error("unexpected skip");
    archiveProposal(stash, first.id, "rejected", "Test rejection for cooldown");

    const second = createProposal(stash, {
      ref: "lesson:cooldown-test",
      source: "reflect",
      payload: { content: "Completely different content that is not the same hash." },
    });
    expect(isProposalSkipped(second)).toBe(true);
    if (!isProposalSkipped(second)) throw new Error("type guard");
    expect(second.reason).toBe("cooldown");
    expect(second.message).toContain("14d window");
  });

  test("force:true bypasses all guards", () => {
    const stash = makeStashDir();
    const first = createProposal(stash, {
      ref: "lesson:force-test",
      source: "reflect",
      payload: { content: VALID_LESSON },
    });
    expect(isProposalSkipped(first)).toBe(false);

    const second = createProposal(stash, {
      ref: "lesson:force-test",
      source: "reflect",
      force: true,
      payload: { content: VALID_LESSON },
    });
    expect(isProposalSkipped(second)).toBe(false);
  });

  test("different sources for same ref are independent — no cross-source dedup", () => {
    const stash = makeStashDir();
    const reflectResult = createProposal(stash, {
      ref: "lesson:cross-source",
      source: "reflect",
      payload: { content: VALID_LESSON },
    });
    const distillResult = createProposal(stash, {
      ref: "lesson:cross-source",
      source: "distill",
      payload: { content: VALID_LESSON },
    });
    expect(isProposalSkipped(reflectResult)).toBe(false);
    expect(isProposalSkipped(distillResult)).toBe(false);
    const queue = listProposals(stash);
    expect(queue.length).toBe(2);
  });
});

// ── F-4 / #385 — source allow-list + sourceRun advisory ──────────────────────

describe("F-4: source allow-list validation and sourceRun advisory (#385)", () => {
  test("isValidProposalSource returns true for known source values", () => {
    for (const src of PROPOSAL_SOURCES) {
      expect(isValidProposalSource(src)).toBe(true);
    }
  });

  test("isValidProposalSource returns false for unknown strings", () => {
    expect(isValidProposalSource("reflct")).toBe(false); // typo
    expect(isValidProposalSource("")).toBe(false);
    expect(isValidProposalSource("agent-custom")).toBe(false);
  });

  test("isAutomatedProposalSource returns true for reflect/distill/consolidate/improve", () => {
    for (const src of AUTOMATED_PROPOSAL_SOURCES) {
      expect(isAutomatedProposalSource(src)).toBe(true);
    }
  });

  test("isAutomatedProposalSource returns false for human-initiated sources", () => {
    expect(isAutomatedProposalSource("propose")).toBe(false);
    expect(isAutomatedProposalSource("remember")).toBe(false);
    expect(isAutomatedProposalSource("feedback")).toBe(false);
  });

  test("createProposal accepts valid sources without warnings in the proposal record", () => {
    const stash = makeStashDir();
    const result = createProposal(stash, {
      ref: "lesson:f4-valid-source",
      source: "reflect",
      sourceRun: "run-abc-123",
      payload: { content: VALID_LESSON },
    });
    expect(isProposalSkipped(result)).toBe(false);
    const proposal = result as import("../src/core/proposals").Proposal;
    expect(proposal.source).toBe("reflect");
    expect(proposal.sourceRun).toBe("run-abc-123");
  });

  test("createProposal accepts unknown source strings (backward-compatible)", () => {
    const stash = makeStashDir();
    // Unknown source should NOT throw — it emits a warning but creates the proposal.
    const result = createProposal(stash, {
      ref: "lesson:f4-unknown-source",
      source: "custom-extension",
      payload: { content: VALID_LESSON },
    });
    expect(isProposalSkipped(result)).toBe(false);
  });
});
