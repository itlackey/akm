import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
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
} from "../../../src/commands/proposal/proposal";
import {
  AUTOMATED_PROPOSAL_SOURCES,
  archiveProposal,
  createProposal as createProposalImpl,
  diffProposal,
  expireStaleProposals,
  getProposal,
  isAutomatedProposalSource,
  isProposalSkipped,
  isValidProposalSource,
  listProposals,
  PROPOSAL_SOURCES,
  resolveProposalId,
} from "../../../src/commands/proposal/repository";
import { validateProposal } from "../../../src/commands/proposal/validators/proposals";
import { parseFrontmatter } from "../../../src/core/asset/frontmatter";
import { checkUnquotedDescriptionColon } from "../../../src/core/asset/frontmatter-lint";
import type { AkmConfig } from "../../../src/core/config/config";
import { UsageError } from "../../../src/core/errors";
import { readEvents } from "../../../src/core/events";
import { getDbPath, getIndexRebuildLockPath, getIndexWriterLockPath } from "../../../src/core/paths";
import { openStateDatabase } from "../../../src/core/state-db";
import { _setWarnSinkForTests } from "../../../src/core/warn";
import { indexWrittenAssets } from "../../../src/indexer/index-written-assets";
import { akmIndex } from "../../../src/indexer/indexer";
import { closeDatabase, openExistingDatabase } from "../../../src/storage/repositories/index-connection";
import { pkgVersion } from "../../../src/version";
import { makeConfig } from "../../_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

// ── Test setup ──────────────────────────────────────────────────────────────

const tempDirs: string[] = [];
let storage: IsolatedAkmStorage;

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

/**
 * The durable `proposals.ref` spelling WI-8.5a stores: the fully-qualified
 * `<bundle>//<conceptId>` item_ref bound by this suite's proposal helper.
 */
function durableRef(stashDir: string, type: string, name: string): string {
  void stashDir;
  const directories: Record<string, string> = { lesson: "lessons", skill: "skills", memory: "memories" };
  return `stash//${directories[type] ?? type}/${name}`;
}

const createProposal: typeof createProposalImpl = (stashDir, input, ctx) =>
  createProposalImpl(
    stashDir,
    { ...input, target: input.target ?? { source: "stash", root: path.resolve(stashDir) } },
    ctx,
  );

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Tests ───────────────────────────────────────────────────────────────────

const VALID_LESSON = `---\ndescription: Use ripgrep before grep\nwhen_to_use: Searching large repos for patterns\n---\n\nPrefer rg over grep when scanning large code repos.\n`;
// A structurally-valid unified workflow (workflow-format-unification): the
// orchestration graph is closed-schema-validated (schemas/akm-workflow.json,
// envelope ∪ workflow-keys), which is what makes it the interesting case for
// #730's provenance stamping (see the workflow-stamping test below).
const VALID_WORKFLOW = `---\ntype: workflow\ndescription: Validate a specification before shipping\nsteps:\n  - id: validate\n---\n\n# Provenance Workflow Stamped\n\n## validate\n\nValidate the specification.\n`;

function indexedEntry(filePath: string): Record<string, unknown> | undefined {
  const db = openExistingDatabase(getDbPath());
  try {
    const row = db.prepare("SELECT document_json FROM entries WHERE file_path = ?").get(filePath) as {
      document_json: string;
    } | null;
    return row ? (JSON.parse(row.document_json) as Record<string, unknown>) : undefined;
  } finally {
    closeDatabase(db);
  }
}

describe("createProposal / listProposals / getProposal", () => {
  test("round-trip: create → list → show → accept materialises asset and emits promoted event", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);

    const createdResult = createProposal(stash, {
      ref: "lessons/rg-over-grep",
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
    expect(showResult.proposal.ref).toBe(durableRef(stash, "lesson", "rg-over-grep"));
    expect(showResult.validation.ok).toBe(true);

    // accept
    const acceptResult = await akmProposalAccept({ stashDir: stash, id: created.id, config });
    expect(acceptResult.ok).toBe(true);
    expect(acceptResult.ref).toBe(durableRef(stash, "lesson", "rg-over-grep"));
    expect(fs.existsSync(acceptResult.assetPath)).toBe(true);
    expect(fs.readFileSync(acceptResult.assetPath, "utf8")).toContain("Prefer rg over grep");

    // status promoted
    const promoted = getProposal(stash, created.id);
    expect(promoted.status).toBe("accepted");
    expect(promoted.review?.outcome).toBe("accepted");

    // promoted event emitted
    const events = readEvents({ type: "promoted" });
    expect(events.events.length).toBe(1);
    expect(events.events[0]?.ref).toBe(durableRef(stash, "lesson", "rg-over-grep"));
    expect((events.events[0]?.metadata as Record<string, unknown> | undefined)?.proposalId).toBe(created.id);
  });

  test.each([
    {
      issue: "unquoted-colon",
      content:
        "---\ndescription: Proposal lint:blocks invalid output.\nwhen_to_use: Testing proposal lint\n---\n\nUseful body.\n",
    },
    {
      issue: "missing-ref",
      content:
        "---\ndescription: Proposal with a missing ref\nwhen_to_use: Testing proposal lint\nxrefs:\n  - memories/proposal-lint-missing\n---\n\nUseful body.\n",
    },
    {
      issue: "stale-path",
      content:
        "---\ndescription: Proposal with a stale path\nwhen_to_use: Testing proposal lint\n---\n\nUse /tmp/akm-proposal-lint-path-that-does-not-exist.\n",
    },
  ])("reports $issue findings without blocking publishing", async ({ issue, content }) => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    const slug = `lint-block-${issue}`;
    const createdResult = createProposal(stash, {
      ref: `lessons/${slug}`,
      source: "reflect",
      force: true,
      payload: { content },
    });
    if (isProposalSkipped(createdResult)) throw new Error("unexpected skip");

    const warnings: string[] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    let acceptResult: Awaited<ReturnType<typeof akmProposalAccept>>;
    try {
      acceptResult = await akmProposalAccept({ stashDir: stash, id: createdResult.id, config });
    } finally {
      _setWarnSinkForTests(undefined);
    }

    expect(acceptResult.ok).toBe(true);
    expect(fs.existsSync(path.join(stash, "lessons", `${slug}.md`))).toBe(true);
    expect(getProposal(stash, createdResult.id).status).toBe("accepted");
    expect(readEvents({ type: "promoted" }).events).toHaveLength(1);
    expect(warnings.some((line) => line.includes(issue))).toBe(true);
  });

  test("promotes a long quoted colon description after provenance serialization wraps it", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    const description =
      "A long proposal description: this remains a valid quoted YAML scalar even when provenance stamping wraps it across physical lines.";
    const content = `---\ntype: lesson\ndescription: ${JSON.stringify(description)}\nwhen_to_use: Testing wrapped quoted descriptions\n---\n\nUseful body.\n`;
    const createdResult = createProposal(stash, {
      ref: "lessons/wrapped-quoted-description",
      source: "reflect",
      force: true,
      payload: { content },
    });
    if (isProposalSkipped(createdResult)) throw new Error("unexpected skip");

    expect(akmProposalShow({ stashDir: stash, id: createdResult.id, config }).validation.ok).toBe(true);
    const accepted = await akmProposalAccept({ stashDir: stash, id: createdResult.id, config });
    const written = fs.readFileSync(accepted.assetPath, "utf8");
    const parsed = parseFrontmatter(written);

    expect(parsed.data.description).toBe(description);
    expect(checkUnquotedDescriptionColon(parsed.frontmatter)).toBeNull();
  });

  test("reject path: archive contains entry, status rejected, rejected event emitted", async () => {
    const stash = makeStashDir();
    const createdResult2 = createProposal(stash, {
      ref: "lessons/bad-idea",
      source: "reflect",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(createdResult2)) throw new Error("unexpected skip");
    const created = createdResult2;

    const result = await akmProposalReject({ stashDir: stash, id: created.id, reason: "duplicate of existing lesson" });
    expect(result.ok).toBe(true);
    expect(result.proposal.status).toBe("rejected");
    expect(result.proposal.review?.reason).toBe("duplicate of existing lesson");

    // archived (rejected) listing contains it
    const archived = listProposals(stash, { status: "rejected", includeArchive: true });
    expect(archived.map((p) => p.id)).toEqual([created.id]);

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
      ref: "lessons/dup",
      source: "reflect",
      force: true,
      payload: { content: VALID_LESSON },
    });
    const bResult = createProposal(stash, {
      ref: "lessons/dup",
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

describe("ref-filter parse failures are LOUD (D-R3)", () => {
  // Legacy `type:name` built via interpolation so the test-ref-literal ratchet
  // never counts it (the type keyword is not literally adjacent to the colon).
  const legacyRef = `skill:${"deploy"}`;
  const qualifiedLegacyRef = `stash//lesson:${"retired"}`;

  test("listProposals --ref with an unparseable filter throws UsageError, not a silent empty list", () => {
    const stash = makeStashDir();
    createProposal(stash, {
      ref: "lessons/rg-over-grep",
      source: "distill",
      force: true,
      payload: { content: VALID_LESSON },
    });
    // A retired legacy `type:name` filter no longer silently matches nothing.
    expect(() => listProposals(stash, { ref: legacyRef })).toThrow(UsageError);
    expect(() => listProposals(stash, { ref: qualifiedLegacyRef })).toThrow(UsageError);
    // Non-AKM opaque concept IDs remain valid identity syntax.
    expect(listProposals(stash, { ref: "!!not-a-ref!!" })).toEqual([]);
  });

  test("a VALID 0.9.0 ref filter still returns results (no false loudness)", () => {
    const stash = makeStashDir();
    createProposal(stash, {
      ref: "lessons/rg-over-grep",
      source: "distill",
      force: true,
      payload: { content: VALID_LESSON },
    });
    const matched = listProposals(stash, { ref: "lessons/rg-over-grep" });
    expect(matched).toHaveLength(1);
    const none = listProposals(stash, { ref: "lessons/does-not-exist" });
    expect(none).toHaveLength(0);
  });

  test("resolveProposalId with a legacy ref throws UsageError instead of silently falling through", () => {
    const stash = makeStashDir();
    createProposal(stash, {
      ref: "lessons/rg-over-grep",
      source: "distill",
      force: true,
      payload: { content: VALID_LESSON },
    });
    expect(() => resolveProposalId(stash, legacyRef)).toThrow(UsageError);
    expect(() => resolveProposalId(stash, qualifiedLegacyRef)).toThrow(UsageError);
  });

  test("an opaque colon concept that is not a retired AKM type remains valid identity syntax", () => {
    const stash = makeStashDir();
    expect(listProposals(stash, { ref: "stash//external:record" })).toEqual([]);
  });
});

describe("diff path", () => {
  test("new asset: shows new-asset diff with /dev/null marker", () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    const proposalResult = createProposal(stash, {
      ref: "lessons/fresh",
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
      ref: "lessons/rg-over-grep",
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
  test("invalid task is rejected at queue time without replacing an indexed task", async () => {
    const stash = makeStashDir();
    const taskDir = path.join(stash, "tasks");
    fs.mkdirSync(taskDir, { recursive: true });
    const taskPath = path.join(taskDir, "queued-guard.yml");
    const original = 'version: 2\nschedule: "0 2 * * *"\nenabled: true\ncommand: ["akm", "index"]\n';
    fs.writeFileSync(taskPath, original, "utf8");
    await akmIndex({ stashDir: stash });
    expect(indexedEntry(taskPath)).toBeDefined();

    expect(() =>
      createProposal(stash, {
        ref: "tasks/queued-guard",
        source: "reflect",
        force: true,
        payload: {
          content: 'version: 2\nschedule: "0 2 * * *"\nenabled: true\nprompt: invalid\ncommand: ["akm", "health"]\n',
        },
      }),
    ).toThrow("invalid task structure");
    expect(fs.readFileSync(taskPath, "utf8")).toBe(original);
    expect(indexedEntry(taskPath)).toBeDefined();
    expect(listProposals(stash, { status: "pending" })).toHaveLength(0);
  });

  test("invalid lesson frontmatter → accept fails non-zero with clear error", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    const proposalResult3 = createProposal(stash, {
      ref: "lessons/no-fields",
      source: "distill",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(proposalResult3)) throw new Error("unexpected skip");
    const proposal = proposalResult3;

    // Simulate an invalid row queued before canonical lesson validation existed.
    const state = openStateDatabase();
    try {
      state
        .prepare("UPDATE proposals SET content = ? WHERE id = ?")
        .run(`---\ndescription: ""\nwhen_to_use: ""\n---\n\nbody\n`, proposal.id);
    } finally {
      state.close();
    }

    const report = validateProposal(getProposal(stash, proposal.id));
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

  test("queued invalid task cannot replace an indexed task", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    const taskDir = path.join(stash, "tasks");
    fs.mkdirSync(taskDir, { recursive: true });
    const taskPath = path.join(taskDir, "nightly.yml");
    const original = "version: 4\nrun: akm index\n";
    fs.writeFileSync(taskPath, original, "utf8");
    await akmIndex({ stashDir: stash });
    expect(indexedEntry(taskPath)).toBeDefined();

    const created = createProposal(stash, {
      ref: "tasks/nightly",
      source: "reflect",
      force: true,
      payload: { content: original.replace("index", "health") },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");
    const state = openStateDatabase();
    try {
      state
        .prepare("UPDATE proposals SET content = ? WHERE id = ?")
        .run("version: 4\nrun: akm health\nuses: akm/command\n", created.id);
    } finally {
      state.close();
    }

    await expect(akmProposalAccept({ stashDir: stash, id: created.id, config })).rejects.toThrow(
      "invalid-task-structure",
    );
    expect(fs.readFileSync(taskPath, "utf8")).toBe(original);
    expect(indexedEntry(taskPath)).toBeDefined();
    expect(getProposal(stash, created.id).status).toBe("pending");
  });

  test("empty content → createProposal rejects with INVALID_PROPOSAL", () => {
    const stash = makeStashDir();
    let threw = false;
    let code: string | undefined;
    try {
      createProposal(stash, {
        ref: "lessons/empty",
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

  test("queued workflow with an unbound heading cannot replace an indexed workflow", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    const workflowDir = path.join(stash, "workflows");
    fs.mkdirSync(workflowDir, { recursive: true });
    const workflowPath = path.join(workflowDir, "ship-feature-from-spec.md");
    const original =
      "---\ntype: workflow\nsteps:\n  - id: validate\n---\n\n# Ship Feature From Spec\n\n## validate\n\nValidate the specification.\n";
    // A level-2 heading that does not exactly match a declared step id — the
    // body-binder's rule 1 violation (workflow-format-unification).
    const invalid = original.replace("## validate", "## Validate Inputs");
    fs.writeFileSync(workflowPath, original, "utf8");
    await akmIndex({ stashDir: stash });
    expect(indexedEntry(workflowPath)).toBeDefined();

    const created = createProposal(stash, {
      ref: "workflows/ship-feature-from-spec",
      source: "reflect",
      force: true,
      payload: { content: original.replace("Validate the specification.", "Validate the updated specification.") },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");

    // Simulate a structurally-invalid row queued before workflow proposal validation existed.
    const state = openStateDatabase();
    try {
      state.prepare("UPDATE proposals SET content = ? WHERE id = ?").run(invalid, created.id);
    } finally {
      state.close();
    }

    await expect(akmProposalAccept({ stashDir: stash, id: created.id, config })).rejects.toThrow(
      "invalid-workflow-structure",
    );
    expect(fs.readFileSync(workflowPath, "utf8")).toBe(original);
    expect(indexedEntry(workflowPath)).toBeDefined();
    expect(getProposal(stash, created.id).status).toBe("pending");
  });
});

// ── #284 GAP-HIGH backfill ───────────────────────────────────────────────────

describe("akmProposalReject — non-pending status (#284 HIGH 4)", () => {
  test("rejecting an already-archived proposal → UsageError with .code INVALID_FLAG_VALUE", async () => {
    const stash = makeStashDir();
    const createdResult3 = createProposal(stash, {
      ref: "lessons/once",
      source: "reflect",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(createdResult3)) throw new Error("unexpected skip");
    const created = createdResult3;
    // First reject moves it to the archive.
    await akmProposalReject({ stashDir: stash, id: created.id });
    // Second reject must fail with a typed UsageError (.code load-bearing).
    let thrown: unknown;
    try {
      await akmProposalReject({ stashDir: stash, id: created.id });
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
  test("akmProposalShow on missing id → NotFoundError with .code PROPOSAL_NOT_FOUND", () => {
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
    expect(e.code).toBe("PROPOSAL_NOT_FOUND");
  });

  test("akmProposalDiff on missing id → NotFoundError with .code PROPOSAL_NOT_FOUND", () => {
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
    expect(e.code).toBe("PROPOSAL_NOT_FOUND");
  });
});

describe("akmProposalAccept — validation failure (#284 HIGH 6)", () => {
  test("validation failure → no `promoted` event emitted; proposal stays pending", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    const proposalResult5 = createProposal(stash, {
      ref: "lessons/invalid",
      source: "distill",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(proposalResult5)) throw new Error("unexpected skip");
    const proposal = proposalResult5;
    const state = openStateDatabase();
    try {
      state.prepare("UPDATE proposals SET content = ? WHERE id = ?").run("x", proposal.id);
    } finally {
      state.close();
    }

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
  test("fingerprint_match: a second mint with identical inputs is skipped without force", () => {
    const stash = makeStashDir();
    const first = createProposal(stash, {
      ref: "lessons/dup-test",
      source: "reflect",
      payload: { content: VALID_LESSON },
    });
    expect(isProposalSkipped(first)).toBe(false);

    // Same target (absent), source, and (absent) model — the differing content
    // is not a fingerprint term (§23.6: INPUT fingerprint).
    const second = createProposal(stash, {
      ref: "lessons/dup-test",
      source: "reflect",
      payload: { content: VALID_LESSON.replace("Prefer rg", "Prefer fd") },
    });
    expect(isProposalSkipped(second)).toBe(true);
    if (!isProposalSkipped(second)) throw new Error("type guard");
    expect(second.reason).toBe("fingerprint_match");
  });

  test("fingerprint changes with the target's before-state: the second mint queues alongside", () => {
    const stash = makeStashDir();
    const first = createProposal(stash, {
      ref: "lessons/hash-test",
      source: "distill",
      payload: { content: VALID_LESSON },
    });
    expect(isProposalSkipped(first)).toBe(false);

    // Materialise the target so the mint-time before-hash (a fingerprint term)
    // changes — the old ref+source duplicate_pending guard is retired.
    const assetPath = path.join(stash, "lessons", "hash-test.md");
    fs.mkdirSync(path.dirname(assetPath), { recursive: true });
    fs.writeFileSync(assetPath, "On-disk target content.\n", "utf8");

    const second = createProposal(stash, {
      ref: "lessons/hash-test",
      source: "distill",
      payload: { content: VALID_LESSON },
    });
    expect(isProposalSkipped(second)).toBe(false);
  });

  test("rejection_backoff: new inputs are skipped for ref+source within the window after rejection", () => {
    const stash = makeStashDir();
    const first = createProposal(stash, {
      ref: "lessons/cooldown-test",
      source: "reflect",
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(first)) throw new Error("unexpected skip");
    archiveProposal(stash, first.id, "rejected", "Test rejection for cooldown");

    // Change the target so the second mint is a genuinely new fingerprint —
    // the retained backoff (not the fingerprint) must fire.
    const assetPath = path.join(stash, "lessons", "cooldown-test.md");
    fs.mkdirSync(path.dirname(assetPath), { recursive: true });
    fs.writeFileSync(assetPath, "On-disk target content.\n", "utf8");

    const second = createProposal(stash, {
      ref: "lessons/cooldown-test",
      source: "reflect",
      payload: { content: VALID_LESSON.replace("Prefer rg", "Prefer fd") },
    });
    expect(isProposalSkipped(second)).toBe(true);
    if (!isProposalSkipped(second)) throw new Error("type guard");
    expect(second.reason).toBe("rejection_backoff");
    expect(second.message).toContain("14d window");
  });

  test("force:true bypasses all guards", () => {
    const stash = makeStashDir();
    const first = createProposal(stash, {
      ref: "lessons/force-test",
      source: "reflect",
      payload: { content: VALID_LESSON },
    });
    expect(isProposalSkipped(first)).toBe(false);

    const second = createProposal(stash, {
      ref: "lessons/force-test",
      source: "reflect",
      force: true,
      payload: { content: VALID_LESSON },
    });
    expect(isProposalSkipped(second)).toBe(false);
  });

  test("different sources for same ref are independent — no cross-source dedup", () => {
    const stash = makeStashDir();
    const reflectResult = createProposal(stash, {
      ref: "lessons/cross-source",
      source: "reflect",
      payload: { content: VALID_LESSON },
    });
    const distillResult = createProposal(stash, {
      ref: "lessons/cross-source",
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
      ref: "lessons/f4-valid-source",
      source: "reflect",
      sourceRun: "run-abc-123",
      payload: { content: VALID_LESSON },
    });
    expect(isProposalSkipped(result)).toBe(false);
    const proposal = result as import("../../../src/commands/proposal/repository").Proposal;
    expect(proposal.source).toBe("reflect");
    expect(proposal.sourceRun).toBe("run-abc-123");
  });

  test("createProposal accepts unknown source strings (backward-compatible)", () => {
    const stash = makeStashDir();
    // Unknown source should NOT throw — it emits a warning but creates the proposal.
    const result = createProposal(stash, {
      ref: "lessons/f4-unknown-source",
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
      ref: "lessons/confidence-valid",
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
      ref: "lessons/confidence-zero",
      source: "reflect",
      force: true,
      payload: { content: VALID_LESSON },
      confidence: 0,
    });
    const one = createProposal(stash, {
      ref: "lessons/confidence-one",
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
      ref: "lessons/confidence-undefined",
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
      { ref: "lessons/c-nan", value: Number.NaN },
      { ref: "lessons/c-inf", value: Number.POSITIVE_INFINITY },
      { ref: "lessons/c-neg", value: -0.1 },
      { ref: "lessons/c-hi", value: 1.5 },
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
        ref: "lessons/expire-old-a",
        source: "reflect",
        force: true,
        payload: { content: VALID_LESSON },
      },
      { now: () => NOW - 60 * DAY },
    );
    const oldB = createProposal(
      stash,
      {
        ref: "lessons/expire-old-b",
        source: "distill",
        force: true,
        payload: { content: VALID_LESSON },
      },
      { now: () => NOW - 31 * DAY },
    );
    const fresh = createProposal(
      stash,
      {
        ref: "lessons/expire-fresh",
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
    expect(expiredRefs).toEqual(
      [durableRef(stash, "lesson", "expire-old-a"), durableRef(stash, "lesson", "expire-old-b")].sort(),
    );

    // The fresh proposal remains pending.
    const stillPending = listProposals(stash, { status: "pending" });
    expect(stillPending.length).toBe(1);
    expect(stillPending[0]?.ref).toBe(durableRef(stash, "lesson", "expire-fresh"));

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
        ref: "lessons/idem-1",
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
        ref: "lessons/event-a",
        source: "reflect",
        force: true,
        payload: { content: VALID_LESSON },
      },
      { now: () => NOW - 30 * DAY },
    );
    const b = createProposal(
      stash,
      {
        ref: "lessons/event-b",
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
    expect(expiredRefs).toEqual(
      [durableRef(stash, "lesson", "event-a"), durableRef(stash, "lesson", "event-b")].sort(),
    );
  });

  test("retentionDays === 0 disables expiration entirely", () => {
    const stash = makeStashDir();
    const config: AkmConfig = { ...makeConfig(stash), archiveRetentionDays: 0 } as AkmConfig;
    const NOW = Date.UTC(2026, 5, 1);
    const DAY = 86_400_000;
    createProposal(
      stash,
      {
        ref: "lessons/ttl-off",
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
  // RUNTIME-07(e): the three "waits for the shared asset-mutation lease"
  // tests below used to burn a real `Bun.sleep(150)` between starting the
  // mutation and asserting it hasn't completed yet. That sleep was not
  // needed for correctness and was a source of narrow-margin timing risk on
  // a loaded runner. `withAssetMutationLease` (src/indexer/index-writer-lock.ts,
  // `acquireAssetMutationLease`) makes its FIRST lock-acquisition attempt
  // (`tryAcquireMaintenanceBarrier` + `tryAcquireLockSync` + `probeLock`,
  // src/core/file-lock.ts) entirely synchronously — none of those calls
  // `await` anything. Per JS async-function semantics, that means by the
  // time `akmProposalAccept`/`akmProposalReject`/`akmProposalRevert` returns
  // a pending promise to the caller, the first attempt has ALREADY run
  // synchronously and failed against the lockPath we wrote (since it exists
  // on disk before the call), and the loop is already parked on a real
  // `await delay(100)`. So the "not done yet" assertion is true the instant
  // the call returns — no sleep, real or fake, is required to observe it,
  // and none of these three tests carry any margin-based flake risk (unlike
  // the elapsed-vs-timeout percentage check in llm-client.test.ts).
  test("accept waits for the shared asset-mutation lease", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    const created = createProposal(stash, {
      ref: "lessons/serialized-proposal",
      source: "distill",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");
    const assetPath = path.join(stash, "lessons", "serialized-proposal.md");
    const lockPath = getIndexWriterLockPath();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }), "utf8");

    const accepting = akmProposalAccept({ stashDir: stash, id: created.id, config });
    expect(fs.existsSync(assetPath)).toBe(false);
    fs.rmSync(lockPath, { force: true });
    await accepting;
    expect(fs.existsSync(assetPath)).toBe(true);
  });

  test("reject waits for the shared asset-mutation lease", async () => {
    const stash = makeStashDir();
    const created = createProposal(stash, {
      ref: "lessons/serialized-reject",
      source: "distill",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");
    const lockPath = getIndexWriterLockPath();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }), "utf8");

    const rejecting = Promise.resolve(
      akmProposalReject({ stashDir: stash, id: created.id, reason: "serialized rejection" }),
    );
    expect(getProposal(stash, created.id).status).toBe("pending");
    fs.rmSync(lockPath, { force: true });
    await rejecting;
    expect(getProposal(stash, created.id).status).toBe("rejected");
  });

  test("accept refuses to overwrite when the existing asset backup cannot be read", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    const assetPath = path.join(stash, "lessons", "backup-read-failure.md");
    const original =
      "---\ndescription: Original backup content\nwhen_to_use: Testing strict backup reads\n---\n\nORIGINAL.\n";
    fs.writeFileSync(assetPath, original, "utf8");
    const created = createProposal(stash, {
      ref: "lessons/backup-read-failure",
      source: "distill",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");
    const originalRead = fs.readFileSync;
    const readSpy = spyOn(fs, "readFileSync").mockImplementation(((
      file: fs.PathOrFileDescriptor,
      ...args: unknown[]
    ) => {
      if (path.resolve(String(file)) === path.resolve(assetPath)) throw new Error("injected backup read failure");
      return originalRead(file, ...(args as [BufferEncoding?]));
    }) as typeof fs.readFileSync);

    await expect(akmProposalAccept({ stashDir: stash, id: created.id, config })).rejects.toThrow("backup");
    readSpy.mockRestore();
    expect(fs.readFileSync(assetPath, "utf8")).toBe(original);
    expect(getProposal(stash, created.id).status).toBe("pending");
  });

  test("revert waits for the shared asset-mutation lease", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    const assetPath = path.join(stash, "lessons", "serialized-revert.md");
    const original =
      "---\ndescription: Original serialized revert\nwhen_to_use: Testing mutation serialization\n---\n\nORIGINAL.\n";
    fs.writeFileSync(assetPath, original, "utf8");
    const created = createProposal(stash, {
      ref: "lessons/serialized-revert",
      source: "distill",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");
    await akmProposalAccept({ stashDir: stash, id: created.id, config });
    const lockPath = getIndexWriterLockPath();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }), "utf8");

    const reverting = akmProposalRevert({ stashDir: stash, id: created.id, config });
    expect(fs.readFileSync(assetPath, "utf8")).toContain("Prefer rg over grep");
    fs.rmSync(lockPath, { force: true });
    await reverting;
    expect(fs.readFileSync(assetPath, "utf8")).toBe(original);
  });

  test("accept indexes the promoted asset immediately", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    fs.writeFileSync(path.join(stash, "memories", "index-seed.md"), "Index seed.\n", "utf8");
    await akmIndex({ stashDir: stash });

    const created = createProposal(stash, {
      ref: "lessons/immediate-index",
      source: "distill",
      force: true,
      payload: {
        content:
          "---\ndescription: accepted zanzibar marker\nwhen_to_use: Verifying proposal indexing\n---\n\nIndexed immediately.\n",
      },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");

    const accepted = await akmProposalAccept({ stashDir: stash, id: created.id, config });
    expect(indexedEntry(accepted.assetPath)?.description).toBe("accepted zanzibar marker");
  });

  test("revert reindexes the restored asset immediately", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    const lessonPath = path.join(stash, "lessons", "revert-index.md");
    const original =
      "---\ndescription: restored orchid marker\nwhen_to_use: Verifying proposal revert indexing\n---\n\nOriginal.\n";
    fs.writeFileSync(lessonPath, original, "utf8");
    await akmIndex({ stashDir: stash });

    const created = createProposal(stash, {
      ref: "lessons/revert-index",
      source: "distill",
      force: true,
      payload: {
        content:
          "---\ndescription: accepted zanzibar marker\nwhen_to_use: Verifying proposal revert indexing\n---\n\nAccepted.\n",
      },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");
    const accepted = await akmProposalAccept({ stashDir: stash, id: created.id, config });
    // Establish the accepted index state independently so this test isolates
    // the revert path rather than depending on the accept-path assertion above.
    await indexWrittenAssets(stash, [accepted.assetPath]);
    expect(indexedEntry(lessonPath)?.description).toBe("accepted zanzibar marker");

    await akmProposalRevert({ stashDir: stash, id: created.id, config });
    expect(indexedEntry(lessonPath)?.description).toBe("restored orchid marker");
  });

  test("revert removes the accepted index row when restored workflow content is unindexable", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    const workflowDir = path.join(stash, "workflows");
    fs.mkdirSync(workflowDir, { recursive: true });
    const workflowPath = path.join(workflowDir, "revert-unindexable.md");
    fs.writeFileSync(workflowPath, "---\ndescription: Broken original\n---\n\nNo workflow heading.\n", "utf8");
    fs.writeFileSync(path.join(stash, "memories", "workflow-index-seed.md"), "Index seed.\n", "utf8");
    await akmIndex({ stashDir: stash });
    const created = createProposal(stash, {
      ref: "workflows/revert-unindexable",
      source: "propose",
      force: true,
      payload: {
        content:
          "---\ntype: workflow\ndescription: Valid accepted workflow\nsteps:\n  - id: first\n---\n\n# Accepted\n\n## first\n\nRun.\n",
      },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");
    await akmProposalAccept({ stashDir: stash, id: created.id, config });
    expect(indexedEntry(workflowPath)).toBeDefined();

    await akmProposalRevert({ stashDir: stash, id: created.id, config });
    expect(indexedEntry(workflowPath)).toBeUndefined();
  });

  test("backup is captured when target asset exists; backupContent present on archived proposal", async () => {
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
      ref: "lessons/rg-over-grep",
      source: "distill",
      sourceRun: "run-backup",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");

    const accepted = await akmProposalAccept({ stashDir: stash, id: created.id, config });
    expect(accepted.ok).toBe(true);

    // Backup content should be carried on the archived proposal record.
    const reloaded = getProposal(stash, created.id);
    expect(reloaded.backupContent).toContain("Original body content.");

    // New asset content was actually written.
    expect(fs.readFileSync(lessonPath, "utf8")).toContain("Prefer rg over grep");
  });

  test("backup is NOT captured when target asset does not yet exist (new asset proposal)", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    const created = createProposal(stash, {
      ref: "lessons/brand-new",
      source: "reflect",
      sourceRun: "run-new",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");

    await akmProposalAccept({ stashDir: stash, id: created.id, config });
    const reloaded = getProposal(stash, created.id);
    expect(reloaded.backupContent).toBeUndefined();
  });

  test("revert on an accepted proposal restores prior content and marks status=reverted", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    // Existing asset → promotion captures backup.
    const lessonPath = path.join(stash, "lessons", "rg-over-grep.md");
    fs.writeFileSync(lessonPath, `---\ndescription: Original D\nwhen_to_use: Original U\n---\n\nORIGINAL.\n`, "utf8");
    const created = createProposal(stash, {
      ref: "lessons/rg-over-grep",
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
    expect(revertResult.ref).toBe(durableRef(stash, "lesson", "rg-over-grep"));
    // Prior content is back.
    expect(fs.readFileSync(lessonPath, "utf8")).toContain("ORIGINAL.");
    // Status flipped to reverted.
    const reloaded = getProposal(stash, created.id);
    expect(reloaded.status).toBe("reverted");
    expect(reloaded.review?.reason).toMatch(/reverted/);

    // proposal_reverted event was emitted with the expected ref.
    const revertedEvents = readEvents({ type: "proposal_reverted" });
    expect(revertedEvents.events.length).toBe(1);
    expect(revertedEvents.events[0]?.ref).toBe(durableRef(stash, "lesson", "rg-over-grep"));
  });

  test("reverting proposal A refuses to clobber content accepted from proposal B", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    const assetPath = path.join(stash, "lessons", "stacked-proposals.md");
    fs.writeFileSync(
      assetPath,
      "---\ndescription: Original stacked content\nwhen_to_use: Testing revert ownership\n---\n\nORIGINAL.\n",
      "utf8",
    );
    const aContent =
      "---\ndescription: Proposal A accepted content\nwhen_to_use: Testing revert ownership\n---\n\nPROPOSAL A.\n";
    const bContent =
      "---\ndescription: Proposal B accepted content\nwhen_to_use: Testing revert ownership\n---\n\nPROPOSAL B.\n";
    const proposalA = createProposal(stash, {
      ref: "lessons/stacked-proposals",
      source: "distill",
      force: true,
      payload: { content: aContent },
    });
    if (isProposalSkipped(proposalA)) throw new Error("unexpected skip");
    await akmProposalAccept({ stashDir: stash, id: proposalA.id, config });
    expect(getProposal(stash, proposalA.id).acceptedTarget?.contentHash).toBeDefined();

    const proposalB = createProposal(stash, {
      ref: "lessons/stacked-proposals",
      source: "distill",
      force: true,
      payload: { content: bContent },
    });
    if (isProposalSkipped(proposalB)) throw new Error("unexpected skip");
    await akmProposalAccept({ stashDir: stash, id: proposalB.id, config });
    // D2 (#730): promotion stamps OKF v0.2 provenance (generated/verified) onto
    // the written frontmatter, so the on-disk bytes are no longer expected to be
    // byte-identical to the pre-stamp `proposalB.payload.content` — snapshot what
    // accept ACTUALLY wrote and assert the refused revert leaves THAT untouched.
    const afterBAccept = fs.readFileSync(assetPath, "utf8");
    expect(afterBAccept).toContain("Proposal B accepted content");
    expect(afterBAccept).toContain("PROPOSAL B.");

    await expect(akmProposalRevert({ stashDir: stash, id: proposalA.id, config })).rejects.toThrow(
      /changed|hash|content/i,
    );
    expect(fs.readFileSync(assetPath, "utf8")).toBe(afterBAccept);
    expect(getProposal(stash, proposalA.id).status).toBe("accepted");
  });

  test("an accepted proposal without acceptedTarget is not derived or backfilled", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    const assetPath = path.join(stash, "lessons", "missing-accepted-target.md");
    const original =
      "---\ndescription: Original current content\nwhen_to_use: Testing required accepted targets\n---\n\nORIGINAL.\n";
    fs.writeFileSync(assetPath, original, "utf8");
    const created = createProposal(stash, {
      ref: "lessons/missing-accepted-target",
      source: "distill",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");
    await akmProposalAccept({ stashDir: stash, id: created.id, config });
    // D2 (#730): promotion stamps OKF v0.2 provenance onto the written
    // frontmatter — snapshot what accept ACTUALLY wrote (rather than assuming
    // byte-identity with the pre-stamp `created.payload.content`) and assert
    // the refused revert below leaves THAT untouched.
    const afterAccept = fs.readFileSync(assetPath, "utf8");
    expect(afterAccept).toContain("Prefer rg over grep");

    const state = openStateDatabase();
    const row = state.prepare("SELECT metadata_json FROM proposals WHERE id = ?").get(created.id) as {
      metadata_json: string;
    };
    const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    delete metadata.acceptedTarget;
    state.prepare("UPDATE proposals SET metadata_json = ? WHERE id = ?").run(JSON.stringify(metadata), created.id);
    state.close();

    await expect(akmProposalRevert({ stashDir: stash, id: created.id, config })).rejects.toThrow(
      /has no recorded target/i,
    );
    expect(fs.readFileSync(assetPath, "utf8")).toBe(afterAccept);
    expect(getProposal(stash, created.id).acceptedTarget).toBeUndefined();
  });

  test("revert is bound to the source/root/path used by accept", async () => {
    const stash = makeStashDir();
    const other = makeStashDir();
    const config = {
      bundles: {
        primary: { path: stash, writable: true },
        other: { path: other, writable: true },
      } as AkmConfig["bundles"],
      defaultBundle: "primary",
      defaultWriteTarget: "primary",
    } as AkmConfig;
    const original =
      "---\ndescription: Bound original content\nwhen_to_use: Testing target ownership binding\n---\n\nORIGINAL.\n";
    fs.writeFileSync(path.join(stash, "lessons", "bound-revert.md"), original, "utf8");
    const created = createProposal(stash, {
      ref: "lessons/bound-revert",
      source: "distill",
      force: true,
      target: { source: "primary", root: stash },
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");
    await akmProposalAccept({ stashDir: stash, id: created.id, config, target: "primary" });
    fs.writeFileSync(path.join(other, "lessons", "bound-revert.md"), VALID_LESSON, "utf8");

    await expect(akmProposalRevert({ stashDir: stash, id: created.id, config, target: "other" })).rejects.toThrow(
      /target|source|path|bound/i,
    );
    expect(fs.readFileSync(path.join(other, "lessons", "bound-revert.md"), "utf8")).toBe(VALID_LESSON);
    expect(getProposal(stash, created.id).status).toBe("accepted");
  });

  test("revert on a non-accepted proposal fails with UsageError(INVALID_FLAG_VALUE)", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    const created = createProposal(stash, {
      ref: "lessons/not-accepted-revert",
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
      ref: "lessons/no-backup-revert",
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

  test("revert on a missing proposal id surfaces NotFoundError(PROPOSAL_NOT_FOUND)", async () => {
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
    expect(e.code).toBe("PROPOSAL_NOT_FOUND");
  });
});

// ── D2 (#730) — promoteProposal stamps OKF v0.2 provenance on AKM-native writes ─
//
// generated.by actor convention (documented judgment call, see PR body):
//   - the SOURCE that produced the content decides `generated.by`: an
//     AUTOMATED_PROPOSAL_SOURCES proposal (reflect/distill/consolidate/
//     extract/improve/schema-repair) stamps `akm/<pkgVersion>`; a
//     human-initiated source (propose/remember/import) stamps
//     `human:<actorId>`.
//   - the ACCEPTANCE event (independent of content origin) decides
//     `verified[0].by`: a `gateDecision` passed to promoteProposal (the
//     automated drain/triage path) stamps `akm/<pkgVersion>`; its absence
//     (a human explicitly ran `akm proposal accept`) stamps
//     `human:<actorId>`.
// `ctx.actorId` is a new ProposalsContext test seam (mirrors the existing
// `now`/`randomUUID` seams) so these assertions never depend on the real
// OS username of whatever machine runs the suite.
describe("D2 (#730): promoteProposal stamps OKF v0.2 provenance onto AKM-native writes", () => {
  // Reads the HYBRID on-disk shape settled by the #730 review: `generated:` and
  // `verified:` are stamped BARE at the top level (OKF v0.2's own spelling, so a
  // third-party OKF reader sees conformant trust metadata), while `sources`
  // alone stays namespaced under `provenance:` because a bare top-level
  // `sources:` collides with the wiki citation-string convention. Flattened
  // here so the assertions below read the same either way.
  function readWrittenProvenance(assetPath: string): {
    generatedBy?: string;
    generatedAt?: string;
    verified?: Array<{ by: string; at?: string }>;
    sources?: Array<{ resource: string }>;
  } {
    const raw = fs.readFileSync(assetPath, "utf8");
    const fm = parseFrontmatter(raw).data as Record<string, unknown>;
    const generated = (fm.generated ?? {}) as { by?: string; at?: string };
    const nested = (fm.provenance ?? {}) as { sources?: Array<{ resource: string }> };
    return {
      ...(generated.by !== undefined ? { generatedBy: generated.by } : {}),
      ...(generated.at !== undefined ? { generatedAt: generated.at } : {}),
      ...(Array.isArray(fm.verified) ? { verified: fm.verified as Array<{ by: string; at?: string }> } : {}),
      ...(nested.sources !== undefined ? { sources: nested.sources } : {}),
    };
  }

  // Pins the on-disk spelling itself, not just the flattened projection — the
  // whole point of the hybrid shape is WHERE these keys live.
  function readRawFrontmatter(assetPath: string): Record<string, unknown> {
    return parseFrontmatter(fs.readFileSync(assetPath, "utf8")).data as Record<string, unknown>;
  }

  test("automated source (distill) + human accept (no gateDecision): generated.by=akm/<version>, verified.by=human:<actorId>", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    const created = createProposal(stash, {
      ref: "lessons/provenance-distill-human-accept",
      source: "distill",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");

    const result = await akmProposalAccept({
      stashDir: stash,
      id: created.id,
      config,
      ctx: { actorId: () => "test-human" },
    });

    const provenance = readWrittenProvenance(result.assetPath);
    expect(provenance.generatedBy).toBe(`akm/${pkgVersion}`);
    expect(typeof provenance.generatedAt).toBe("string");
    expect(new Date(provenance.generatedAt as string).toString()).not.toBe("Invalid Date");
    expect(provenance.verified).toHaveLength(1);
    expect(provenance.verified?.[0]?.by).toBe("human:test-human");
    expect(typeof provenance.verified?.[0]?.at).toBe("string");

    // The hybrid shape itself: `generated`/`verified` bare at the top level in
    // OKF v0.2's own spelling, and NOT nested under `provenance:`. A regression
    // to the fully-nested shape would silently break third-party OKF readers,
    // which is the entire reason this shape was chosen.
    const fm = readRawFrontmatter(result.assetPath);
    expect(fm.generated).toMatchObject({ by: `akm/${pkgVersion}` });
    expect(Array.isArray(fm.verified)).toBe(true);
    expect(fm.provenance).toBeUndefined();
  });

  test("workflow — the one closed-allowlist type — is stamped, not silently skipped", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    const created = createProposal(stash, {
      ref: "workflows/provenance-workflow-stamped",
      source: "distill",
      force: true,
      payload: { content: VALID_WORKFLOW },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");

    const result = await akmProposalAccept({
      stashDir: stash,
      id: created.id,
      config,
      ctx: { actorId: () => "test-human" },
    });

    // `workflow` is the only type whose frontmatter is parsed against a closed
    // allowlist. Before #730's allowlist update it was the sole type that
    // promoted UNSTAMPED via the re-validation fallback — an undocumented hole.
    const provenance = readWrittenProvenance(result.assetPath);
    expect(provenance.generatedBy).toBe(`akm/${pkgVersion}`);
    expect(provenance.verified?.[0]?.by).toBe("human:test-human");
  });

  test("automated source (distill) auto-accepted via a gate decision: BOTH generated.by and verified.by are akm/<version>", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    const created = createProposal(stash, {
      ref: "lessons/provenance-distill-gate-accept",
      source: "distill",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");

    const result = await akmProposalAccept({
      stashDir: stash,
      id: created.id,
      config,
      ctx: { actorId: () => "should-not-be-used" },
      gateDecision: {
        outcome: "auto-accepted",
        reason: "policy-accept",
        gate: "test-gate",
        decidedAt: "2026-07-01T00:00:00.000Z",
      },
    });

    const provenance = readWrittenProvenance(result.assetPath);
    expect(provenance.generatedBy).toBe(`akm/${pkgVersion}`);
    expect(provenance.verified).toEqual([{ by: `akm/${pkgVersion}`, at: "2026-07-01T00:00:00.000Z" }]);
  });

  test("human-initiated source (propose) accepted directly: generated.by=human:<actorId>, verified.by=human:<actorId>", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    const created = createProposal(stash, {
      ref: "lessons/provenance-human-source",
      source: "propose",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");

    const result = await akmProposalAccept({
      stashDir: stash,
      id: created.id,
      config,
      ctx: { actorId: () => "test-human-2" },
    });

    const provenance = readWrittenProvenance(result.assetPath);
    expect(provenance.generatedBy).toBe("human:test-human-2");
    expect(provenance.verified).toEqual([{ by: "human:test-human-2", at: expect.any(String) as unknown as string }]);
  });

  test("evidenceSources on the promoted content project as provenance.sources ({resource} minimum)", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    const contentWithEvidence =
      "---\ndescription: Use ripgrep before grep\nwhen_to_use: Searching large repos for patterns\n" +
      "evidenceSources:\n  - knowledge/some-ref\n  - knowledge/other-ref\n---\n\n" +
      "Prefer rg over grep when scanning large code repos.\n";
    const created = createProposal(stash, {
      ref: "lessons/provenance-evidence-sources",
      source: "distill",
      force: true,
      payload: { content: contentWithEvidence },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");

    const result = await akmProposalAccept({ stashDir: stash, id: created.id, config });

    const provenance = readWrittenProvenance(result.assetPath);
    expect(provenance.sources).toEqual([{ resource: "knowledge/some-ref" }, { resource: "knowledge/other-ref" }]);
    // The original AKM-native `evidenceSources:` key is left untouched (dual-write, not a rename).
    const fm = parseFrontmatter(fs.readFileSync(result.assetPath, "utf8")).data as Record<string, unknown>;
    expect(fm.evidenceSources).toEqual(["knowledge/some-ref", "knowledge/other-ref"]);
  });

  test("a non-markdown promotion target (task YAML) is never stamped with frontmatter", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    const taskContent = "version: 4\nrun: akm index\n";
    const created = createProposal(stash, {
      ref: "tasks/provenance-not-applicable",
      source: "distill",
      force: true,
      payload: { content: taskContent },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");

    const result = await akmProposalAccept({ stashDir: stash, id: created.id, config });
    expect(fs.readFileSync(result.assetPath, "utf8")).toBe(taskContent);
  });

  test("the promoted asset re-indexes with provenance surfaced on the persisted entry (akm's own adapter rereads what it wrote via DOCUMENT_JSON_CARRIED_FIELDS)", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    fs.writeFileSync(path.join(stash, "memories", "index-seed.md"), "Index seed.\n", "utf8");
    await akmIndex({ stashDir: stash });
    const created = createProposal(stash, {
      ref: "lessons/provenance-reindex-roundtrip",
      source: "distill",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");

    const result = await akmProposalAccept({
      stashDir: stash,
      id: created.id,
      config,
      ctx: { actorId: () => "test-human-3" },
    });

    const entry = indexedEntry(result.assetPath) as { provenance?: Record<string, unknown> };
    expect(entry?.provenance).toBeDefined();
    const provenance = entry?.provenance as { generatedBy?: string; verified?: unknown[] };
    expect(provenance.generatedBy).toBe(`akm/${pkgVersion}`);
    expect(provenance.verified).toHaveLength(1);
  });
});

// ── WI-6.2 — FileChange[] envelope + mint-time beforeHash ───────────────────

describe("createProposal derives the FileChange[] envelope (WI-6.2)", () => {
  test("new target: single create change, after IS the payload content, no beforeHash", () => {
    const stash = makeStashDir();
    const created = createProposal(stash, {
      ref: "lessons/envelope-new",
      source: "reflect",
      sourceRun: "run-envelope",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");

    expect(created.changes).toHaveLength(1);
    const change = created.changes[0];
    expect(change?.op).toBe("create");
    expect(change?.after).toBe(created.payload.content);
    // Mint-time before-state is summarised by beforeHash only — the change
    // body's `before` is a transaction-time capture and must stay unset.
    expect(change?.before).toBeUndefined();
    expect(created.beforeHash).toBeUndefined();
    // The mint-time path resolves against the proposal's own stash, relative.
    expect(change?.path.startsWith("lessons")).toBe(true);
    expect(path.isAbsolute(change?.path ?? "/")).toBe(false);
  });

  test("existing target: update change + beforeHash = sha256 of the on-disk content", () => {
    const stash = makeStashDir();
    const before = "---\ndescription: old\n---\n\nOld body.\n";
    const created0 = createProposal(stash, {
      ref: "lessons/envelope-existing",
      source: "reflect",
      sourceRun: "run-envelope",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(created0)) throw new Error("unexpected skip");
    // Materialise the target at the exact mint-time path the envelope recorded.
    const abs = path.join(stash, created0.changes[0]?.path ?? "");
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, before, "utf8");

    const created = createProposal(stash, {
      ref: "lessons/envelope-existing",
      source: "reflect",
      sourceRun: "run-envelope",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");

    expect(created.changes[0]?.op).toBe("update");
    expect(created.changes[0]?.before).toBeUndefined();
    expect(created.beforeHash).toBe(createHash("sha256").update(before, "utf8").digest("hex"));
  });

  test("round-trip: changes + beforeHash survive persistence (entry-0 after from the content column)", () => {
    const stash = makeStashDir();
    const created = createProposal(stash, {
      ref: "lessons/envelope-roundtrip",
      source: "reflect",
      sourceRun: "run-envelope",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");

    const reread = getProposal(stash, created.id);
    expect(reread.changes).toEqual(created.changes);
    expect(reread.beforeHash).toBe(created.beforeHash);
    expect(reread.changes[0]?.after).toBe(reread.payload.content);
    // The row must NOT duplicate the primary change's after body in metadata.
    const state = openStateDatabase();
    const row = state.prepare("SELECT metadata_json FROM proposals WHERE id = ?").get(created.id) as {
      metadata_json: string;
    };
    state.close();
    const meta = JSON.parse(row.metadata_json) as { changes?: Array<Record<string, unknown>> };
    expect(meta.changes?.[0]?.after).toBeUndefined();
  });

  test("a row without persisted changes (pre-#858/#859 legacy row) reads back with an empty change list", () => {
    const stash = makeStashDir();
    const created = createProposal(stash, {
      ref: "lessons/envelope-legacy",
      source: "reflect",
      sourceRun: "run-envelope",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");
    // Strip the required current envelope to simulate a pre-feature row that
    // never captured `changes` (see #858/#859: ~89% of real archived rows).
    const state = openStateDatabase();
    const row = state.prepare("SELECT metadata_json FROM proposals WHERE id = ?").get(created.id) as {
      metadata_json: string;
    };
    const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    delete metadata.changes;
    delete metadata.beforeHash;
    state.prepare("UPDATE proposals SET metadata_json = ? WHERE id = ?").run(JSON.stringify(metadata), created.id);
    state.close();

    const reread = getProposal(stash, created.id);
    expect(reread.changes).toEqual([]);
    expect(reread.beforeHash).toBeUndefined();
  });

  test("a row with an explicit empty/invalid changes array is still rejected", () => {
    const stash = makeStashDir();
    const created = createProposal(stash, {
      ref: "lessons/envelope-corrupt",
      source: "reflect",
      sourceRun: "run-envelope",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");
    // Distinct from the legacy case above: `changes` is present but empty,
    // which never happens on real (pre- or post-feature) data — this is
    // genuine corruption, not a tolerated legacy gap.
    const state = openStateDatabase();
    const row = state.prepare("SELECT metadata_json FROM proposals WHERE id = ?").get(created.id) as {
      metadata_json: string;
    };
    const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    metadata.changes = [];
    state.prepare("UPDATE proposals SET metadata_json = ? WHERE id = ?").run(JSON.stringify(metadata), created.id);
    state.close();

    expect(() => getProposal(stash, created.id)).toThrow(/missing changes/i);
  });

  test("a row without proposedTarget decodes with the field omitted (#859)", () => {
    // #859 reopening: proposedTarget is envelope metadata absent from ~93% of
    // the real archive's accepted/rejected rows. An already-decided proposal
    // is counted and displayed, never re-applied, so its absence must not
    // block read (list/get) the way a genuinely corrupt row does.
    const stash = makeStashDir();
    const created = createProposal(stash, {
      ref: "lessons/missing-target",
      source: "reflect",
      sourceRun: "run-envelope",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");
    const state = openStateDatabase();
    const row = state.prepare("SELECT metadata_json FROM proposals WHERE id = ?").get(created.id) as {
      metadata_json: string;
    };
    const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    delete metadata.proposedTarget;
    state.prepare("UPDATE proposals SET metadata_json = ? WHERE id = ?").run(JSON.stringify(metadata), created.id);
    state.close();

    const reread = getProposal(stash, created.id);
    expect(reread.proposedTarget).toBeUndefined();
  });

  test("a present but malformed proposedTarget is still rejected", () => {
    const stash = makeStashDir();
    const created = createProposal(stash, {
      ref: "lessons/malformed-target",
      source: "reflect",
      sourceRun: "run-envelope",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");
    const state = openStateDatabase();
    const row = state.prepare("SELECT metadata_json FROM proposals WHERE id = ?").get(created.id) as {
      metadata_json: string;
    };
    const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    metadata.proposedTarget = { source: "primary" }; // missing `root`
    state.prepare("UPDATE proposals SET metadata_json = ? WHERE id = ?").run(JSON.stringify(metadata), created.id);
    state.close();

    expect(() => getProposal(stash, created.id)).toThrow(/invalid proposedTarget/i);
  });

  test("a row with a retired ref grammar is rejected", () => {
    const stash = makeStashDir();
    const created = createProposal(stash, {
      ref: "lessons/current-ref",
      source: "reflect",
      sourceRun: "run-envelope",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");
    const state = openStateDatabase();
    const retiredRef = `stash//lesson:${"retired"}`;
    state.prepare("UPDATE proposals SET ref = ? WHERE id = ?").run(retiredRef, created.id);
    state.close();

    expect(() => getProposal(stash, created.id)).toThrow(/invalid current ref/i);
  });
});

// ── #956 fix (fix-index item 1) — a rebuild-in-progress skip is fail-open ──

describe("akmProposalAccept succeeds while a live index rebuild holds the lock (#956 fix)", () => {
  test("finalizes normally instead of throwing 'index finalization failed'", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    const created = createProposal(stash, {
      ref: "lessons/accept-during-rebuild",
      source: "distill",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");

    // A live pid holds the index rebuild lock — indexWrittenAssets must skip
    // its inline upsert (the in-progress rebuild will pick up the change on
    // its own) and report the skip as success, not failure, so the caller
    // that gates on that boolean never sees "index finalization failed"
    // while an unrelated `akm index` run is in progress.
    const lockPath = getIndexRebuildLockPath();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");

    const accepted = await akmProposalAccept({ stashDir: stash, id: created.id, config });

    fs.rmSync(lockPath, { force: true });
    expect(accepted.proposal.status).toBe("accepted");
    expect(getProposal(stash, created.id).status).toBe("accepted");
  });
});
