/**
 * SPEC-3/5 slug stability for `akm import -` (stdin): the same piped content
 * must produce the SAME inferred slug with and without `--xref`.
 *
 * Stdin imports have no filename-derived preferredName, so the slug comes
 * from the content's first non-empty line — which `mergeXrefsIntoContent`
 * used to bury under the leading `---` frontmatter fence, sending
 * `inferAssetName` to its random `knowledge-<epoch>-<rand>` fallback. The fix
 * infers the name from the ORIGINAL pre-merge content.
 *
 * INTEGRATION TEST — lives in tests/integration/ because stdin cannot be
 * injected into the in-process harness (tests/_helpers/cli.ts); each `akm`
 * invocation is a real `bun src/cli.ts` subprocess fed via `input`. The
 * non-stdin slug-stability surface is pinned in
 * tests/commands/remember-import-xref.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Cleanup, sandboxStashDir, writeSandboxConfig } from "../_helpers/sandbox";

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
});

const CLI_PATH = path.resolve(import.meta.dir, "../../src/cli.ts");

/** Run `akm <args>` as a real subprocess with `input` piped to stdin. */
function akmWithStdin(args: string[], input: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bun", [CLI_PATH, ...args], {
    input,
    encoding: "utf8",
    // The sandboxed AKM_STASH_DIR / XDG_* vars are already in process.env
    // (set by the preload + sandbox helpers above).
    env: process.env,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("import - (stdin) slug stability under --xref", () => {
  test("the same stdin content produces the same slug with and without --xref", () => {
    const seedPath = path.join(stashDir, "knowledge", "auth-flow.md");
    fs.mkdirSync(path.dirname(seedPath), { recursive: true });
    fs.writeFileSync(seedPath, "# Seed\n\nSeed content.\n", "utf8");
    const body = "# Auth notes\n\nOAuth details worth keeping.\n";

    const plain = akmWithStdin(["import", "-"], body);
    expect(plain.status, plain.stderr).toBe(0);
    const plainRef = (JSON.parse(plain.stdout) as { ref: string }).ref;
    expect(plainRef).toBe("knowledge/auth-notes");

    // The structured path (forced by --xref) must derive the identical slug
    // from the pre-merge content — not a random knowledge-<epoch>-<rand>
    // fallback taken from the merged frontmatter fence. --force proves the
    // name collides with the plain-path write.
    const structured = akmWithStdin(["import", "-", "--force", "--xref", "knowledge:auth-flow"], body);
    expect(structured.status, structured.stderr).toBe(0);
    expect((JSON.parse(structured.stdout) as { ref: string }).ref).toBe(plainRef);
  });

  test("a stdin doc CARRYING ITS OWN frontmatter derives its slug from the parsed body — same with and without --xref (R2-3)", () => {
    // Exactly the doc class mergeXrefsIntoContent's merge branch exists for:
    // the raw content's first non-empty line is the `---` fence, which sent
    // inferAssetName to its random knowledge-<epoch>-<rand> fallback on BOTH
    // paths. The name must come from the parsed body's heading instead.
    const seedPath = path.join(stashDir, "knowledge", "legacy-guide.md");
    fs.mkdirSync(path.dirname(seedPath), { recursive: true });
    fs.writeFileSync(seedPath, "# Seed\n\nSeed content.\n", "utf8");
    const body = "---\ndescription: carried frontmatter\n---\n\n# Frontmattered Guide\n\nBody worth keeping.\n";

    const plain = akmWithStdin(["import", "-"], body);
    expect(plain.status, plain.stderr).toBe(0);
    const plainRef = (JSON.parse(plain.stdout) as { ref: string }).ref;
    expect(plainRef).toBe("knowledge/frontmattered-guide");

    const structured = akmWithStdin(["import", "-", "--force", "--xref", "knowledge:legacy-guide"], body);
    expect(structured.status, structured.stderr).toBe(0);
    expect((JSON.parse(structured.stdout) as { ref: string }).ref).toBe(plainRef);
  });
});
