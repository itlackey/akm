import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  akmProposalAccept,
  akmProposalDiff,
  akmProposalList,
  akmProposalReject,
  akmProposalRevert,
  akmProposalShow,
} from "../src/commands/proposal";
import type { AkmConfig } from "../src/core/config";
import { readEvents } from "../src/core/events";
import {
  AUTOMATED_PROPOSAL_SOURCES,
  archiveProposal,
  createProposal,
  diffProposal,
  expireStaleProposals,
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

  test("empty content → createProposal rejects with INVALID_PROPOSAL", () => {
    const stash = makeStashDir();
    let threw = false;
    let code: string | undefined;
    try {
      createProposal(stash, {
        ref: "lesson:empty",
        source: "distill",
        force: true,
        payload: { content: "" },
      });
    } catch (err) {
      threw = true;
      if (err && typeof err === "object" && "code" in err) {
        code = String((err as { code: unknown }).code);
      }
    }
    expect(threw).toBe(true);
    expect(code).toBe("INVALID_PROPOSAL");
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
    // Lesson body that passes createProposal's structural check (non-empty,
    // valid ref, has frontmatter.description) but fails the deeper lesson
    // lint at accept-time because the required ## When to use section is
    // missing. This exercises the validation-failure → no-promote path.
    const proposalResult5 = createProposal(stash, {
      ref: "lesson:invalid",
      source: "distill",
      force: true,
      payload: { content: "x", frontmatter: { description: "stub" } },
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

// ── Phase 6A — Confidence score (Advantage D6a) ─────────────────────────────

describe("Phase 6A: createProposal validates and round-trips confidence", () => {
  test("accepts a valid confidence in [0, 1] and persists it on the proposal", () => {
    const stash = makeStashDir();
    const result = createProposal(stash, {
      ref: "lesson:confidence-valid",
      source: "reflect",
      sourceRun: "run-c1",
      force: true,
      payload: { content: VALID_LESSON },
      confidence: 0.85,
    });
    if (isProposalSkipped(result)) throw new Error("unexpected skip");
    expect(result.confidence).toBe(0.85);

    // Round-trip via getProposal so we know it survives JSON serialization.
    const reloaded = getProposal(stash, result.id);
    expect(reloaded.confidence).toBe(0.85);
  });

  test("accepts boundary values 0 and 1 exactly", () => {
    const stash = makeStashDir();
    const zero = createProposal(stash, {
      ref: "lesson:confidence-zero",
      source: "reflect",
      force: true,
      payload: { content: VALID_LESSON },
      confidence: 0,
    });
    const one = createProposal(stash, {
      ref: "lesson:confidence-one",
      source: "reflect",
      force: true,
      payload: { content: VALID_LESSON },
      confidence: 1,
    });
    if (isProposalSkipped(zero) || isProposalSkipped(one)) throw new Error("unexpected skip");
    expect(zero.confidence).toBe(0);
    expect(one.confidence).toBe(1);
  });

  test("drops confidence when omitted (round-trip preserves the absence)", () => {
    const stash = makeStashDir();
    const result = createProposal(stash, {
      ref: "lesson:confidence-undefined",
      source: "reflect",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(result)) throw new Error("unexpected skip");
    expect(result.confidence).toBeUndefined();
    const reloaded = getProposal(stash, result.id);
    expect(reloaded.confidence).toBeUndefined();
  });

  test("rejects (drops) out-of-range values: NaN, Infinity, -0.1, 1.5", () => {
    const stash = makeStashDir();
    const cases: Array<{ ref: string; value: number }> = [
      { ref: "lesson:c-nan", value: Number.NaN },
      { ref: "lesson:c-inf", value: Number.POSITIVE_INFINITY },
      { ref: "lesson:c-neg", value: -0.1 },
      { ref: "lesson:c-hi", value: 1.5 },
    ];
    for (const { ref, value } of cases) {
      const created = createProposal(stash, {
        ref,
        source: "reflect",
        force: true,
        payload: { content: VALID_LESSON },
        confidence: value,
      });
      if (isProposalSkipped(created)) throw new Error("unexpected skip");
      // All four invalid values must be silently dropped — no NaN persisted.
      expect(created.confidence).toBeUndefined();
    }
  });
});

// ── Phase 6B — Proposal expiration (Advantage D6b) ──────────────────────────

describe("Phase 6B: expireStaleProposals archives proposals past retention", () => {
  test("expires only proposals older than archiveRetentionDays", () => {
    const stash = makeStashDir();
    const config: AkmConfig = { ...makeConfig(stash), archiveRetentionDays: 30 } as AkmConfig;

    // Three proposals: 60 days old, 31 days old, 1 day old (relative to fake now).
    const NOW = Date.UTC(2026, 5, 1);
    const DAY = 86_400_000;
    const oldA = createProposal(
      stash,
      {
        ref: "lesson:expire-old-a",
        source: "reflect",
        force: true,
        payload: { content: VALID_LESSON },
      },
      { now: () => NOW - 60 * DAY },
    );
    const oldB = createProposal(
      stash,
      {
        ref: "lesson:expire-old-b",
        source: "distill",
        force: true,
        payload: { content: VALID_LESSON },
      },
      { now: () => NOW - 31 * DAY },
    );
    const fresh = createProposal(
      stash,
      {
        ref: "lesson:expire-fresh",
        source: "reflect",
        force: true,
        payload: { content: VALID_LESSON },
      },
      { now: () => NOW - 1 * DAY },
    );
    if (isProposalSkipped(oldA) || isProposalSkipped(oldB) || isProposalSkipped(fresh)) {
      throw new Error("unexpected skip");
    }

    const result = expireStaleProposals(stash, config, { now: () => NOW });
    expect(result.expired).toBe(2);
    expect(result.checked).toBe(3);
    expect(result.retentionDays).toBe(30);
    const expiredRefs = result.expiredProposals.map((p) => p.ref).sort();
    expect(expiredRefs).toEqual(["lesson:expire-old-a", "lesson:expire-old-b"]);

    // The fresh proposal remains pending.
    const stillPending = listProposals(stash, { status: "pending" });
    expect(stillPending.length).toBe(1);
    expect(stillPending[0]?.ref).toBe("lesson:expire-fresh");

    // Expired proposals are archived with reason "expired: ...".
    const expiredArchived = listProposals(stash, { status: "rejected", includeArchive: true });
    expect(expiredArchived.length).toBe(2);
    for (const arch of expiredArchived) {
      expect(arch.review?.reason).toMatch(/expired/);
    }
  });

  test("is idempotent: running twice does not double-archive already-archived entries", () => {
    const stash = makeStashDir();
    const config: AkmConfig = { ...makeConfig(stash), archiveRetentionDays: 7 } as AkmConfig;
    const NOW = Date.UTC(2026, 5, 1);
    const DAY = 86_400_000;
    createProposal(
      stash,
      {
        ref: "lesson:idem-1",
        source: "reflect",
        force: true,
        payload: { content: VALID_LESSON },
      },
      { now: () => NOW - 30 * DAY },
    );
    const first = expireStaleProposals(stash, config, { now: () => NOW });
    expect(first.expired).toBe(1);
    const second = expireStaleProposals(stash, config, { now: () => NOW });
    expect(second.expired).toBe(0);
    expect(second.checked).toBe(0); // No pending entries remain to check.
  });

  test("emits exactly one proposal_expired event per expired proposal", () => {
    const stash = makeStashDir();
    const config: AkmConfig = { ...makeConfig(stash), archiveRetentionDays: 7 } as AkmConfig;
    const NOW = Date.UTC(2026, 5, 1);
    const DAY = 86_400_000;
    const a = createProposal(
      stash,
      {
        ref: "lesson:event-a",
        source: "reflect",
        force: true,
        payload: { content: VALID_LESSON },
      },
      { now: () => NOW - 30 * DAY },
    );
    const b = createProposal(
      stash,
      {
        ref: "lesson:event-b",
        source: "distill",
        force: true,
        payload: { content: VALID_LESSON },
      },
      { now: () => NOW - 30 * DAY },
    );
    if (isProposalSkipped(a) || isProposalSkipped(b)) throw new Error("unexpected skip");

    expireStaleProposals(stash, config, { now: () => NOW });
    const events = readEvents({ type: "proposal_expired" });
    expect(events.events.length).toBe(2);
    const expiredRefs = events.events.map((e) => e.ref).sort();
    expect(expiredRefs).toEqual(["lesson:event-a", "lesson:event-b"]);
  });

  test("retentionDays === 0 disables expiration entirely", () => {
    const stash = makeStashDir();
    const config: AkmConfig = { ...makeConfig(stash), archiveRetentionDays: 0 } as AkmConfig;
    const NOW = Date.UTC(2026, 5, 1);
    const DAY = 86_400_000;
    createProposal(
      stash,
      {
        ref: "lesson:ttl-off",
        source: "reflect",
        force: true,
        payload: { content: VALID_LESSON },
      },
      { now: () => NOW - 1000 * DAY },
    );
    const result = expireStaleProposals(stash, config, { now: () => NOW });
    expect(result.expired).toBe(0);
    expect(result.retentionDays).toBe(0);
    expect(listProposals(stash, { status: "pending" }).length).toBe(1);
  });
});

// ── Phase 6C — Proposal reversion (Advantage D6c) ───────────────────────────

describe("Phase 6C: promoteProposal captures backup; revertProposal restores it", () => {
  test("backup is captured when target asset exists; backup field present on archived proposal", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    // Pre-write existing lesson so promotion has prior content to back up.
    const lessonPath = path.join(stash, "lessons", "rg-over-grep.md");
    fs.writeFileSync(
      lessonPath,
      `---\ndescription: Old description\nwhen_to_use: Old usage\n---\n\nOriginal body content.\n`,
      "utf8",
    );

    const created = createProposal(stash, {
      ref: "lesson:rg-over-grep",
      source: "distill",
      sourceRun: "run-backup",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");

    const accepted = await akmProposalAccept({ stashDir: stash, id: created.id, config });
    expect(accepted.ok).toBe(true);

    // Backup file should exist under archive/<id>/backup.md
    const reloaded = getProposal(stash, created.id);
    expect(reloaded.backup).toBe("backup.md");
    const backupAbs = path.join(stash, ".akm", "proposals", "archive", created.id, "backup.md");
    expect(fs.existsSync(backupAbs)).toBe(true);
    expect(fs.readFileSync(backupAbs, "utf8")).toContain("Original body content.");

    // New asset content was actually written.
    expect(fs.readFileSync(lessonPath, "utf8")).toContain("Prefer rg over grep");
  });

  test("backup is NOT captured when target asset does not yet exist (new asset proposal)", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    const created = createProposal(stash, {
      ref: "lesson:brand-new",
      source: "reflect",
      sourceRun: "run-new",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");

    await akmProposalAccept({ stashDir: stash, id: created.id, config });
    const reloaded = getProposal(stash, created.id);
    expect(reloaded.backup).toBeUndefined();
  });

  test("revert on an accepted proposal restores prior content and marks status=reverted", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    // Existing asset → promotion captures backup.
    const lessonPath = path.join(stash, "lessons", "rg-over-grep.md");
    fs.writeFileSync(lessonPath, `---\ndescription: Original D\nwhen_to_use: Original U\n---\n\nORIGINAL.\n`, "utf8");
    const created = createProposal(stash, {
      ref: "lesson:rg-over-grep",
      source: "distill",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");
    await akmProposalAccept({ stashDir: stash, id: created.id, config });

    // Confirm the file was rewritten by accept.
    expect(fs.readFileSync(lessonPath, "utf8")).toContain("Prefer rg over grep");

    const revertResult = await akmProposalRevert({ stashDir: stash, id: created.id, config });
    expect(revertResult.ok).toBe(true);
    expect(revertResult.ref).toBe("lesson:rg-over-grep");
    // Prior content is back.
    expect(fs.readFileSync(lessonPath, "utf8")).toContain("ORIGINAL.");
    // Status flipped to reverted.
    const reloaded = getProposal(stash, created.id);
    expect(reloaded.status).toBe("reverted");
    expect(reloaded.review?.reason).toMatch(/reverted/);

    // proposal_reverted event was emitted with the expected ref.
    const revertedEvents = readEvents({ type: "proposal_reverted" });
    expect(revertedEvents.events.length).toBe(1);
    expect(revertedEvents.events[0]?.ref).toBe("lesson:rg-over-grep");
  });

  test("revert on a non-accepted proposal fails with UsageError(INVALID_FLAG_VALUE)", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    const created = createProposal(stash, {
      ref: "lesson:not-accepted-revert",
      source: "reflect",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");
    // Proposal is pending — revert should fail.
    let thrown: unknown;
    try {
      await akmProposalRevert({ stashDir: stash, id: created.id, config });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const e = thrown as Error & { code?: string; name: string };
    expect(e.name).toBe("UsageError");
    expect(e.code).toBe("INVALID_FLAG_VALUE");
    expect(e.message).toMatch(/only accepted proposals can be reverted/);
  });

  test("revert on an accepted proposal with no backup (new asset) fails", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    // No pre-existing asset → backup will be undefined.
    const created = createProposal(stash, {
      ref: "lesson:no-backup-revert",
      source: "reflect",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");
    await akmProposalAccept({ stashDir: stash, id: created.id, config });

    let thrown: unknown;
    try {
      await akmProposalRevert({ stashDir: stash, id: created.id, config });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const e = thrown as Error & { code?: string; name: string };
    expect(e.name).toBe("UsageError");
    expect(e.message).toMatch(/no backup available/);
  });

  test("revert on a missing proposal id surfaces NotFoundError(FILE_NOT_FOUND)", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    let thrown: unknown;
    try {
      await akmProposalRevert({
        stashDir: stash,
        id: "deadbeef-0000-0000-0000-000000000000",
        config,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const e = thrown as Error & { code?: string; name: string };
    expect(e.name).toBe("NotFoundError");
    expect(e.code).toBe("FILE_NOT_FOUND");
  });
});
