/**
 * SPEC-3 (stash-conventions-code-spec.md): `--xref <ref>` on `akm remember`
 * and `akm import`.
 *
 * Pins the write-time cross-reference surface the conventions mandate:
 *   - `--xref <ref>` is repeatable and lands in the written asset's
 *     frontmatter `xrefs:` list (folded into FTS hints by the indexer).
 *   - An unresolvable ref is INPUT VALIDATION: UsageError → exit 2 with the
 *     standard `{ok:false,error,code}` envelope, and NOTHING is written.
 *   - Refs resolvable only in a configured extra stash root (cross-stash)
 *     are accepted — resolution mirrors lint's [writeTarget, ...sources].
 *   - `akm import` merges xrefs into a document's EXISTING frontmatter
 *     (dedupe-append) instead of nesting a second frontmatter block.
 *   - More than 5 xrefs stays a SOFT cap: stderr warn, write still happens.
 *   - Written xrefs fold into FTS hints: the new asset is findable by
 *     searching its cited ref's slug (the conventions' provenance channel,
 *     verified end-to-end through the write-path indexer).
 *   - Merging into MALFORMED frontmatter fails loudly (exit 2, nothing
 *     written) instead of silently flattening list/nested values through the
 *     lenient parser fallback; the AKM write boundary rejects the same malformed
 *     document without `--xref` because it cannot safely add required `type` metadata.
 *   - Type-root writes into a stash with convention facts emit the additive
 *     `hint` output key (spec test-plan item 6); nested/--path writes and
 *     convention-less stashes do not, and the canonical
 *     `facts/conventions/organization` pointer only appears when that fact
 *     actually exists.
 *   - The flag is declared in each command's help meta (citty args def →
 *     rendered usage).
 *
 * Uses the in-process CLI harness (tests/_helpers/cli.ts) with the sandboxed
 * stash/config helpers, following tests/commands/remember.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { renderUsage } from "citty";
import { mergeXrefsIntoContent } from "../../src/commands/read/knowledge";
import { rememberCommand } from "../../src/commands/read/remember-cli";
import { importKnowledgeCommand } from "../../src/commands/sources/stash-cli";
import { parseBundleRef } from "../../src/core/asset/asset-ref";
import { parseFrontmatter } from "../../src/core/asset/frontmatter";
import { UsageError } from "../../src/core/errors";
import { runCliCapture } from "../_helpers/cli";
import { durableItemRef } from "../_helpers/durable-ref";
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

/** Seed a resolvable asset file under a stash root (e.g. "knowledge/auth-flow.md"). */
function seedAsset(root: string, relPath: string, content = "# Seed\n\nSeed content.\n"): void {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

/** Write an import-source markdown file into a fresh sandbox dir. */
function makeSourceFile(name: string, body: string): string {
  const dir = makeDir("akm-xref-import-src");
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, body, "utf8");
  return filePath;
}

function listDirRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).map(String);
}

function stashRef(type: string, name: string): string {
  return durableItemRef(stashDir, type, name);
}

function conceptId(ref: string): string {
  return parseBundleRef(ref).conceptId;
}

// ── remember --xref ──────────────────────────────────────────────────────────

describe("remember --xref", () => {
  test("single resolvable --xref lands in the written frontmatter xrefs list", async () => {
    seedAsset(stashDir, "knowledge/auth-flow.md");
    const authFlowRef = stashRef("knowledge", "auth-flow");

    // No --tag: --xref counts as structured metadata but must NOT trigger the
    // tags-required check (spec: provenance without tags is a valid write).
    const { code, stdout } = await runCliCapture([
      "remember",
      "Derived note about the auth flow",
      "--xref",
      authFlowRef,
    ]);
    expect(code).toBe(0);

    const json = JSON.parse(stdout) as { ok: boolean; ref: string; path: string };
    expect(json.ok).toBe(true);

    const parsed = parseFrontmatter(fs.readFileSync(json.path, "utf8"));
    expect(parsed.data.xrefs).toEqual([authFlowRef]);
    // The hot-path markers still ride along in the SAME frontmatter block —
    // xrefs merge into the generated frontmatter, they don't replace it.
    expect(parsed.data.captureMode).toBe("hot");
    expect(parsed.data.beliefState).toBe("asserted");
    expect(parsed.content).toContain("Derived note about the auth flow");
  });

  test("--xref is repeatable and preserves argv order", async () => {
    seedAsset(stashDir, "knowledge/auth-flow.md");
    seedAsset(stashDir, "memories/vpn-note.md", "VPN is required for staging.\n");
    const authFlowRef = stashRef("knowledge", "auth-flow");
    const vpnNoteRef = stashRef("memory", "vpn-note");

    const { code, stdout } = await runCliCapture([
      "remember",
      "Synthesis of auth flow and VPN notes",
      "--xref",
      authFlowRef,
      "--xref",
      vpnNoteRef,
    ]);
    expect(code).toBe(0);

    const json = JSON.parse(stdout) as { path: string };
    const parsed = parseFrontmatter(fs.readFileSync(json.path, "utf8"));
    expect(parsed.data.xrefs).toEqual([authFlowRef, vpnNoteRef]);
  });

  test("--xref composes with --tag in one frontmatter block", async () => {
    seedAsset(stashDir, "knowledge/auth-flow.md");
    const authFlowRef = stashRef("knowledge", "auth-flow");

    const { code, stdout } = await runCliCapture([
      "remember",
      "Tagged derived note",
      "--tag",
      "ops",
      "--xref",
      authFlowRef,
    ]);
    expect(code).toBe(0);

    const json = JSON.parse(stdout) as { path: string };
    const raw = fs.readFileSync(json.path, "utf8");
    const parsed = parseFrontmatter(raw);
    expect(parsed.data.tags).toEqual(["ops"]);
    expect(parsed.data.xrefs).toEqual([authFlowRef]);
    // Exactly one frontmatter block: opening + closing fence only.
    expect(raw.match(/^---\s*$/gm)?.length).toBe(2);
  });

  test("unresolvable --xref fails with exit 2 usage envelope and writes nothing", async () => {
    const missingRef = stashRef("knowledge", "does-not-exist");
    const { code, stderr } = await runCliCapture(["remember", "This must not be written", "--xref", missingRef]);
    expect(code).toBe(2);

    const json = JSON.parse(stderr) as { ok: boolean; error: string; code?: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain(missingRef);
    expect(typeof json.code).toBe("string");

    // Validation happens BEFORE any write: the stash stays empty.
    expect(listDirRecursive(path.join(stashDir, "memories"))).toEqual([]);
  });

  test("one bad ref among resolvable ones still fails and writes nothing", async () => {
    seedAsset(stashDir, "knowledge/auth-flow.md");
    const authFlowRef = stashRef("knowledge", "auth-flow");
    const missingRef = stashRef("memory", "ghost-note");

    const { code, stderr } = await runCliCapture([
      "remember",
      "Mixed refs must not be written",
      "--tag",
      "ops",
      "--xref",
      authFlowRef,
      "--xref",
      missingRef,
    ]);
    expect(code).toBe(2);

    const json = JSON.parse(stderr) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    // The error names the ref(s) that failed to resolve.
    expect(json.error).toContain(missingRef);

    expect(listDirRecursive(path.join(stashDir, "memories"))).toEqual([]);
  });

  test("cross-stash ref resolvable only in a configured extra source is accepted", async () => {
    const extraDir = makeDir("akm-xref-extra-stash");
    seedAsset(extraDir, "knowledge/shared-doc.md");
    writeSandboxConfig({
      semanticSearchMode: "off",
      bundles: { "extra-stash": { path: extraDir, writable: false } },
    });

    const { code, stdout } = await runCliCapture([
      "remember",
      "Derived from the shared cross-stash doc",
      "--xref",
      "extra-stash//knowledge/shared-doc",
    ]);
    expect(code).toBe(0);

    const json = JSON.parse(stdout) as { ok: boolean; path: string };
    expect(json.ok).toBe(true);
    // Written to the PRIMARY stash while citing the extra-stash asset.
    expect(json.path.startsWith(stashDir)).toBe(true);
    const parsed = parseFrontmatter(fs.readFileSync(json.path, "utf8"));
    expect(parsed.data.xrefs).toEqual(["extra-stash//knowledge/shared-doc"]);
  });

  test("more than 5 xrefs warns on stderr but still writes (soft cap)", async () => {
    const refs: string[] = [];
    for (let i = 1; i <= 6; i++) {
      seedAsset(stashDir, `knowledge/doc-${i}.md`);
      refs.push(stashRef("knowledge", `doc-${i}`));
    }
    const args = ["remember", "Heavily cited note"];
    for (const ref of refs) {
      args.push("--xref", ref);
    }

    const { code, stdout, stderr } = await runCliCapture(args);
    expect(code).toBe(0);

    const json = JSON.parse(stdout) as { ok: boolean; path: string };
    expect(json.ok).toBe(true);
    const parsed = parseFrontmatter(fs.readFileSync(json.path, "utf8"));
    expect(parsed.data.xrefs).toEqual(refs);
    // Soft cap: a warning is emitted, not an error.
    expect(stderr.toLowerCase()).toContain("xref");
  });

  test("written xrefs fold into FTS hints: the memory is findable by its cited ref slug", async () => {
    seedAsset(stashDir, "knowledge/oauth-refresh-dance.md");
    const citedRef = stashRef("knowledge", "oauth-refresh-dance");

    const remember = await runCliCapture(["remember", "Token rotation gotcha worth keeping", "--xref", citedRef]);
    expect(remember.code).toBe(0);
    const written = JSON.parse(remember.stdout) as { ref: string };

    // The cited slug appears ONLY in the xref (not in the memory's body, name,
    // or tags), so a search hit proves the indexer folded the frontmatter
    // xrefs into the FTS hints — the conventions' provenance channel.
    const search = await runCliCapture(["search", "oauth-refresh-dance", "--type", "memory"]);
    expect(search.code).toBe(0);
    const hits = (JSON.parse(search.stdout).hits ?? []) as Array<{ ref: string }>;
    expect(hits.map((h) => conceptId(h.ref))).toContain(conceptId(written.ref));
  });
});

// ── root set + resolver parity with lint (findings #6/#7) ───────────────────

describe("--xref root set and resolver parity", () => {
  test("resolves working-stash refs when defaultWriteTarget routes the write to a named source", async () => {
    // The primary working stash (AKM_BUNDLE_DIR) is NOT in config.sources here,
    // and the write goes to the named "team" source — the root set must still
    // include the working stash (--supersedes already did; --xref did not).
    const teamDir = makeDir("akm-xref-team-target");
    seedAsset(stashDir, "memories/local-note.md", "Working-stash note.\n");
    const localNoteRef = stashRef("memory", "local-note");
    writeSandboxConfig({
      semanticSearchMode: "off",
      defaultWriteTarget: "team",
      bundles: { team: { path: teamDir, writable: true } },
    });

    const { code, stdout } = await runCliCapture([
      "remember",
      "Note derived from the working-stash one",
      "--xref",
      localNoteRef,
    ]);
    expect(code).toBe(0);

    const json = JSON.parse(stdout) as { path: string };
    // Written to the named target while citing the working-stash asset.
    expect(json.path.startsWith(teamDir)).toBe(true);
    const parsed = parseFrontmatter(fs.readFileSync(json.path, "utf8"));
    expect(parsed.data.xrefs).toEqual([localNoteRef]);
  });

  test("script refs resolve exact files and reject missing targets", async () => {
    seedAsset(stashDir, "scripts/build/release.sh", "#!/bin/sh\necho release\n");
    const releaseRef = stashRef("script", "build/release.sh");

    const seeded = await runCliCapture(["remember", "Release script tip", "--xref", releaseRef]);
    expect(seeded.code).toBe(0);
    const seededParsed = parseFrontmatter(
      fs.readFileSync((JSON.parse(seeded.stdout) as { path: string }).path, "utf8"),
    );
    expect(seededParsed.data.xrefs).toEqual([releaseRef]);

    const missingRef = stashRef("script", "no-such-script.sh");
    const ghost = await runCliCapture(["remember", "Ghost script tip", "--xref", missingRef]);
    expect(ghost.code).toBe(2);
    expect((JSON.parse(ghost.stderr) as { error: string }).error).toContain(missingRef);
  });

  test("workflow refs resolve against the stash roots, not the cwd", async () => {
    // The cwd here is the repo root, NOT the stash root — the old cwd-relative
    // `workflowSpec.toAssetPath` probe made this exit 2 from any other cwd.
    seedAsset(stashDir, "workflows/deploy.md", "---\ntype: workflow\nsteps:\n  - id: run\n---\n\n## run\n\necho hi\n");
    const deployRef = stashRef("workflow", "deploy");

    const { code, stdout } = await runCliCapture(["remember", "Deploy workflow tip", "--xref", deployRef]);
    expect(code).toBe(0);
    const parsed = parseFrontmatter(fs.readFileSync((JSON.parse(stdout) as { path: string }).path, "utf8"));
    expect(parsed.data.xrefs).toEqual([deployRef]);

    // Workflow refs do NOT blanket fail-open: a ref resolving nowhere still fails.
    const missingRef = stashRef("workflow", "ghost-flow");
    const ghost = await runCliCapture(["remember", "Ghost workflow tip", "--xref", missingRef]);
    expect(ghost.code).toBe(2);
    expect((JSON.parse(ghost.stderr) as { error: string }).error).toContain(missingRef);
  });

  test("origin-prefixed and malformed refs get a structured parse error, not 'did not resolve'", async () => {
    seedAsset(stashDir, "knowledge/auth-flow.md");

    const remote = await runCliCapture(["remember", "x", "--xref", "npm:pkg//knowledge:auth-flow"]);
    expect(remote.code).toBe(2);
    const remoteJson = JSON.parse(remote.stderr) as { error: string; code?: string };
    expect(remoteJson.code).toBe("INVALID_FLAG_VALUE");
    expect(remoteJson.error).toContain("bundle slug");
    expect(remoteJson.error).not.toContain("did not resolve");

    // Chunk 1.5 opened the type token: "notatype" is no longer rejected by
    // parseAssetRef, so this xref reaches `isFailOpenRefType`
    // (base-linter.ts's `refToRelPath` — "unknown type — skip", pre-existing
    // Chunk-8: a `type:name` string is no longer a ref AT ALL — any colon-form
    // spelling gets the same structured parse rejection (the D1.5-6 tool/vault
    // deny-list distinction died with the type-token grammar; foreign types
    // live in adapter frontmatter, never in ref syntax).
    const badType = await runCliCapture(["remember", "x", "--xref", "notatype:foo"]);
    expect(badType.code).toBe(2);
    expect((JSON.parse(badType.stderr) as { code?: string }).code).toBe("INVALID_FLAG_VALUE");

    const deniedType = await runCliCapture(["remember", "x", "--xref", "tool:foo"]);
    expect(deniedType.code).toBe(2);
    expect((JSON.parse(deniedType.stderr) as { code?: string }).code).toBe("INVALID_FLAG_VALUE");

    // A qualified bundle is literal. An absent `local` bundle must not silently
    // retarget to the primary stash.
    const local = await runCliCapture(["remember", "Locally cited note", "--xref", "local//knowledge/auth-flow"]);
    expect(local.code).toBe(2);
    expect((JSON.parse(local.stderr) as { error: string }).error).toContain("did not resolve");
  });

  test("short xrefs resolve to durable refs; spellings of one asset dedupe to one ref", async () => {
    seedAsset(stashDir, "env/prod.env", "API_URL=https://example.test\n");
    const prodRef = stashRef("env", "prod");

    const { code, stdout } = await runCliCapture([
      "remember",
      "Note citing the prod environment",
      "--xref",
      "env/prod",
    ]);
    expect(code).toBe(0);
    const parsed = parseFrontmatter(fs.readFileSync((JSON.parse(stdout) as { path: string }).path, "utf8"));
    expect(parsed.data.xrefs).toEqual([prodRef]);

    // Short and fully-qualified spellings resolve to one durable entry.
    seedAsset(stashDir, "knowledge/auth-flow.md");
    const authFlowRef = stashRef("knowledge", "auth-flow");
    const dupe = await runCliCapture([
      "remember",
      "Note citing one asset twice",
      "--xref",
      authFlowRef,
      "--xref",
      "knowledge/auth-flow",
    ]);
    expect(dupe.code).toBe(0);
    const dupeParsed = parseFrontmatter(fs.readFileSync((JSON.parse(dupe.stdout) as { path: string }).path, "utf8"));
    expect(dupeParsed.data.xrefs).toEqual([authFlowRef]);
  });
});

// ── slug stability under --xref/--supersedes (finding #12) ───────────────────

describe("--xref/--supersedes do not change the inferred slug", () => {
  test("remember: the same content produces the same slug with and without --xref", async () => {
    seedAsset(stashDir, "knowledge/auth-flow.md");
    const authFlowRef = stashRef("knowledge", "auth-flow");
    const content = "the deploy process now uses blue-green rollout";

    const plain = await runCliCapture(["remember", content]);
    expect(plain.code).toBe(0);
    const plainRef = (JSON.parse(plain.stdout) as { ref: string }).ref;
    expect(conceptId(plainRef)).toBe("memories/the-deploy-process-now-uses-blue-green-rollout");

    // The structured path (forced by --xref) must derive the identical slug
    // from the body — not a random memory-<epoch>-<rand> fallback taken from
    // the generated frontmatter fence. --force proves the name collides.
    const structured = await runCliCapture(["remember", content, "--force", "--xref", authFlowRef]);
    expect(structured.code).toBe(0);
    expect(conceptId((JSON.parse(structured.stdout) as { ref: string }).ref)).toBe(conceptId(plainRef));
  });

  // The stdin variant (`akm import -`) needs a REAL subprocess (stdin cannot
  // be injected into the in-process harness), so it lives in
  // tests/integration/import-stdin-xref-slug.test.ts per the isolation lint.
});

// ── import --xref ────────────────────────────────────────────────────────────

describe("import --xref", () => {
  test("--xref adds a frontmatter block to a frontmatter-less document", async () => {
    seedAsset(stashDir, "knowledge/auth-flow.md");
    const authFlowRef = stashRef("knowledge", "auth-flow");
    const sourcePath = makeSourceFile("auth-notes.md", "# Auth notes\n\nOAuth details worth keeping.\n");

    const { code, stdout } = await runCliCapture(["import", sourcePath, "--xref", authFlowRef]);
    expect(code).toBe(0);

    const json = JSON.parse(stdout) as { ok: boolean; ref: string; path: string };
    expect(json.ok).toBe(true);

    const raw = fs.readFileSync(json.path, "utf8");
    expect(raw.startsWith("---")).toBe(true);
    const parsed = parseFrontmatter(raw);
    expect(parsed.data.xrefs).toEqual([authFlowRef]);
    // Body intact and no frontmatter leaked into it.
    expect(parsed.content).toContain("# Auth notes");
    expect(parsed.content).toContain("OAuth details worth keeping.");
    expect(parsed.content).not.toContain("xrefs:");
    expect(raw.match(/^---\s*$/gm)?.length).toBe(2);
  });

  test("--xref merges into existing frontmatter without nesting a second block", async () => {
    seedAsset(stashDir, "knowledge/auth-flow.md");
    const authFlowRef = stashRef("knowledge", "auth-flow");
    const sourcePath = makeSourceFile(
      "existing-fm.md",
      [
        "---",
        "description: Existing description",
        "tags:",
        "  - auth",
        "---",
        "",
        "# Body heading",
        "",
        "Body text stays intact.",
        "",
      ].join("\n"),
    );

    const { code, stdout } = await runCliCapture(["import", sourcePath, "--xref", authFlowRef]);
    expect(code).toBe(0);

    const json = JSON.parse(stdout) as { path: string };
    const raw = fs.readFileSync(json.path, "utf8");
    const parsed = parseFrontmatter(raw);

    // Existing keys preserved, xrefs appended — one merged block.
    expect(parsed.data.description).toBe("Existing description");
    expect(parsed.data.tags).toEqual(["auth"]);
    expect(parsed.data.xrefs).toEqual([authFlowRef]);

    // No nested-frontmatter corruption: the body carries no fence or key
    // leftovers from a second block.
    expect(parsed.content).toContain("# Body heading");
    expect(parsed.content).toContain("Body text stays intact.");
    expect(parsed.content).not.toMatch(/^---\s*$/m);
    expect(parsed.content).not.toContain("description:");
    expect(raw.match(/^---\s*$/gm)?.length).toBe(2);
  });

  test("--xref dedupe-appends into a document that already lists xrefs", async () => {
    seedAsset(stashDir, "knowledge/auth-flow.md");
    seedAsset(stashDir, "memories/vpn-note.md", "VPN is required for staging.\n");
    const authFlowRef = stashRef("knowledge", "auth-flow");
    const vpnNoteRef = stashRef("memory", "vpn-note");
    const sourcePath = makeSourceFile(
      "already-cited.md",
      ["---", "xrefs:", `  - ${authFlowRef}`, "---", "", "Body citing prior work.", ""].join("\n"),
    );

    const { code, stdout } = await runCliCapture(["import", sourcePath, "--xref", authFlowRef, "--xref", vpnNoteRef]);
    expect(code).toBe(0);

    const json = JSON.parse(stdout) as { path: string };
    const parsed = parseFrontmatter(fs.readFileSync(json.path, "utf8"));
    // The duplicate ref appears once; the new ref is appended.
    expect(parsed.data.xrefs).toEqual([authFlowRef, vpnNoteRef]);
  });

  test("unresolvable --xref fails with exit 2 usage envelope and writes nothing", async () => {
    const sourcePath = makeSourceFile("doomed.md", "# Doomed\n\nMust not land in the stash.\n");
    const missingRef = stashRef("knowledge", "ghost-doc");

    const { code, stderr } = await runCliCapture(["import", sourcePath, "--xref", missingRef]);
    expect(code).toBe(2);

    const json = JSON.parse(stderr) as { ok: boolean; error: string; code?: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain(missingRef);
    expect(typeof json.code).toBe("string");

    expect(listDirRecursive(path.join(stashDir, "knowledge"))).toEqual([]);
  });

  test("--xref onto malformed frontmatter fails loudly instead of silently flattening values", async () => {
    seedAsset(stashDir, "knowledge/auth-flow.md");
    const authFlowRef = stashRef("knowledge", "auth-flow");
    const malformed = [
      "---",
      'description: "unterminated quote',
      "tags:",
      "  - auth",
      "  - oauth",
      "---",
      "",
      "Body that must not land in the stash when --xref is passed.",
      "",
    ].join("\n");
    const sourcePath = makeSourceFile("broken-fm.md", malformed);

    // With --xref: merging would round-trip the block through the lenient
    // scalar-only fallback and rewrite `tags: [auth, oauth]` as `tags: ""` —
    // fail (exit 2) BEFORE any write instead of corrupting the copy.
    const { code, stderr } = await runCliCapture(["import", sourcePath, "--xref", authFlowRef]);
    expect(code).toBe(2);
    const json = JSON.parse(stderr) as { ok: boolean; error: string; code?: string };
    expect(json.ok).toBe(false);
    expect(json.error.toLowerCase()).toContain("frontmatter");
    expect(typeof json.code).toBe("string");
    expect(listDirRecursive(path.join(stashDir, "knowledge"))).toEqual(["auth-flow.md"]);

    // Without --xref the AKM write boundary still rejects malformed frontmatter
    // because it cannot safely add the required matching type metadata.
    const plain = await runCliCapture(["import", sourcePath]);
    expect(plain.code).toBe(2);
    const plainJson = JSON.parse(plain.stderr) as { ok: boolean; error: string; code?: string };
    expect(plainJson.ok).toBe(false);
    expect(plainJson.error).toContain("malformed YAML frontmatter");
    expect(plainJson.code).toBe("INVALID_FLAG_VALUE");
    expect(listDirRecursive(path.join(stashDir, "knowledge"))).toEqual(["auth-flow.md"]);
  });
});

// ── mergeXrefsIntoContent safety (unit) ──────────────────────────────────────

describe("mergeXrefsIntoContent refuses non-mergeable frontmatter", () => {
  test("malformed YAML (lenient-fallback territory) throws UsageError", () => {
    const doc = ["---", 'description: "unterminated', "tags:", "  - auth", "---", "", "Body.", ""].join("\n");
    expect(() => mergeXrefsIntoContent(doc, ["stash//knowledge/auth-flow"])).toThrow(UsageError);
  });

  test("a non-mapping frontmatter block (comments only) throws instead of being dropped", () => {
    const doc = ["---", "# a comment-only block parses to null", "---", "", "Body.", ""].join("\n");
    expect(() => mergeXrefsIntoContent(doc, ["stash//knowledge/auth-flow"])).toThrow(UsageError);
  });

  test("empty xrefs list returns the content untouched, malformed or not", () => {
    const doc = ["---", 'description: "unterminated', "---", "", "Body.", ""].join("\n");
    expect(mergeXrefsIntoContent(doc, [])).toBe(doc);
  });
});

// ── type-root placement hint ─────────────────────────────────────────────────

describe("type-root placement hint", () => {
  /** Seed a convention fact (category: convention frontmatter) under facts/. */
  function seedConventionFact(relPath: string, body: string): void {
    seedAsset(stashDir, `facts/${relPath}`, `---\ncategory: convention\n---\n\n${body}\n`);
  }

  test("type-root remember on a stash with the organization fact emits the canonical hint", async () => {
    seedConventionFact("conventions/organization.md", "Scope-born memories live under memories/<project>/.");

    const { code, stdout } = await runCliCapture(["remember", "Root-level note for the hint check"]);
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as { ok: boolean; hint?: string };
    expect(json.ok).toBe(true);
    expect(json.hint ?? "").toContain("placement conventions");
    expect(json.hint ?? "").toContain("facts/conventions/organization");
  });

  test("convention facts WITHOUT the organization fact fall back to generic wording (no dead ref)", async () => {
    seedConventionFact("naming.md", "Use kebab-case asset names.");

    const { code, stdout } = await runCliCapture(["remember", "Root-level note, custom conventions only"]);
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as { hint?: string };
    expect(json.hint ?? "").toContain("placement conventions");
    // The canonical fact does not exist in this stash — the hint must not
    // point `akm show` at a ref that would return not-found.
    expect(json.hint ?? "").not.toContain("facts/conventions/organization");
  });

  test("a --path (non-root) write emits no hint", async () => {
    seedConventionFact("conventions/organization.md", "Scope-born memories live under memories/<project>/.");

    const { code, stdout } = await runCliCapture(["remember", "Nested note", "--path", "projects/demo"]);
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect("hint" in json).toBe(false);
  });

  test("a stash without convention facts emits no hint", async () => {
    const { code, stdout } = await runCliCapture(["remember", "Plain stash note"]);
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect("hint" in json).toBe(false);
  });

  test("type-root import emits the hint too (shared write pipeline)", async () => {
    seedConventionFact("conventions/organization.md", "Reference docs live under knowledge/<area>/.");
    const sourcePath = makeSourceFile("root-doc.md", "# Root doc\n\nLands at the knowledge root.\n");

    const { code, stdout } = await runCliCapture(["import", sourcePath]);
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as { ok: boolean; hint?: string };
    expect(json.ok).toBe(true);
    expect(json.hint ?? "").toContain("knowledge root");
  });
});

// ── help meta ────────────────────────────────────────────────────────────────

describe("--xref in command help meta", () => {
  /** Resolve a citty args def that may be a value, promise, or thunk. */
  async function resolveArgs(command: unknown): Promise<Record<string, { type?: string; description?: string }>> {
    const raw = (command as { args?: unknown }).args;
    const resolved = typeof raw === "function" ? await raw() : await raw;
    return (resolved ?? {}) as Record<string, { type?: string; description?: string }>;
  }

  test("remember declares --xref with a description and renders it in usage", async () => {
    const args = await resolveArgs(rememberCommand);
    expect(Object.keys(args)).toContain("xref");
    expect((args.xref?.description ?? "").length).toBeGreaterThan(0);

    const usage = await renderUsage(rememberCommand as Parameters<typeof renderUsage>[0]);
    expect(usage).toContain("--xref");
  });

  test("import declares --xref with a description and renders it in usage", async () => {
    const args = await resolveArgs(importKnowledgeCommand);
    expect(Object.keys(args)).toContain("xref");
    expect((args.xref?.description ?? "").length).toBeGreaterThan(0);

    const usage = await renderUsage(importKnowledgeCommand as Parameters<typeof renderUsage>[0]);
    expect(usage).toContain("--xref");
  });
});
