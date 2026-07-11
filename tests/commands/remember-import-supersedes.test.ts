/**
 * SPEC-5 (stash-conventions-code-spec.md): `--supersedes <ref>` on
 * `akm remember` and `akm import` — atomic correction + demotion of the
 * superseded asset.
 *
 * Pins the two-write corrections pattern the conventions mandate:
 *   - `--supersedes <ref>` writes the NEW correction asset with the old ref
 *     folded into its frontmatter `xrefs:` list (correction provenance), AND
 *     mutates the OLD asset's frontmatter to `beliefState: superseded` +
 *     `supersededBy: [<new ref>]` — a metadata edit only: every other
 *     frontmatter key and the body are preserved byte-for-byte.
 *   - The demotion is immediately live: the mutated old asset is reindexed,
 *     so `--belief current` hides it and the beliefStateBoost (-0.25) ranks
 *     the correction above the stale incumbent.
 *   - Re-running the correction is idempotent (no duplicated supersededBy
 *     entry); `writeSupersededEdge` sorted-set-appends across corrections.
 *   - An unresolvable ref is INPUT VALIDATION: UsageError → exit 2 with the
 *     standard `{ok:false,error,code}` envelope, and NOTHING is written or
 *     demoted (no partial correction).
 *   - An old asset that resolves only in a READ-ONLY source is not mutated:
 *     the new asset is still written, stderr warns, and the JSON output
 *     reports `superseded: [{ref, applied: false, reason}]`.
 *   - Git write targets batch BOTH files (new correction + demoted old) into
 *     the single boundary commit — pinned in
 *     tests/integration/supersedes-git-target.test.ts (real git fixture).
 *   - The flag is declared in each command's help meta (citty args def →
 *     rendered usage).
 *   - New helper `writeSupersededEdge(filePath, supersededByRef)` lives as a
 *     sibling of `writeContradictEdge` in
 *     src/commands/improve/memory/memory-belief.ts (loaded via dynamic import
 *     below so its absence fails only the unit tests, not the module graph).
 *
 * Uses the in-process CLI harness (tests/_helpers/cli.ts) with the sandboxed
 * stash/config helpers, following tests/commands/remember-import-xref.test.ts
 * (the SPEC-3 surface this extends).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { renderUsage } from "citty";
import { rememberCommand } from "../../src/commands/read/remember-cli";
import { importKnowledgeCommand } from "../../src/commands/sources/stash-cli";
import { parseFrontmatter } from "../../src/core/asset/frontmatter";
import { runCliCapture } from "../_helpers/cli";
import {
  type Cleanup,
  makeSandboxDir,
  type SandboxedDir,
  sandboxStashDir,
  writeSandboxConfig,
} from "../_helpers/sandbox";

const disposers: SandboxedDir[] = [];
let stashCleanup: Cleanup = () => {};
let stashDir = "";

beforeEach(() => {
  const stash = sandboxStashDir();
  stashDir = stash.dir;
  stashCleanup = stash.cleanup;
  writeSandboxConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  stashCleanup();
  stashCleanup = () => {};
  stashDir = "";
  for (const d of disposers.splice(0)) d.cleanup();
});

/** Create an isolated dir (auto-cleaned) for import sources / extra stashes. */
function makeDir(prefix: string): string {
  const d = makeSandboxDir(prefix);
  disposers.push(d);
  return d.dir;
}

/** Seed an asset file under a stash root (e.g. "memories/old-note.md"). */
function seedAsset(root: string, relPath: string, content: string): string {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return abs;
}

/** Write an import-source markdown file into a fresh sandbox dir. */
function makeSourceFile(name: string, body: string): string {
  const dir = makeDir("akm-supersedes-import-src");
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, body, "utf8");
  return filePath;
}

function listDirRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).map(String);
}

interface SupersededReport {
  ref: string;
  applied: boolean;
  reason?: string;
}

interface WriteOutput {
  ok: boolean;
  ref: string;
  path: string;
  superseded?: SupersededReport[];
}

/** Seed a memory through the real CLI so it carries the generated hot-path frontmatter. */
async function rememberSeed(content: string, name: string, subPath?: string): Promise<WriteOutput> {
  const args = ["remember", content, "--name", name];
  if (subPath) args.push("--path", subPath);
  const { code, stdout } = await runCliCapture(args);
  expect(code).toBe(0);
  return JSON.parse(stdout) as WriteOutput;
}

// ── remember --supersedes ────────────────────────────────────────────────────

describe("remember --supersedes", () => {
  test("writes the correction with an xref to the old ref AND demotes the old asset (metadata-only edit)", async () => {
    const old = await rememberSeed(
      "The staging deploy requires the legacy quantum-rotation VPN endpoint.",
      "old-endpoint",
      "projectA",
    );
    expect(old.ref).toBe("memory:projectA/old-endpoint");
    const oldRawBefore = fs.readFileSync(old.path, "utf8");
    const oldParsedBefore = parseFrontmatter(oldRawBefore);
    // The hot-path seed carries beliefState: asserted — the demotion must
    // overwrite it, not merely fill an absent key.
    expect(oldParsedBefore.data.beliefState).toBe("asserted");

    const { code, stdout } = await runCliCapture([
      "remember",
      "The staging deploy now uses the new quantum-rotation gateway endpoint.",
      "--name",
      "new-endpoint",
      "--path",
      "projectA",
      "--supersedes",
      "memory:projectA/old-endpoint",
    ]);
    expect(code).toBe(0);

    const json = JSON.parse(stdout) as WriteOutput;
    expect(json.ok).toBe(true);
    expect(json.ref).toBe("memory:projectA/new-endpoint");

    // Additive output key: the demotion is reported as applied.
    expect(Array.isArray(json.superseded)).toBe(true);
    expect(json.superseded).toHaveLength(1);
    expect(json.superseded?.[0]?.ref).toBe("memory:projectA/old-endpoint");
    expect(json.superseded?.[0]?.applied).toBe(true);

    // Correction provenance: the superseded ref folds into the NEW asset's
    // xrefs automatically (no --xref flag was passed).
    const newParsed = parseFrontmatter(fs.readFileSync(json.path, "utf8"));
    expect(newParsed.data.xrefs).toContain("memory:projectA/old-endpoint");

    // The OLD asset gains exactly the two demotion keys...
    const oldParsedAfter = parseFrontmatter(fs.readFileSync(old.path, "utf8"));
    expect(oldParsedAfter.data.beliefState).toBe("superseded");
    expect(oldParsedAfter.data.supersededBy).toEqual(["memory:projectA/new-endpoint"]);
    // ...while every other frontmatter key survives (metadata edit, not a rewrite)...
    expect(oldParsedAfter.data.captureMode).toBe("hot");
    // ...and the body is untouched.
    expect(oldParsedAfter.content).toBe(oldParsedBefore.content);
  });

  test("demotion is live: --belief current hides the old asset and the correction outranks it", async () => {
    // The shared token lives in the asset NAMES (body prose is not
    // FTS-indexed), so both memories are findable by the same query.
    await rememberSeed("Deploy to staging through the legacy endpoint.", "quantum-rotation-old-endpoint");

    const { code, stdout } = await runCliCapture([
      "remember",
      "Deploy to staging through the new gateway.",
      "--name",
      "quantum-rotation-new-endpoint",
      "--supersedes",
      "memory:quantum-rotation-old-endpoint",
    ]);
    expect(code).toBe(0);
    const newRef = (JSON.parse(stdout) as WriteOutput).ref;
    expect(newRef).toBe("memory:quantum-rotation-new-endpoint");

    // The demoted incumbent must drop out of `--belief current` immediately —
    // this only holds if the mutated old file was reindexed by the writer.
    const current = await runCliCapture(["search", "quantum rotation", "--type", "memory", "--belief", "current"]);
    expect(current.code).toBe(0);
    const currentRefs = ((JSON.parse(current.stdout).hits ?? []) as Array<{ ref: string }>).map((h) => h.ref);
    expect(currentRefs).toContain(newRef);
    expect(currentRefs).not.toContain("memory:quantum-rotation-old-endpoint");

    // Unfiltered search still returns both, with the correction ranked above
    // the superseded incumbent (beliefStateBoost demotion, -0.25).
    const all = await runCliCapture(["search", "quantum rotation", "--type", "memory"]);
    expect(all.code).toBe(0);
    const allRefs = ((JSON.parse(all.stdout).hits ?? []) as Array<{ ref: string }>).map((h) => h.ref);
    expect(allRefs).toContain(newRef);
    expect(allRefs).toContain("memory:quantum-rotation-old-endpoint");
    expect(allRefs.indexOf(newRef)).toBeLessThan(allRefs.indexOf("memory:quantum-rotation-old-endpoint"));
  });

  test("re-running the correction is idempotent: supersededBy is not duplicated", async () => {
    const old = await rememberSeed("Old rotation cadence: every 90 days.", "rotation-cadence-old");

    const first = await runCliCapture([
      "remember",
      "New rotation cadence: every 30 days.",
      "--name",
      "rotation-cadence-new",
      "--supersedes",
      "memory:rotation-cadence-old",
    ]);
    expect(first.code).toBe(0);

    const second = await runCliCapture([
      "remember",
      "New rotation cadence: every 30 days.",
      "--name",
      "rotation-cadence-new",
      "--force",
      "--supersedes",
      "memory:rotation-cadence-old",
    ]);
    expect(second.code).toBe(0);

    const oldParsed = parseFrontmatter(fs.readFileSync(old.path, "utf8"));
    expect(oldParsed.data.beliefState).toBe("superseded");
    expect(oldParsed.data.supersededBy).toEqual(["memory:rotation-cadence-new"]);
  });

  test("unresolvable --supersedes fails with exit 2 usage envelope; nothing written, nothing demoted", async () => {
    const goodOldPath = seedAsset(stashDir, "memories/good-old.md", "A resolvable incumbent memory.\n");
    const goodOldRaw = fs.readFileSync(goodOldPath, "utf8");

    const { code, stderr } = await runCliCapture([
      "remember",
      "This correction must not be written",
      "--supersedes",
      "memory:good-old",
      "--supersedes",
      "memory:ghost-note",
    ]);
    expect(code).toBe(2);

    const json = JSON.parse(stderr) as { ok: boolean; error: string; code?: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain("memory:ghost-note");
    expect(typeof json.code).toBe("string");

    // Validation happens BEFORE any write: no new asset landed AND the
    // resolvable target was not partially demoted.
    expect(listDirRecursive(path.join(stashDir, "memories"))).toEqual(["good-old.md"]);
    expect(fs.readFileSync(goodOldPath, "utf8")).toBe(goodOldRaw);
  });

  test("--supersedes composes with --xref (deduped) and adds a frontmatter block to a frontmatter-less old asset", async () => {
    seedAsset(stashDir, "knowledge/auth-flow.md", "# Auth flow\n\nReference doc.\n");
    const oldPath = seedAsset(stashDir, "memories/vpn-note.md", "VPN is required for staging.\n");

    const { code, stdout } = await runCliCapture([
      "remember",
      "Staging no longer needs the VPN after the gateway migration.",
      "--name",
      "vpn-note-correction",
      "--xref",
      "knowledge:auth-flow",
      "--supersedes",
      "memory:vpn-note",
    ]);
    expect(code).toBe(0);

    const json = JSON.parse(stdout) as WriteOutput;
    const newParsed = parseFrontmatter(fs.readFileSync(json.path, "utf8"));
    const xrefs = (newParsed.data.xrefs ?? []) as string[];
    expect(xrefs).toContain("knowledge:auth-flow");
    expect(xrefs).toContain("memory:vpn-note");
    // No duplicates when a ref arrives through both channels or repeats.
    expect(xrefs.filter((r) => r === "memory:vpn-note")).toHaveLength(1);

    // A frontmatter-less old asset gains a metadata block; the body text is
    // preserved (assembleAsset only strips leading blank lines).
    const oldRaw = fs.readFileSync(oldPath, "utf8");
    expect(oldRaw.startsWith("---")).toBe(true);
    const oldParsed = parseFrontmatter(oldRaw);
    expect(oldParsed.data.beliefState).toBe("superseded");
    expect(oldParsed.data.supersededBy).toEqual([json.ref]);
    expect(oldParsed.content.replace(/^\n+/, "")).toBe("VPN is required for staging.\n");
  });

  test("self-supersede (--force overwrite of the same name) is rejected with exit 2; the original asset is untouched", async () => {
    const orig = await rememberSeed("The flux capacitor needs the legacy calibration.", "flux-note");
    expect(orig.ref).toBe("memory:flux-note");
    const origRaw = fs.readFileSync(orig.path, "utf8");

    const { code, stderr } = await runCliCapture([
      "remember",
      "The flux capacitor calibration was corrected.",
      "--name",
      "flux-note",
      "--force",
      "--supersedes",
      "memory:flux-note",
    ]);
    expect(code).toBe(2);

    const json = JSON.parse(stderr) as { ok: boolean; error: string; code?: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain("memory:flux-note");
    expect(json.error).toContain("cannot supersede itself");
    expect(json.code).toBe("INVALID_FLAG_VALUE");

    // Rejected BEFORE any write: the incumbent keeps its original bytes — no
    // overwrite, no self-demotion, no self-xref.
    expect(fs.readFileSync(orig.path, "utf8")).toBe(origRaw);
    expect(listDirRecursive(path.join(stashDir, "memories"))).toEqual(["flux-note.md"]);
  });

  test("old asset with malformed frontmatter: demotion skipped (applied:false), file byte-identical, correction still written", async () => {
    const oldPath = seedAsset(
      stashDir,
      "knowledge/broken-fm.md",
      [
        "---",
        'description: "unterminated quote',
        "tags:",
        "  - auth",
        "  - vpn",
        "---",
        "",
        "Broken frontmatter, precious values.",
        "",
      ].join("\n"),
    );
    const oldRaw = fs.readFileSync(oldPath, "utf8");

    const { code, stdout, stderr } = await runCliCapture([
      "remember",
      "The corrected guidance replacing the broken doc.",
      "--name",
      "fixed-guidance",
      "--supersedes",
      "knowledge:broken-fm",
    ]);
    expect(code).toBe(0);

    const json = JSON.parse(stdout) as WriteOutput;
    expect(json.ok).toBe(true);
    expect(json.superseded).toHaveLength(1);
    expect(json.superseded?.[0]?.ref).toBe("knowledge:broken-fm");
    expect(json.superseded?.[0]?.applied).toBe(false);
    expect(json.superseded?.[0]?.reason ?? "").toContain("YAML");
    expect(stderr).toContain("knowledge:broken-fm");

    // No lossy rewrite: the lenient-parser fallback would have flattened the
    // tags list to "" — the file must stay byte-identical instead.
    expect(fs.readFileSync(oldPath, "utf8")).toBe(oldRaw);
    // The correction still writes and cites the incumbent.
    const newParsed = parseFrontmatter(fs.readFileSync(json.path, "utf8"));
    expect(newParsed.data.xrefs).toContain("knowledge:broken-fm");
  });

  test("old asset in a WRITABLE non-target source: demotion skipped with a --target remedy (not misreported as read-only)", async () => {
    const teamDir = makeDir("akm-supersedes-writable-team");
    const oldPath = seedAsset(teamDir, "memories/team-note.md", "Team note from the shared writable stash.\n");
    const oldRaw = fs.readFileSync(oldPath, "utf8");
    writeSandboxConfig({
      semanticSearchMode: "off",
      sources: [{ type: "filesystem", name: "team", path: teamDir, writable: true }],
    });

    const { code, stdout } = await runCliCapture([
      "remember",
      "Corrected team note recorded in my own stash.",
      "--name",
      "team-note-fix",
      "--supersedes",
      "memory:team-note",
    ]);
    expect(code).toBe(0);

    const json = JSON.parse(stdout) as WriteOutput;
    // Written to the PRIMARY stash; the incumbent lives in the writable
    // non-target source and is NOT demoted (that would dirty a source outside
    // its own boundary commit).
    expect(json.path.startsWith(stashDir)).toBe(true);
    expect(json.superseded).toHaveLength(1);
    expect(json.superseded?.[0]?.applied).toBe(false);
    const reason = json.superseded?.[0]?.reason ?? "";
    // Eligibility is write-target-or-working-stash, not source writability:
    // the reason must not misdiagnose the source as read-only, and must name
    // the actual remedy.
    expect(reason).not.toContain("read-only");
    expect(reason).toContain("--target team");
    expect(fs.readFileSync(oldPath, "utf8")).toBe(oldRaw);
  });

  test("old asset in a read-only source: correction still written, demotion reported applied:false, file untouched", async () => {
    const extraDir = makeDir("akm-supersedes-readonly");
    const oldPath = seedAsset(extraDir, "memories/stale-tip.md", "Stale tip from the shared stash.\n");
    const oldRaw = fs.readFileSync(oldPath, "utf8");
    writeSandboxConfig({
      semanticSearchMode: "off",
      sources: [{ type: "filesystem", name: "readonly-extra", path: extraDir, writable: false }],
    });

    const { code, stdout, stderr } = await runCliCapture([
      "remember",
      "Fresh tip replacing the shared stale one.",
      "--name",
      "fresh-tip",
      "--supersedes",
      "memory:stale-tip",
    ]);
    expect(code).toBe(0);

    const json = JSON.parse(stdout) as WriteOutput;
    expect(json.ok).toBe(true);
    // Written to the PRIMARY stash while citing the read-only incumbent.
    expect(json.path.startsWith(stashDir)).toBe(true);
    const newParsed = parseFrontmatter(fs.readFileSync(json.path, "utf8"));
    expect(newParsed.data.xrefs).toContain("memory:stale-tip");

    // The demotion could not be applied: reported, warned, and the read-only
    // file stays byte-identical.
    expect(json.superseded).toHaveLength(1);
    expect(json.superseded?.[0]?.ref).toBe("memory:stale-tip");
    expect(json.superseded?.[0]?.applied).toBe(false);
    expect((json.superseded?.[0]?.reason ?? "").length).toBeGreaterThan(0);
    expect(stderr).toContain("memory:stale-tip");
    expect(fs.readFileSync(oldPath, "utf8")).toBe(oldRaw);
  });
});

// ── import --supersedes ──────────────────────────────────────────────────────

describe("import --supersedes", () => {
  test("imported correction xrefs the old doc and demotes it, preserving its other frontmatter and body", async () => {
    const oldPath = seedAsset(
      stashDir,
      "knowledge/legacy-guide.md",
      [
        "---",
        "description: Legacy auth guide",
        "tags:",
        "  - auth",
        "---",
        "",
        "# Legacy guide",
        "",
        "Old advice.",
        "",
      ].join("\n"),
    );
    const oldParsedBefore = parseFrontmatter(fs.readFileSync(oldPath, "utf8"));
    const sourcePath = makeSourceFile("modern-guide.md", "# Modern guide\n\nNew advice replacing the legacy doc.\n");

    const { code, stdout } = await runCliCapture([
      "import",
      sourcePath,
      "--name",
      "modern-guide",
      "--supersedes",
      "knowledge:legacy-guide",
    ]);
    expect(code).toBe(0);

    const json = JSON.parse(stdout) as WriteOutput;
    expect(json.ok).toBe(true);
    expect(json.ref).toBe("knowledge:modern-guide");
    expect(json.superseded).toHaveLength(1);
    expect(json.superseded?.[0]?.ref).toBe("knowledge:legacy-guide");
    expect(json.superseded?.[0]?.applied).toBe(true);

    // The imported doc carries the correction provenance in ONE frontmatter block.
    const newRaw = fs.readFileSync(json.path, "utf8");
    const newParsed = parseFrontmatter(newRaw);
    expect(newParsed.data.xrefs).toContain("knowledge:legacy-guide");
    expect(newParsed.content).toContain("# Modern guide");
    expect(newRaw.match(/^---\s*$/gm)?.length).toBe(2);

    // The old doc: demoted, other keys preserved, body untouched.
    const oldParsedAfter = parseFrontmatter(fs.readFileSync(oldPath, "utf8"));
    expect(oldParsedAfter.data.beliefState).toBe("superseded");
    expect(oldParsedAfter.data.supersededBy).toEqual(["knowledge:modern-guide"]);
    expect(oldParsedAfter.data.description).toBe("Legacy auth guide");
    expect(oldParsedAfter.data.tags).toEqual(["auth"]);
    expect(oldParsedAfter.content).toBe(oldParsedBefore.content);
  });

  test("unresolvable --supersedes fails with exit 2 usage envelope and imports nothing", async () => {
    const sourcePath = makeSourceFile("doomed-correction.md", "# Doomed\n\nMust not land in the stash.\n");

    const { code, stderr } = await runCliCapture(["import", sourcePath, "--supersedes", "knowledge:ghost-doc"]);
    expect(code).toBe(2);

    const json = JSON.parse(stderr) as { ok: boolean; error: string; code?: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain("knowledge:ghost-doc");
    expect(typeof json.code).toBe("string");

    expect(listDirRecursive(path.join(stashDir, "knowledge"))).toEqual([]);
  });
});

// The git-write-target case (single boundary commit batching the correction
// AND the demoted old asset) needs real git fixtures, so it lives in
// tests/integration/supersedes-git-target.test.ts per the isolation lint.

// ── writeSupersededEdge (unit) ───────────────────────────────────────────────

describe("writeSupersededEdge — sibling of writeContradictEdge in memory-belief", () => {
  /**
   * Dynamic import so a missing export fails THESE tests with a clear
   * assertion instead of breaking the whole file's module graph.
   */
  async function loadWriteSupersededEdge(): Promise<(filePath: string, supersededByRef: string) => void> {
    const mod = (await import("../../src/commands/improve/memory/memory-belief")) as Record<string, unknown>;
    expect(typeof mod.writeSupersededEdge).toBe("function");
    return mod.writeSupersededEdge as (filePath: string, supersededByRef: string) => void;
  }

  test("sets beliefState: superseded + supersededBy while preserving other keys and the body", async () => {
    const writeSupersededEdge = await loadWriteSupersededEdge();
    const dir = makeDir("akm-superseded-edge");
    const filePath = path.join(dir, "old.md");
    fs.writeFileSync(
      filePath,
      [
        "---",
        "description: An incumbent memory",
        "tags:",
        "  - ops",
        "beliefState: asserted",
        "---",
        "",
        "Incumbent body.",
        "",
      ].join("\n"),
      "utf8",
    );

    writeSupersededEdge(filePath, "memory:corrections/new-note");

    const parsed = parseFrontmatter(fs.readFileSync(filePath, "utf8"));
    expect(parsed.data.beliefState).toBe("superseded");
    expect(parsed.data.supersededBy).toEqual(["memory:corrections/new-note"]);
    expect(parsed.data.description).toBe("An incumbent memory");
    expect(parsed.data.tags).toEqual(["ops"]);
    expect(parsed.content.replace(/^\n+/, "")).toBe("Incumbent body.\n");
  });

  test("idempotent: a repeat call with the same ref leaves the file byte-identical", async () => {
    const writeSupersededEdge = await loadWriteSupersededEdge();
    const dir = makeDir("akm-superseded-edge");
    const filePath = path.join(dir, "old.md");
    fs.writeFileSync(filePath, "Plain incumbent body.\n", "utf8");

    writeSupersededEdge(filePath, "memory:new-note");
    const afterFirst = fs.readFileSync(filePath, "utf8");
    writeSupersededEdge(filePath, "memory:new-note");
    expect(fs.readFileSync(filePath, "utf8")).toBe(afterFirst);
  });

  test("sorted-set-appends refs across multiple corrections", async () => {
    const writeSupersededEdge = await loadWriteSupersededEdge();
    const dir = makeDir("akm-superseded-edge");
    const filePath = path.join(dir, "old.md");
    fs.writeFileSync(filePath, "Twice-corrected body.\n", "utf8");

    writeSupersededEdge(filePath, "memory:zeta-fix");
    writeSupersededEdge(filePath, "memory:alpha-fix");

    const parsed = parseFrontmatter(fs.readFileSync(filePath, "utf8"));
    expect(parsed.data.beliefState).toBe("superseded");
    expect(parsed.data.supersededBy).toEqual(["memory:alpha-fix", "memory:zeta-fix"]);
  });
});

// ── help meta ────────────────────────────────────────────────────────────────

describe("--supersedes in command help meta", () => {
  /** Resolve a citty args def that may be a value, promise, or thunk. */
  async function resolveArgs(command: unknown): Promise<Record<string, { type?: string; description?: string }>> {
    const raw = (command as { args?: unknown }).args;
    const resolved = typeof raw === "function" ? await raw() : await raw;
    return (resolved ?? {}) as Record<string, { type?: string; description?: string }>;
  }

  test("remember declares --supersedes with a description and renders it in usage", async () => {
    const args = await resolveArgs(rememberCommand);
    expect(Object.keys(args)).toContain("supersedes");
    expect((args.supersedes?.description ?? "").length).toBeGreaterThan(0);

    const usage = await renderUsage(rememberCommand as Parameters<typeof renderUsage>[0]);
    expect(usage).toContain("--supersedes");
  });

  test("import declares --supersedes with a description and renders it in usage", async () => {
    const args = await resolveArgs(importKnowledgeCommand);
    expect(Object.keys(args)).toContain("supersedes");
    expect((args.supersedes?.description ?? "").length).toBeGreaterThan(0);

    const usage = await renderUsage(importKnowledgeCommand as Parameters<typeof renderUsage>[0]);
    expect(usage).toContain("--supersedes");
  });
});
