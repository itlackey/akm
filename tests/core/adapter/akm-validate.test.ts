// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-C gate — the `akm` adapter's per-`type` `validate`
 * (`src/core/adapter/adapters/akm-adapter.ts` + `akm-lint.ts`), implementing
 * `docs/design/akm-0.9.0-bundle-adapter-spec.md` §6 as a behavior-preserving
 * port of `src/commands/lint/*`'s type linters.
 *
 * The FROZEN lint golden (`tests/fixtures/goldens/lint/all-types.json`,
 * `perType`) is the conformance gate. This suite asserts:
 *
 *   1. CLEAN parity — validate over every all-types fixture file produces
 *      EXACTLY the golden's `perType` issues (all empty), for all 14 types
 *      (incl. the DefaultLinter-only script/secret/wiki/session and the
 *      workflow-program-yaml form), plus skill's empty `lintDirectoryIssues`;
 *   2. POSITIVE per-type findings — a dirty input per representative linter
 *      fires its diagnostic (missing-skill-md / invalid-task-yaml /
 *      dangerous-vault-key + name-or-type / missing-category);
 *   3. READ-ONLY discipline — placeholder-stub / orphaned-stub are emitted as
 *      NON-fixable Diagnostics, never a delete;
 *   4. env/secret dangerous-key `.env`-suffix NARROWNESS is preserved.
 *
 * Neither the fixture nor any golden is modified.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmAdapter } from "../../../src/core/adapter/adapters/akm-adapter";
import type { BundleComponent, Diagnostic, ValidateContext } from "../../../src/core/adapter/types";
import type { FileChange } from "../../../src/core/file-change";

const ALL_TYPES_ROOT = path.resolve(__dirname, "../../fixtures/stashes/all-types");
const BUNDLE_ID = "all-types";

interface LintGolden {
  perType: Record<string, { relPath: string; issues?: unknown[]; lintDirectoryIssues?: unknown[] }>;
}
const LINT_GOLDEN = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../fixtures/goldens/lint/all-types.json"), "utf8"),
) as LintGolden;

function component(overrides: Partial<BundleComponent> = {}): BundleComponent {
  return { id: BUNDLE_ID, adapter: "akm", root: ALL_TYPES_ROOT, writable: true, ...overrides };
}

/** Disk-backed ValidateContext (reads the real fixture stash) — for the CLEAN golden-parity run. */
function diskCtx(root: string): ValidateContext {
  return {
    readFile: async (p) => {
      const abs = path.isAbsolute(p) ? p : path.join(root, p);
      try {
        return fs.readFileSync(abs, "utf8");
      } catch {
        return null;
      }
    },
    list: async (dir) => {
      try {
        return fs.readdirSync(path.isAbsolute(dir) ? dir : path.join(root, dir));
      } catch {
        return [];
      }
    },
    resolveRef: async () => ({ exists: false }),
  };
}

/** In-memory overlay ValidateContext — for POSITIVE synthetic inputs. Keys are stash-relative POSIX paths. */
function overlayCtx(root: string, files: Record<string, string>): ValidateContext {
  const at = (p: string) => (path.isAbsolute(p) ? path.relative(root, p) : p).replace(/\\/g, "/");
  return {
    readFile: async (p) => files[at(p)] ?? null,
    list: async () => [],
    resolveRef: async () => ({ exists: false }),
  };
}

function change(relPath: string, content: string, op: FileChange["op"] = "create"): FileChange {
  return { path: relPath, after: content, op };
}

// ── 1. CLEAN parity vs the frozen lint golden ────────────────────────────────

describe("akm adapter — validate reproduces the lint golden perType (clean, §6)", () => {
  test("every fixture type validates to EXACTLY the golden's (empty) issues", async () => {
    const ctx = diskCtx(ALL_TYPES_ROOT);
    let asserted = 0;
    for (const [key, entry] of Object.entries(LINT_GOLDEN.perType)) {
      const raw = fs.readFileSync(path.join(ALL_TYPES_ROOT, entry.relPath), "utf8");
      const diags = await akmAdapter.validate(component(), [change(entry.relPath, raw, "update")], ctx);
      // `workflowProgramYaml` is a parseWorkflowProgram correctness entry, not a
      // lint path — production never lints it; validate must still be clean.
      const expectedIssues = entry.issues ?? [];
      expect(diags, `validate issues for ${key} (${entry.relPath})`).toEqual(expectedIssues as Diagnostic[]);
      // skill additionally pins an empty directory-level check.
      if (entry.lintDirectoryIssues !== undefined) {
        expect(diags, `skill lintDirectoryIssues for ${key}`).toEqual(entry.lintDirectoryIssues as Diagnostic[]);
      }
      asserted += 1;
    }
    // All 15 perType keys (14 types + workflowProgramYaml) exercised.
    expect(asserted).toBe(Object.keys(LINT_GOLDEN.perType).length);
    expect(asserted).toBe(15);
  });

  test("the DefaultLinter-only types (script/secret/wiki/session/lesson) are clean via base checks only", async () => {
    const ctx = diskCtx(ALL_TYPES_ROOT);
    for (const rel of [
      "scripts/all-types-script.sh",
      "secrets/all-types-secret",
      "wikis/all-types-space/all-types-wiki.md",
      "sessions/all-types-harness/all-types-session.md",
      "lessons/all-types-lesson.md",
    ]) {
      const raw = fs.readFileSync(path.join(ALL_TYPES_ROOT, rel), "utf8");
      expect(await akmAdapter.validate(component(), [change(rel, raw, "update")], ctx)).toEqual([]);
    }
  });
});

// ── 2. positive per-type findings ────────────────────────────────────────────

describe("akm adapter — validate fires each type's positive finding (§6)", () => {
  const ROOT = "/virtual";
  const issues = (diags: Diagnostic[]) => diags.map((d) => d.issue);

  test("missing-skill-md — a skill dir with no SKILL.md (SkillLinter.lintDirectory)", async () => {
    const ctx = overlayCtx(ROOT, { "skills/broken/notes.md": "# notes\n\nbody\n" });
    const diags = await akmAdapter.validate(
      component({ root: ROOT }),
      [change("skills/broken/notes.md", "# notes\n\nbody\n")],
      ctx,
    );
    const hit = diags.find((d) => d.issue === "missing-skill-md");
    expect(hit).toBeDefined();
    expect(hit?.file).toBe("skills/broken");
    expect(hit?.detail).toBe("no SKILL.md in skills/broken/");
    expect(hit?.fixed).toBe(false);
  });

  test("missing-skill-md does NOT fire when SKILL.md is present in the overlay", async () => {
    const ctx = overlayCtx(ROOT, {
      "skills/ok/notes.md": "# notes\n",
      "skills/ok/SKILL.md": "---\nupdated: 2025-01-01\n---\n# skill\n",
    });
    const diags = await akmAdapter.validate(
      component({ root: ROOT }),
      [change("skills/ok/notes.md", "# notes\n")],
      ctx,
    );
    expect(issues(diags)).not.toContain("missing-skill-md");
  });

  test("invalid-task-yaml — task missing schedule + enabled (TaskLinter)", async () => {
    const ctx = overlayCtx(ROOT, {});
    const diags = await akmAdapter.validate(component({ root: ROOT }), [change("tasks/bad.yml", "prompt: hi\n")], ctx);
    const hit = diags.find((d) => d.issue === "invalid-task-yaml");
    expect(hit).toBeDefined();
    expect(hit?.detail).toBe("missing required fields: schedule, enabled (must be a boolean)");
  });

  test("dangerous-vault-key — a dangerous key name in an env file (env dangerous-key scan)", async () => {
    const ctx = overlayCtx(ROOT, {});
    const diags = await akmAdapter.validate(
      component({ root: ROOT }),
      [change("env/danger.env", "LD_PRELOAD=libevil.so\nSAFE=1\n")],
      ctx,
    );
    const hit = diags.find((d) => d.issue === "dangerous-vault-key");
    expect(hit).toBeDefined();
    expect(hit?.detail).toContain("LD_PRELOAD");
    expect(hit?.detail).toContain("Ref: env:danger");
    expect(hit?.fixed).toBe(false);
  });

  test("dangerous-vault-key is suppressed by the inline comment (never widened)", async () => {
    const ctx = overlayCtx(ROOT, {});
    const diags = await akmAdapter.validate(
      component({ root: ROOT }),
      [change("env/ok.env", "# akm-lint-ok: dangerous-vault-key\nLD_PRELOAD=x\n")],
      ctx,
    );
    expect(issues(diags)).not.toContain("dangerous-vault-key");
  });

  test("missing-name-or-type — a command with no name/type frontmatter (CommandLinter)", async () => {
    const ctx = overlayCtx(ROOT, {});
    const diags = await akmAdapter.validate(
      component({ root: ROOT }),
      [change("commands/nameless.md", "---\ndescription: x\nupdated: 2025-01-01\n---\nrun $ARGUMENTS\n")],
      ctx,
    );
    const hit = diags.find((d) => d.issue === "missing-name-or-type");
    expect(hit).toBeDefined();
    expect(hit?.detail).toBe("missing fields: name, type; suggested slug: nameless");
  });

  test("missing-category — a fact with no category (FactLinter)", async () => {
    const ctx = overlayCtx(ROOT, {});
    const diags = await akmAdapter.validate(
      component({ root: ROOT }),
      [change("facts/nocat.md", "---\ndescription: x\nupdated: 2025-01-01\n---\n# f\n")],
      ctx,
    );
    const hit = diags.find((d) => d.issue === "missing-category");
    expect(hit).toBeDefined();
    expect(hit?.detail).toContain("fact is missing a `category`");
  });
});

// ── 3. read-only discipline (placeholder-stub / orphaned-stub never delete) ──

describe("akm adapter — validate keeps placeholder-stub / orphaned-stub READ-ONLY (§6)", () => {
  const ROOT = "/virtual";

  test("placeholder-stub is a non-fixable Diagnostic (WorkflowLinter, never deleted)", async () => {
    const ctx = overlayCtx(ROOT, {});
    const raw = "# Workflow: Example Workflow\n\n## Step: a\nStep ID: a\n\n### Instructions\ndo it\n";
    const diags = await akmAdapter.validate(component({ root: ROOT }), [change("workflows/stub.md", raw)], ctx);
    const hit = diags.find((d) => d.issue === "placeholder-stub");
    expect(hit).toBeDefined();
    expect(hit?.detail).toBe('placeholder text: "Example Workflow"');
    expect(hit?.fixed).toBe(false); // NEVER a delete
  });

  test("orphaned-stub is a non-fixable Diagnostic (MemoryLinter, ctx sibling probe, never deleted)", async () => {
    // inferenceProcessed + short body + no `.derived.md` sibling in the overlay.
    const ctx = overlayCtx(ROOT, {});
    const raw = "---\ninferenceProcessed: true\nupdated: 2025-01-01\n---\nshort\n";
    const diags = await akmAdapter.validate(component({ root: ROOT }), [change("memories/stub.md", raw)], ctx);
    const hit = diags.find((d) => d.issue === "orphaned-stub");
    expect(hit).toBeDefined();
    expect(hit?.detail).toBe("inferenceProcessed stub with no derived sibling");
    expect(hit?.fixed).toBe(false); // NEVER a delete
  });

  test("orphaned-stub does NOT fire when the derived sibling exists in the overlay", async () => {
    const ctx = overlayCtx(ROOT, { "memories/stub.derived.md": "# derived\n" });
    const raw = "---\ninferenceProcessed: true\nupdated: 2025-01-01\n---\nshort\n";
    const diags = await akmAdapter.validate(component({ root: ROOT }), [change("memories/stub.md", raw)], ctx);
    expect(diags.map((d) => d.issue)).not.toContain("orphaned-stub");
  });
});

// ── 4. env/secret dangerous-key `.env`-suffix narrowness ─────────────────────

describe("akm adapter — env/secret dangerous-key `.env`-suffix narrowness preserved (§6)", () => {
  const ROOT = "/virtual";

  test("a bare (non-`.env`) secret file is NOT scanned even with a dangerous-looking key", async () => {
    // secrets/<bare> is a secret VALUE, never reached by collectEnvFiles.
    const ctx = overlayCtx(ROOT, {});
    const diags = await akmAdapter.validate(
      component({ root: ROOT }),
      [change("secrets/mytoken", "LD_PRELOAD=x\n")],
      ctx,
    );
    expect(diags.map((d) => d.issue)).not.toContain("dangerous-vault-key");
  });

  test("a `.env`-suffixed secret file IS scanned, and reports the `secret:` ref prefix", async () => {
    const ctx = overlayCtx(ROOT, {});
    const diags = await akmAdapter.validate(
      component({ root: ROOT }),
      [change("secrets/creds.env", "LD_PRELOAD=x\n")],
      ctx,
    );
    const hit = diags.find((d) => d.issue === "dangerous-vault-key");
    expect(hit).toBeDefined();
    expect(hit?.detail).toContain("Ref: secret:creds");
  });
});
