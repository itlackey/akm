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
 *     lenient parser fallback; without --xref the same doc imports verbatim.
 *   - Type-root writes into a stash with convention facts emit the additive
 *     `hint` output key (spec test-plan item 6); nested/--path writes and
 *     convention-less stashes do not, and the canonical
 *     `fact:conventions/organization` pointer only appears when that fact
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
import { parseFrontmatter } from "../../src/core/asset/frontmatter";
import { UsageError } from "../../src/core/errors";
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

// ── remember --xref ──────────────────────────────────────────────────────────

describe("remember --xref", () => {
  test("single resolvable --xref lands in the written frontmatter xrefs list", async () => {
    seedAsset(stashDir, "knowledge/auth-flow.md");

    // No --tag: --xref counts as structured metadata but must NOT trigger the
    // tags-required check (spec: provenance without tags is a valid write).
    const { code, stdout } = await runCliCapture([
      "remember",
      "Derived note about the auth flow",
      "--xref",
      "knowledge:auth-flow",
    ]);
    expect(code).toBe(0);

    const json = JSON.parse(stdout) as { ok: boolean; ref: string; path: string };
    expect(json.ok).toBe(true);

    const parsed = parseFrontmatter(fs.readFileSync(json.path, "utf8"));
    expect(parsed.data.xrefs).toEqual(["knowledge:auth-flow"]);
    // The hot-path markers still ride along in the SAME frontmatter block —
    // xrefs merge into the generated frontmatter, they don't replace it.
    expect(parsed.data.captureMode).toBe("hot");
    expect(parsed.data.beliefState).toBe("asserted");
    expect(parsed.content).toContain("Derived note about the auth flow");
  });

  test("--xref is repeatable and preserves argv order", async () => {
    seedAsset(stashDir, "knowledge/auth-flow.md");
    seedAsset(stashDir, "memories/vpn-note.md", "VPN is required for staging.\n");

    const { code, stdout } = await runCliCapture([
      "remember",
      "Synthesis of auth flow and VPN notes",
      "--xref",
      "knowledge:auth-flow",
      "--xref",
      "memory:vpn-note",
    ]);
    expect(code).toBe(0);

    const json = JSON.parse(stdout) as { path: string };
    const parsed = parseFrontmatter(fs.readFileSync(json.path, "utf8"));
    expect(parsed.data.xrefs).toEqual(["knowledge:auth-flow", "memory:vpn-note"]);
  });

  test("--xref composes with --tag in one frontmatter block", async () => {
    seedAsset(stashDir, "knowledge/auth-flow.md");

    const { code, stdout } = await runCliCapture([
      "remember",
      "Tagged derived note",
      "--tag",
      "ops",
      "--xref",
      "knowledge:auth-flow",
    ]);
    expect(code).toBe(0);

    const json = JSON.parse(stdout) as { path: string };
    const raw = fs.readFileSync(json.path, "utf8");
    const parsed = parseFrontmatter(raw);
    expect(parsed.data.tags).toEqual(["ops"]);
    expect(parsed.data.xrefs).toEqual(["knowledge:auth-flow"]);
    // Exactly one frontmatter block: opening + closing fence only.
    expect(raw.match(/^---\s*$/gm)?.length).toBe(2);
  });

  test("unresolvable --xref fails with exit 2 usage envelope and writes nothing", async () => {
    const { code, stderr } = await runCliCapture([
      "remember",
      "This must not be written",
      "--xref",
      "knowledge:does-not-exist",
    ]);
    expect(code).toBe(2);

    const json = JSON.parse(stderr) as { ok: boolean; error: string; code?: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain("knowledge:does-not-exist");
    expect(typeof json.code).toBe("string");

    // Validation happens BEFORE any write: the stash stays empty.
    expect(listDirRecursive(path.join(stashDir, "memories"))).toEqual([]);
  });

  test("one bad ref among resolvable ones still fails and writes nothing", async () => {
    seedAsset(stashDir, "knowledge/auth-flow.md");

    const { code, stderr } = await runCliCapture([
      "remember",
      "Mixed refs must not be written",
      "--tag",
      "ops",
      "--xref",
      "knowledge:auth-flow",
      "--xref",
      "memory:ghost-note",
    ]);
    expect(code).toBe(2);

    const json = JSON.parse(stderr) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    // The error names the ref(s) that failed to resolve.
    expect(json.error).toContain("memory:ghost-note");

    expect(listDirRecursive(path.join(stashDir, "memories"))).toEqual([]);
  });

  test("cross-stash ref resolvable only in a configured extra source is accepted", async () => {
    const extraDir = makeDir("akm-xref-extra-stash");
    seedAsset(extraDir, "knowledge/shared-doc.md");
    writeSandboxConfig({
      semanticSearchMode: "off",
      sources: [{ type: "filesystem", name: "extra-stash", path: extraDir, writable: false }],
    });

    const { code, stdout } = await runCliCapture([
      "remember",
      "Derived from the shared cross-stash doc",
      "--xref",
      "knowledge:shared-doc",
    ]);
    expect(code).toBe(0);

    const json = JSON.parse(stdout) as { ok: boolean; path: string };
    expect(json.ok).toBe(true);
    // Written to the PRIMARY stash while citing the extra-stash asset.
    expect(json.path.startsWith(stashDir)).toBe(true);
    const parsed = parseFrontmatter(fs.readFileSync(json.path, "utf8"));
    expect(parsed.data.xrefs).toEqual(["knowledge:shared-doc"]);
  });

  test("more than 5 xrefs warns on stderr but still writes (soft cap)", async () => {
    for (let i = 1; i <= 6; i++) {
      seedAsset(stashDir, `knowledge/doc-${i}.md`);
    }
    const args = ["remember", "Heavily cited note"];
    for (let i = 1; i <= 6; i++) {
      args.push("--xref", `knowledge:doc-${i}`);
    }

    const { code, stdout, stderr } = await runCliCapture(args);
    expect(code).toBe(0);

    const json = JSON.parse(stdout) as { ok: boolean; path: string };
    expect(json.ok).toBe(true);
    const parsed = parseFrontmatter(fs.readFileSync(json.path, "utf8"));
    expect(parsed.data.xrefs).toEqual([
      "knowledge:doc-1",
      "knowledge:doc-2",
      "knowledge:doc-3",
      "knowledge:doc-4",
      "knowledge:doc-5",
      "knowledge:doc-6",
    ]);
    // Soft cap: a warning is emitted, not an error.
    expect(stderr.toLowerCase()).toContain("xref");
  });

  test("written xrefs fold into FTS hints: the memory is findable by its cited ref slug", async () => {
    seedAsset(stashDir, "knowledge/oauth-refresh-dance.md");

    const remember = await runCliCapture([
      "remember",
      "Token rotation gotcha worth keeping",
      "--xref",
      "knowledge:oauth-refresh-dance",
    ]);
    expect(remember.code).toBe(0);
    const written = JSON.parse(remember.stdout) as { ref: string };

    // The cited slug appears ONLY in the xref (not in the memory's body, name,
    // or tags), so a search hit proves the indexer folded the frontmatter
    // xrefs into the FTS hints — the conventions' provenance channel.
    const search = await runCliCapture(["search", "oauth-refresh-dance", "--type", "memory"]);
    expect(search.code).toBe(0);
    const hits = (JSON.parse(search.stdout).hits ?? []) as Array<{ ref: string }>;
    expect(hits.map((h) => h.ref)).toContain(written.ref);
  });
});

// ── root set + resolver parity with lint (findings #6/#7) ───────────────────

describe("--xref root set and resolver parity", () => {
  test("resolves working-stash refs when defaultWriteTarget routes the write to a named source", async () => {
    // The primary working stash (AKM_STASH_DIR) is NOT in config.sources here,
    // and the write goes to the named "team" source — the root set must still
    // include the working stash (--supersedes already did; --xref did not).
    const teamDir = makeDir("akm-xref-team-target");
    seedAsset(stashDir, "memories/local-note.md", "Working-stash note.\n");
    writeSandboxConfig({
      semanticSearchMode: "off",
      defaultWriteTarget: "team",
      sources: [{ type: "filesystem", name: "team", path: teamDir, writable: true }],
    });

    const { code, stdout } = await runCliCapture([
      "remember",
      "Note derived from the working-stash one",
      "--xref",
      "memory:local-note",
    ]);
    expect(code).toBe(0);

    const json = JSON.parse(stdout) as { path: string };
    // Written to the named target while citing the working-stash asset.
    expect(json.path.startsWith(teamDir)).toBe(true);
    const parsed = parseFrontmatter(fs.readFileSync(json.path, "utf8"));
    expect(parsed.data.xrefs).toEqual(["memory:local-note"]);
  });

  test("script: refs are accepted without existence validation (fail-open, mirrors lint)", async () => {
    // script: is contract-pinned unresolvable by the slug resolver
    // (refToRelPath returns null); lint fails OPEN on it, and the PR's own
    // convention docs instruct agents to write `--xref script:build/release`.
    seedAsset(stashDir, "scripts/build/release.sh", "#!/bin/sh\necho release\n");

    const seeded = await runCliCapture(["remember", "Release script tip", "--xref", "script:build/release.sh"]);
    expect(seeded.code).toBe(0);
    const seededParsed = parseFrontmatter(
      fs.readFileSync((JSON.parse(seeded.stdout) as { path: string }).path, "utf8"),
    );
    expect(seededParsed.data.xrefs).toEqual(["script:build/release.sh"]);

    // Fail-open means no existence check at all — same as lint's body scan.
    const ghost = await runCliCapture(["remember", "Ghost script tip", "--xref", "script:no-such-script.sh"]);
    expect(ghost.code).toBe(0);
  });

  test("workflow: refs resolve YAML workflow programs against the stash roots, not the cwd", async () => {
    // The cwd here is the repo root, NOT the stash root — the old cwd-relative
    // `workflowSpec.toAssetPath` probe made this exit 2 from any other cwd.
    seedAsset(stashDir, "workflows/deploy.yaml", "steps:\n  - run: echo hi\n");

    const { code, stdout } = await runCliCapture(["remember", "Deploy workflow tip", "--xref", "workflow:deploy"]);
    expect(code).toBe(0);
    const parsed = parseFrontmatter(fs.readFileSync((JSON.parse(stdout) as { path: string }).path, "utf8"));
    expect(parsed.data.xrefs).toEqual(["workflow:deploy"]);

    // workflow: does NOT blanket fail-open: a ref resolving nowhere still fails.
    const ghost = await runCliCapture(["remember", "Ghost workflow tip", "--xref", "workflow:ghost-flow"]);
    expect(ghost.code).toBe(2);
    expect((JSON.parse(ghost.stderr) as { error: string }).error).toContain("workflow:ghost-flow");
  });

  test("origin-prefixed and malformed refs get a structured parse error, not 'did not resolve'", async () => {
    seedAsset(stashDir, "knowledge/auth-flow.md");

    const remote = await runCliCapture(["remember", "x", "--xref", "npm:pkg//knowledge:auth-flow"]);
    expect(remote.code).toBe(2);
    const remoteJson = JSON.parse(remote.stderr) as { error: string; code?: string };
    expect(remoteJson.code).toBe("INVALID_FLAG_VALUE");
    expect(remoteJson.error).toContain("origin");
    expect(remoteJson.error).not.toContain("did not resolve");

    const badType = await runCliCapture(["remember", "x", "--xref", "notatype:foo"]);
    expect(badType.code).toBe(2);
    expect((JSON.parse(badType.stderr) as { error: string }).error.toLowerCase()).toContain("invalid asset type");

    // local// names the same local resolution this validator performs —
    // accepted, and persisted in the canonical bare form (the prefix is
    // stripped, mirroring lint's local// strip) so later ref scanners see
    // the same spelling the resolver validated.
    const local = await runCliCapture(["remember", "Locally cited note", "--xref", "local//knowledge:auth-flow"]);
    expect(local.code).toBe(0);
    const localParsed = parseFrontmatter(fs.readFileSync((JSON.parse(local.stdout) as { path: string }).path, "utf8"));
    expect(localParsed.data.xrefs).toEqual(["knowledge:auth-flow"]);
  });

  test("alias spellings parseAssetRef normalizes are persisted CANONICALLY, validated and deduped as one ref", async () => {
    // `environment:` is the accepted alias of the canonical `env:` type
    // (asset-ref.ts TYPE_ALIASES). Validation resolves the parsed components,
    // so persisting the RAW spelling would store an xref string later
    // scanners (lint's registry-derived REF_RE, mv's rewriter) never match.
    seedAsset(stashDir, "env/prod.env", "API_URL=https://example.test\n");

    const { code, stdout } = await runCliCapture([
      "remember",
      "Note citing the prod environment",
      "--xref",
      "environment:prod",
    ]);
    expect(code).toBe(0);
    const parsed = parseFrontmatter(fs.readFileSync((JSON.parse(stdout) as { path: string }).path, "utf8"));
    expect(parsed.data.xrefs).toEqual(["env:prod"]);

    // Two spellings of the SAME asset dedupe into one canonical entry.
    seedAsset(stashDir, "knowledge/auth-flow.md");
    const dupe = await runCliCapture([
      "remember",
      "Note citing one asset twice",
      "--xref",
      "local//knowledge:auth-flow",
      "--xref",
      "knowledge:auth-flow",
    ]);
    expect(dupe.code).toBe(0);
    const dupeParsed = parseFrontmatter(fs.readFileSync((JSON.parse(dupe.stdout) as { path: string }).path, "utf8"));
    expect(dupeParsed.data.xrefs).toEqual(["knowledge:auth-flow"]);
  });
});

// ── slug stability under --xref/--supersedes (finding #12) ───────────────────

describe("--xref/--supersedes do not change the inferred slug", () => {
  test("remember: the same content produces the same slug with and without --xref", async () => {
    seedAsset(stashDir, "knowledge/auth-flow.md");
    const content = "the deploy process now uses blue-green rollout";

    const plain = await runCliCapture(["remember", content]);
    expect(plain.code).toBe(0);
    const plainRef = (JSON.parse(plain.stdout) as { ref: string }).ref;
    expect(plainRef).toBe("memory:the-deploy-process-now-uses-blue-green-rollout");

    // The structured path (forced by --xref) must derive the identical slug
    // from the body — not a random memory-<epoch>-<rand> fallback taken from
    // the generated frontmatter fence. --force proves the name collides.
    const structured = await runCliCapture(["remember", content, "--force", "--xref", "knowledge:auth-flow"]);
    expect(structured.code).toBe(0);
    expect((JSON.parse(structured.stdout) as { ref: string }).ref).toBe(plainRef);
  });

  // The stdin variant (`akm import -`) needs a REAL subprocess (stdin cannot
  // be injected into the in-process harness), so it lives in
  // tests/integration/import-stdin-xref-slug.test.ts per the isolation lint.
});

// ── import --xref ────────────────────────────────────────────────────────────

describe("import --xref", () => {
  test("--xref adds a frontmatter block to a frontmatter-less document", async () => {
    seedAsset(stashDir, "knowledge/auth-flow.md");
    const sourcePath = makeSourceFile("auth-notes.md", "# Auth notes\n\nOAuth details worth keeping.\n");

    const { code, stdout } = await runCliCapture(["import", sourcePath, "--xref", "knowledge:auth-flow"]);
    expect(code).toBe(0);

    const json = JSON.parse(stdout) as { ok: boolean; ref: string; path: string };
    expect(json.ok).toBe(true);

    const raw = fs.readFileSync(json.path, "utf8");
    expect(raw.startsWith("---")).toBe(true);
    const parsed = parseFrontmatter(raw);
    expect(parsed.data.xrefs).toEqual(["knowledge:auth-flow"]);
    // Body intact and no frontmatter leaked into it.
    expect(parsed.content).toContain("# Auth notes");
    expect(parsed.content).toContain("OAuth details worth keeping.");
    expect(parsed.content).not.toContain("xrefs:");
    expect(raw.match(/^---\s*$/gm)?.length).toBe(2);
  });

  test("--xref merges into existing frontmatter without nesting a second block", async () => {
    seedAsset(stashDir, "knowledge/auth-flow.md");
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

    const { code, stdout } = await runCliCapture(["import", sourcePath, "--xref", "knowledge:auth-flow"]);
    expect(code).toBe(0);

    const json = JSON.parse(stdout) as { path: string };
    const raw = fs.readFileSync(json.path, "utf8");
    const parsed = parseFrontmatter(raw);

    // Existing keys preserved, xrefs appended — one merged block.
    expect(parsed.data.description).toBe("Existing description");
    expect(parsed.data.tags).toEqual(["auth"]);
    expect(parsed.data.xrefs).toEqual(["knowledge:auth-flow"]);

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
    const sourcePath = makeSourceFile(
      "already-cited.md",
      ["---", "xrefs:", "  - knowledge:auth-flow", "---", "", "Body citing prior work.", ""].join("\n"),
    );

    const { code, stdout } = await runCliCapture([
      "import",
      sourcePath,
      "--xref",
      "knowledge:auth-flow",
      "--xref",
      "memory:vpn-note",
    ]);
    expect(code).toBe(0);

    const json = JSON.parse(stdout) as { path: string };
    const parsed = parseFrontmatter(fs.readFileSync(json.path, "utf8"));
    // The duplicate ref appears once; the new ref is appended.
    expect(parsed.data.xrefs).toEqual(["knowledge:auth-flow", "memory:vpn-note"]);
  });

  test("unresolvable --xref fails with exit 2 usage envelope and writes nothing", async () => {
    const sourcePath = makeSourceFile("doomed.md", "# Doomed\n\nMust not land in the stash.\n");

    const { code, stderr } = await runCliCapture(["import", sourcePath, "--xref", "knowledge:ghost-doc"]);
    expect(code).toBe(2);

    const json = JSON.parse(stderr) as { ok: boolean; error: string; code?: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain("knowledge:ghost-doc");
    expect(typeof json.code).toBe("string");

    expect(listDirRecursive(path.join(stashDir, "knowledge"))).toEqual([]);
  });

  test("--xref onto malformed frontmatter fails loudly instead of silently flattening values", async () => {
    seedAsset(stashDir, "knowledge/auth-flow.md");
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
    const { code, stderr } = await runCliCapture(["import", sourcePath, "--xref", "knowledge:auth-flow"]);
    expect(code).toBe(2);
    const json = JSON.parse(stderr) as { ok: boolean; error: string; code?: string };
    expect(json.ok).toBe(false);
    expect(json.error.toLowerCase()).toContain("frontmatter");
    expect(typeof json.code).toBe("string");
    expect(listDirRecursive(path.join(stashDir, "knowledge"))).toEqual(["auth-flow.md"]);

    // WITHOUT --xref the same document imports verbatim — malformed
    // frontmatter is preserved byte-for-byte for a human to repair.
    const plain = await runCliCapture(["import", sourcePath]);
    expect(plain.code).toBe(0);
    const plainJson = JSON.parse(plain.stdout) as { path: string };
    expect(fs.readFileSync(plainJson.path, "utf8")).toBe(malformed);
  });
});

// ── mergeXrefsIntoContent safety (unit) ──────────────────────────────────────

describe("mergeXrefsIntoContent refuses non-mergeable frontmatter", () => {
  test("malformed YAML (lenient-fallback territory) throws UsageError", () => {
    const doc = ["---", 'description: "unterminated', "tags:", "  - auth", "---", "", "Body.", ""].join("\n");
    expect(() => mergeXrefsIntoContent(doc, ["knowledge:auth-flow"])).toThrow(UsageError);
  });

  test("a non-mapping frontmatter block (comments only) throws instead of being dropped", () => {
    const doc = ["---", "# a comment-only block parses to null", "---", "", "Body.", ""].join("\n");
    expect(() => mergeXrefsIntoContent(doc, ["knowledge:auth-flow"])).toThrow(UsageError);
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
    expect(json.hint ?? "").toContain("fact:conventions/organization");
  });

  test("convention facts WITHOUT the organization fact fall back to generic wording (no dead ref)", async () => {
    seedConventionFact("naming.md", "Use kebab-case asset names.");

    const { code, stdout } = await runCliCapture(["remember", "Root-level note, custom conventions only"]);
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as { hint?: string };
    expect(json.hint ?? "").toContain("placement conventions");
    // The canonical fact does not exist in this stash — the hint must not
    // point `akm show` at a ref that would return not-found.
    expect(json.hint ?? "").not.toContain("fact:conventions/organization");
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
