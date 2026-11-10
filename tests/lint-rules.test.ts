// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lintLockfile } from "../scripts/lint-lockfile";
import { contentHash } from "../src/commands/improve/content-hash";
import { analyzeMemoryCleanup, applyMemoryCleanup } from "../src/commands/improve/memory/memory-improve";
import { akmLint } from "../src/commands/lint";
import { runBaseChecks } from "../src/commands/lint/base-linter";
import { ADVISORY_LINT_ISSUES, isAdvisoryLintIssue } from "../src/commands/lint/types";
import { akmProposalAccept } from "../src/commands/proposal/proposal";
import { createRetireProposal } from "../src/commands/proposal/repository";
import { agentSkillsAdapter } from "../src/core/adapter/adapters/agent-skills-adapter";
import { akmAdapter } from "../src/core/adapter/adapters/akm-adapter";
import { workflowFrontendDiagnostics, workflowStructureDiagnostics } from "../src/core/adapter/adapters/akm-lint";
import { akmTaskAdapter } from "../src/core/adapter/adapters/akm-task-adapter";
import { detectAdapterId } from "../src/core/adapter/detect-adapter";
import type { BundleComponent } from "../src/core/adapter/types";
import { createValidateContext } from "../src/core/adapter/validate-context";
import { resetMemoryArchiveCache } from "../src/core/asset/memory-archive";
import { UsageError } from "../src/core/errors";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import * as workflowParser from "../src/workflows/parser";
import { makeConfig } from "./_helpers/factories";
import { type IsolatedAkmStorage, makeSandboxDir, sandboxEnvDir, withIsolatedAkmStorage } from "./_helpers/sandbox";
import { overrideSeam } from "./_helpers/seams";
import { workflowDoc } from "./_helpers/workflow";

describe("akm lint redacted durable content (#962)", () => {
  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });

  afterEach(() => storage.cleanup());

  test("reports an asset containing [REDACTED] without rewriting it", async () => {
    const file = path.join(storage.stashDir, "knowledge", "damaged.md");
    const content = "---\ndescription: Damaged asset\nupdated: 2026-09-19\n---\n\nCosmetic [REDACTED]ments.\n";
    fs.writeFileSync(file, content);

    const result = await akmLint({ dir: storage.stashDir, config: makeConfig(storage.stashDir), fix: true });
    const findings = result.flagged.filter((finding) => finding.issue === "redacted-content");

    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("knowledge/damaged.md");
    expect(findings[0]?.fixed).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(content);
  });

  test("does not flag clean asset content", async () => {
    fs.writeFileSync(
      path.join(storage.stashDir, "knowledge", "clean.md"),
      "---\ndescription: Clean asset\n---\n\nOrdinary content.\n",
    );

    const result = await akmLint({ dir: storage.stashDir, config: makeConfig(storage.stashDir) });
    expect(result.flagged.filter((finding) => finding.issue === "redacted-content")).toEqual([]);
  });
});

// #927 — `stale-path` flagged a run-time filename template (e.g.
// `/reports/portfolio-review-<timestamp>.md`) as a broken literal path. These
// pin the placeholder forms that must be skipped, and that a genuinely
// missing literal path is still reported.

function staleIssues(storage: IsolatedAkmStorage, body: string) {
  const issues = runBaseChecks({
    filePath: `${storage.stashDir}/workflows/w.md`,
    relPath: "workflows/w.md",
    raw: `---\nname: w\n---\n\n${body}`,
    data: { name: "w" },
    body,
    frontmatter: "name: w",
    fix: false,
    stashRoot: storage.stashDir,
  });
  return issues.filter((issue) => issue.issue === "stale-path");
}

describe("stale-path skips run-time filename templates (#927)", () => {
  let storage: IsolatedAkmStorage;
  afterEach(() => storage?.cleanup());

  test.each([
    ["angle-bracket placeholder", "Write to /home/founder3/akm/reports/portfolio-review-<timestamp>.md."],
    ["brace placeholder", "Write to /home/founder3/akm/reports/portfolio-review-{stamp}.md."],
    ["${VAR} placeholder", "Write to /home/founder3/akm/reports/portfolio-review-${STAMP}.md."],
    ["YYYYMMDD date-format run", "Write to /home/founder3/akm/reports/portfolio-review-YYYYMMDD.md."],
    ["HHMMSS date-format run", "Write to /home/founder3/akm/reports/portfolio-review-HHMMSS.md."],
    ["glob star", "Write to /home/founder3/akm/reports/portfolio-review-*.md."],
    ["glob question mark", "Write to /home/founder3/akm/reports/portfolio-review-?.md."],
  ])("%s is not reported", (_label, body) => {
    storage = withIsolatedAkmStorage();
    expect(staleIssues(storage, body)).toEqual([]);
  });

  test("a genuinely missing literal path is still reported", () => {
    storage = withIsolatedAkmStorage();
    const issues = staleIssues(storage, "Write to /home/founder3/akm/reports/portfolio-review-final.md.");
    expect(issues.length).toBe(1);
    expect(issues[0]?.detail).toContain("portfolio-review-final");
  });

  test("an existing literal path is not reported", () => {
    storage = withIsolatedAkmStorage();
    expect(staleIssues(storage, `Read from \`${storage.stashDir}\` for config.`)).toEqual([]);
  });
});

/**
 * `akm lint` fail-closed behavior (§24.2 "Lint" release gate).
 *
 * A mistyped invocation used to scan nothing and report a clean
 * `ok:true, flagged:0`: an unknown `--type` (e.g. singular "workflow")
 * filtered the sweep to zero directories, and a nonexistent `--dir` walked
 * nothing — both silently passing scripted `--fail-on-flagged` gates. Both
 * are now usage errors.
 */

const BROKEN_WORKFLOW = [
  "---",
  "type: workflow",
  "steps:",
  "  - id: work",
  "    output:",
  "      type: strig",
  "---",
  "",
  "## work",
  "",
  "Do it.",
  "",
].join("\n");

function captureWarnings(): { warnings: string[]; restore: () => void } {
  const warnings: string[] = [];
  _setWarnSinkForTests((level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
  return {
    warnings,
    restore: () => {
      _setWarnSinkForTests(undefined);
      _resetWarnOnceForTests();
    },
  };
}

describe("akm lint fails closed on a nonexistent --dir", () => {
  let storage: IsolatedAkmStorage;
  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });
  afterEach(() => storage.cleanup());

  test("a nonexistent --dir is a usage error, not a clean result", async () => {
    const missing = path.join(storage.root, "no-such-bundle");
    await expect(akmLint({ dir: missing, config: makeConfig(storage.stashDir) })).rejects.toBeInstanceOf(UsageError);
  });

  test("an unknown --type on an akm bundle warns and validates the whole bundle instead of refusing", async () => {
    fs.mkdirSync(path.join(storage.stashDir, "workflows"), { recursive: true });
    fs.writeFileSync(path.join(storage.stashDir, "workflows", "broken.md"), BROKEN_WORKFLOW, "utf8");

    const { warnings, restore } = captureWarnings();
    let typoResult: Awaited<ReturnType<typeof akmLint>>;
    try {
      typoResult = await akmLint({
        dir: storage.stashDir,
        typeFilter: "workflow", // singular — the classic typo for "workflows"
        config: makeConfig(storage.stashDir),
      });
    } finally {
      restore();
    }
    const wholeBundleResult = await akmLint({ dir: storage.stashDir, config: makeConfig(storage.stashDir) });

    expect(typoResult.flagged.length).toBeGreaterThan(0);
    expect(typoResult.flagged.length).toBe(wholeBundleResult.flagged.length);
    expect(warnings.some((w) => w.includes('"workflow"') && w.includes("workflows"))).toBe(true);
  });

  test("a valid --type still lints normally", async () => {
    const result = await akmLint({
      dir: storage.stashDir,
      typeFilter: "workflows",
      config: makeConfig(storage.stashDir),
    });
    expect(result.ok).toBe(true);
  });
});

/**
 * `missing-skill-md` is reachable again (issue #774).
 *
 * Two halves of the same gap:
 *
 *   1. `agent-skills` `validate()` iterated CHANGES, and a change is always a
 *      FILE — so a package directory carrying resources but no `SKILL.md`
 *      contributed nothing the loop could see. The code's own comment deferred
 *      the case to `directorySkillDiagnostics`, a symbol that did not exist.
 *      The check is now a real directory pass over `ValidateContext.list`.
 * Both are driven through the real `akm lint` entry point, plus a direct
 * `validate()` call for the containment rules the CLI cannot express.
 */

function write(root: string, relPath: string, content: string): void {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
}

function skillManifest(name: string): string {
  return `---\nname: ${name}\ndescription: A conformant skill used as the clean control.\n---\n\nBody.\n`;
}

describe("agent-skills: a package directory with no SKILL.md is flagged (issue #774)", () => {
  let storage: IsolatedAkmStorage;
  afterEach(() => storage?.cleanup());

  test("akm lint reports missing-skill-md for the manifest-less package only", async () => {
    storage = withIsolatedAkmStorage();
    const root = path.join(storage.root, "skills-pack");

    // A conformant package (also what makes the root detect as agent-skills),
    // with a bundled resource dir that must NOT be treated as its own package.
    write(root, "pdf-processing/SKILL.md", skillManifest("pdf-processing"));
    write(root, "pdf-processing/reference/FORMS.md", "# Forms\n");
    // The broken one: resources, no manifest.
    write(root, "half-built/reference/NOTES.md", "# Notes\n");
    // A root-level file is not a package directory.
    write(root, "README.md", "# Skills pack\n");

    expect(detectAdapterId(root)).toBe("agent-skills");

    const result = await akmLint({ dir: root });
    const missing = result.flagged.filter((issue) => issue.issue === "missing-skill-md");

    expect(missing.map((issue) => issue.file)).toEqual(["half-built"]);
    expect(missing[0]?.detail).toBe("no SKILL.md in half-built/");
    expect(missing[0]?.fixed).toBe(false);
  });

  test("a fully conformant pack stays clean — resource dirs are not candidate packages", async () => {
    storage = withIsolatedAkmStorage();
    const root = path.join(storage.root, "clean-pack");

    write(root, "pdf-processing/SKILL.md", skillManifest("pdf-processing"));
    write(root, "pdf-processing/reference/FORMS.md", "# Forms\n");
    write(root, "pdf-processing/assets/template.txt", "template\n");
    write(root, "README.md", "# Skills pack\n");

    const result = await akmLint({ dir: root });

    expect(result.flagged.filter((issue) => issue.issue === "missing-skill-md")).toEqual([]);
  });

  test("a grouping directory whose children carry manifests is not a broken package", async () => {
    storage = withIsolatedAkmStorage();
    const root = path.join(storage.root, "grouped-pack");

    // `<group>/<name>/SKILL.md` — `skillPackage` accepts the nested shape, so
    // the group dir itself must not be reported for having no manifest of its own.
    write(root, "team/pdf-processing/SKILL.md", skillManifest("pdf-processing"));

    const diagnostics = await agentSkillsAdapter.validate(
      { id: "grouped", adapter: "agent-skills", root, writable: true },
      [{ path: "team/pdf-processing/SKILL.md", op: "update" }],
      createValidateContext({ root }),
    );

    expect(diagnostics.filter((d) => d.issue === "missing-skill-md")).toEqual([]);
  });

  test("one valid grouped package does not hide a manifest-less sibling", async () => {
    storage = withIsolatedAkmStorage();
    const root = path.join(storage.root, "mixed-grouped-pack");

    write(root, "team/pdf-processing/SKILL.md", skillManifest("pdf-processing"));
    write(root, "team/half-built/reference/NOTES.md", "# Notes\n");

    const diagnostics = await agentSkillsAdapter.validate(
      { id: "mixed-grouped", adapter: "agent-skills", root, writable: true },
      [{ path: "team/pdf-processing/SKILL.md", op: "update" }],
      createValidateContext({ root }),
    );

    expect(diagnostics.filter((d) => d.issue === "missing-skill-md")).toEqual([
      {
        file: "team/half-built",
        issue: "missing-skill-md",
        detail: "no SKILL.md in team/half-built/",
        fixed: false,
      },
    ]);
  });

  test("dot-directories (.git, .github) are never candidate packages", async () => {
    storage = withIsolatedAkmStorage();
    const root = path.join(storage.root, "dotted-pack");

    write(root, "pdf-processing/SKILL.md", skillManifest("pdf-processing"));
    write(root, ".github/workflows/ci.yml", "name: ci\n");

    const diagnostics = await agentSkillsAdapter.validate(
      { id: "dotted", adapter: "agent-skills", root, writable: true },
      [{ path: "pdf-processing/SKILL.md", op: "update" }],
      createValidateContext({ root }),
    );

    expect(diagnostics.filter((d) => d.issue === "missing-skill-md")).toEqual([]);
  });
});

/**
 * `scripts/lint-lockfile.ts`: bun.lock must resolve every direct dependency of
 * package.json to the package and version package.json asks for. The stale
 * alias this repository carried (`onnxruntime-node` resolved to
 * `onnxruntime-web`) is the case it exists for.
 */

/** A bun.lock (JSONC: trailing commas) holding the given `name -> [identifier]` entries, with the dependencies given for some. */
function lockOf(entries: Record<string, string>, dependencies: Record<string, Record<string, string>> = {}): string {
  const packages = Object.entries(entries)
    .map(
      ([name, resolved]) =>
        `    ${JSON.stringify(name)}: [${JSON.stringify(resolved)}, "", ${JSON.stringify(dependencies[name] ? { dependencies: dependencies[name] } : {})}, "sha512-x"],`,
    )
    .join("\n");
  return `{\n  "lockfileVersion": 1,\n  "workspaces": { "": { "name": "akm-cli" } },\n  "packages": {\n${packages}\n  }\n}\n`;
}

describe("lintLockfile", () => {
  test("accepts a lock that resolves each dependency to its own package, inside the declared spec", () => {
    const pkg = {
      dependencies: { "onnxruntime-node": "1.24.3", "@huggingface/tokenizers": "0.1.3", citty: "^0.2.2" },
      optionalDependencies: { "sqlite-vec": "^0.1.9" },
      devDependencies: { typescript: "^5.9.3" },
    };
    const lock = lockOf({
      "onnxruntime-node": "onnxruntime-node@1.24.3",
      "@huggingface/tokenizers": "@huggingface/tokenizers@0.1.3",
      citty: "citty@0.2.4",
      "sqlite-vec": "sqlite-vec@0.1.9",
      typescript: "typescript@5.9.3",
    });

    expect(lintLockfile(pkg, lock)).toEqual([]);
  });

  test("rejects the stale alias: onnxruntime-node resolved to onnxruntime-web", () => {
    const pkg = { dependencies: { "onnxruntime-node": "1.24.3" } };
    const lock = lockOf({ "onnxruntime-node": "onnxruntime-web@1.24.3" });

    const problems = lintLockfile(pkg, lock);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"onnxruntime-node"');
    expect(problems[0]).toContain('"onnxruntime-web"');
    expect(problems[0]).toContain("bun update onnxruntime-node");
  });

  test("rejects the stale alias where it was: under @huggingface/transformers, which declares plain onnxruntime-node", () => {
    const pkg = { dependencies: { "@huggingface/transformers": "4.2.0" } };
    const lock = lockOf(
      { "@huggingface/transformers": "@huggingface/transformers@4.2.0", "onnxruntime-node": "onnxruntime-web@1.24.3" },
      { "@huggingface/transformers": { "onnxruntime-node": "1.24.3" } },
    );

    const problems = lintLockfile(pkg, lock);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"onnxruntime-web" (onnxruntime-web@1.24.3) as "onnxruntime-node"');
    expect(problems[0]).toContain("bun update onnxruntime-node");
  });

  test("accepts an npm: alias a dependency declares for its own dependency, at any depth", () => {
    const pkg = { dependencies: { "@isaacs/cliui": "^8.0.2" } };
    const lock = lockOf(
      {
        "@isaacs/cliui": "@isaacs/cliui@8.0.2",
        "string-width-cjs": "string-width@4.2.3",
        "string-width-cjs/strip-ansi": "strip-ansi@6.0.1",
        "@isaacs/cliui/@scope/wrap": "@scope/wrap@1.0.0",
      },
      { "@isaacs/cliui": { "string-width-cjs": "npm:string-width@^4.2.0" } },
    );

    expect(lintLockfile(pkg, lock)).toEqual([]);
  });

  test("an npm: alias in package.json must resolve to the package it names", () => {
    const pkg = {
      dependencies: { "ort-alias": "npm:onnxruntime-web@^1.24.0", "scoped-alias": "npm:@scope/real@2.0.0" },
    };

    expect(
      lintLockfile(pkg, lockOf({ "ort-alias": "onnxruntime-web@1.24.3", "scoped-alias": "@scope/real@2.0.0" })),
    ).toEqual([]);
    const problems = lintLockfile(
      pkg,
      lockOf({ "ort-alias": "onnxruntime-node@1.24.3", "scoped-alias": "@scope/real@2.0.0" }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"ort-alias"');
    expect(problems[0]).toContain('"onnxruntime-node"');
  });

  test("rejects a resolved version outside the declared range or pin, in any dependency field", () => {
    const pkg = {
      dependencies: { exact: "1.2.3", ranged: "^2.0.0" },
      optionalDependencies: { optional: "~1.1.0" },
      devDependencies: { dev: "^3.0.0" },
    };
    const lock = lockOf({
      exact: "exact@1.2.4",
      ranged: "ranged@2.9.0",
      optional: "optional@1.2.0",
      dev: "dev@3.0.0",
    });

    const problems = lintLockfile(pkg, lock);

    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('"exact" to 1.2.4');
    expect(problems[0]).toContain('"1.2.3"');
    expect(problems[1]).toContain('"optional" to 1.2.0');
    expect(problems[1]).toContain("optionalDependencies");
  });

  test("a dependency with no lock entry is reported", () => {
    const problems = lintLockfile({ dependencies: { missing: "^1.0.0" } }, lockOf({ other: "other@1.0.0" }));

    expect(problems).toEqual(['"missing" (dependencies) has no entry in bun.lock; run `bun install`.']);
  });

  test("specs that are not semver ranges are not judged for their version", () => {
    const pkg = {
      dependencies: {
        tagged: "latest",
        fromGit: "github:owner/repo#abc123",
        local: "workspace:*",
        prerelease: "^1.0.0-beta.1",
      },
    };
    const lock = lockOf({
      tagged: "tagged@9.9.9",
      fromGit: "fromGit@github:owner-repo-abc123",
      local: "local@workspace:packages/local",
      prerelease: "prerelease@1.0.0-beta.4",
    });

    expect(lintLockfile(pkg, lock)).toEqual([]);
  });
});

describe("lint-advisory-channel", () => {
  /**
   * The lint advisory channel and the workflow frontend pass behind it.
   *
   * Three properties, all about routing a NON-FATAL finding correctly:
   *   • `ADVISORY_LINT_ISSUES` is the single home for "never `flagged`", so no
   *     two routing points can disagree about a code and let a non-fatal hint
   *     fail `--fail-on-flagged` (exit 1) on one path only.
   *   • `workflowFrontendDiagnostics` is ONE parse+compile carrying both halves,
   *     so the sweep runs the frontend exactly once per workflow file — the
   *     property a pair of single-view helpers could only hold by accident, when
   *     their two call sites happened to sit next to each other.
   *   • the sweep files each finding by the classifier, never by which half of
   *     the pass produced it.
   */

  const REL = "workflows/advisory.md";
  const PARSE_PATH = "/stash/workflows/advisory.md";

  /**
   * Compiles cleanly, but declares `gate.max_loops: 2` on an `exec` step — one
   * advisory.
   *
   * Was previously "a step with no `output:` schema", the advisory #886 deleted
   * for firing on 100% of steps while guarding nothing. This file tests the
   * ROUTING machinery, not that particular warning, so it needs any document
   * that compiles clean and emits exactly one advisory. The gate/exec warning
   * qualifies and is a better fixture besides: it describes a real mistake, so
   * it will not be deleted out from under this suite the same way.
   */
  const WARNS = workflowDoc(
    ['    unit: { exec: { command: ["echo", "hi"] } }', "    gate: { max_loops: 2 }"],
    "## work\n\nDo it.\n\n### gate\n\nMust be green.\n",
  );
  /** Fails the schema-definition check — errors, and therefore no advisories. */
  const ERRORS = workflowDoc(["    output:", "      type: strig"]);

  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  /** A temp stash holding `files` under `workflows/`. */
  function makeWorkflowStash(files: Record<string, string>): string {
    const { dir, cleanup } = makeSandboxDir("akm-lint-advisory");
    cleanups.push(cleanup);
    const workflowsDir = path.join(dir, "workflows");
    fs.mkdirSync(workflowsDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(workflowsDir, name), content, "utf8");
    }
    return dir;
  }

  describe("advisory issue classification", () => {
    test("workflow-warning is advisory and ordinary findings are not", () => {
      expect(isAdvisoryLintIssue({ issue: "workflow-warning" })).toBe(true);
      for (const issue of ["invalid-workflow-structure", "placeholder-stub", "adapter-diagnostic", "broken-xref"]) {
        expect(isAdvisoryLintIssue({ issue })).toBe(false);
      }
    });

    test("every advisory code the frontend emits is registered", () => {
      const emitted = workflowFrontendDiagnostics(REL, WARNS, PARSE_PATH).warnings;
      expect(emitted.length).toBeGreaterThan(0);
      for (const diagnostic of emitted) {
        expect(ADVISORY_LINT_ISSUES.has(diagnostic.issue)).toBe(true);
      }
    });
  });

  describe("workflow frontend pass", () => {
    test("one pass carries both halves, and a compile warning never rides the error channel", () => {
      const pass = workflowFrontendDiagnostics(REL, WARNS, PARSE_PATH);
      expect(pass.errors).toEqual([]);
      expect(pass.warnings.map((d) => d.issue)).toEqual(["workflow-warning"]);
    });

    test("a document that fails to compile reports errors and no advisories", () => {
      const pass = workflowFrontendDiagnostics(REL, ERRORS, PARSE_PATH);
      expect(pass.errors.length).toBeGreaterThan(0);
      expect(pass.warnings).toEqual([]);
    });

    test("workflowStructureDiagnostics is the error half of the same pass", () => {
      expect(workflowStructureDiagnostics(REL, ERRORS, PARSE_PATH)).toEqual(
        workflowFrontendDiagnostics(REL, ERRORS, PARSE_PATH).errors,
      );
      expect(workflowStructureDiagnostics(REL, WARNS, PARSE_PATH)).toEqual([]);
    });

    test("each call answers for the arguments it was given", () => {
      // Two files whose findings must not be confused with each other, then the
      // same paths re-asked with different bytes (the shape a `--fix` rewrite
      // produces) — no answer may outlive the call it was computed for.
      expect(workflowFrontendDiagnostics("workflows/a.md", WARNS, "/stash/workflows/a.md").warnings[0]?.file).toBe(
        "workflows/a.md",
      );
      expect(workflowFrontendDiagnostics("workflows/a b.md", WARNS, "/stash/c.md").warnings[0]?.file).toBe(
        "workflows/a b.md",
      );
      expect(workflowFrontendDiagnostics(REL, ERRORS, PARSE_PATH).warnings).toEqual([]);
      expect(workflowFrontendDiagnostics(REL, WARNS, PARSE_PATH).warnings).toHaveLength(1);
    });
  });

  describe("akm lint sweep routing", () => {
    test("the workflow frontend runs exactly once per workflow file", async () => {
      const stashDir = makeWorkflowStash({
        "clean.md": WARNS,
        "broken.md": ERRORS,
        "also-clean.md": workflowDoc(["    output: { type: string }"]),
      });
      const parseSpy = spyOn(workflowParser, "parseWorkflow");

      await akmLint({ dir: stashDir, typeFilter: "workflows" });

      expect(parseSpy.mock.calls).toHaveLength(3);
      parseSpy.mockRestore();
    });

    test("every finding lands in the channel the classifier names", async () => {
      const stashDir = makeWorkflowStash({ "clean.md": WARNS, "broken.md": ERRORS });

      const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.flagged.length).toBeGreaterThan(0);
      for (const issue of result.warnings) expect(isAdvisoryLintIssue(issue)).toBe(true);
      for (const issue of result.flagged) expect(isAdvisoryLintIssue(issue)).toBe(false);
      expect(result.summary).toEqual({
        fixed: 0,
        flagged: result.flagged.length,
        warnings: result.warnings.length,
      });
    });
  });
});

{
  /**
   * `akm lint`'s non-akm adapter dispatch (`commands/lint/index.ts#lintViaAdapter`)
   * — GAP CLOSURE proof for llm-wiki.
   *
   * Before this change, `akm lint` special-cased exactly ONE non-akm adapter
   * (`okf`) and routed every other non-akm bundle — including llm-wiki —
   * through the AKM-shaped STASH_SUBDIRS sweep. A wiki root has no `knowledge/`,
   * `memories/`, etc. subdirs, so that sweep visited NOTHING: llm-wiki's own
   * four `validate()` checks (`uncited-raw` / `missing-description` /
   * `broken-xref` / `broken-source`, `core/adapter/adapters/llm-wiki-adapter.ts`)
   * were unreachable dead code from the CLI. `akm lint` now dispatches every
   * non-akm bundle through its OWN adapter's `validate()`
   * (`commands/lint/index.ts#lintViaAdapter`), closing that gap.
   *
   * This suite builds a fresh llm-wiki-shaped bundle at runtime (never touches
   * the shared conformance fixture at `tests/fixtures/bundles/llm-wiki/`, which
   * is deliberately clean) and drives it through the real `akm lint` CLI entry
   * point — not `llmWikiAdapter.validate()` directly (that surface already has
   * its own dedicated suite, `tests/core/adapter/llm-wiki-adapter.test.ts`).
   */

  function write(root: string, relPath: string, content: string): void {
    const full = path.join(root, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }

  describe("akm lint dispatches an llm-wiki bundle through llmWikiAdapter.validate()", () => {
    let storage: IsolatedAkmStorage;

    afterEach(() => storage?.cleanup());

    test("a dangling cross-reference trips broken-xref; an uncited raw source trips uncited-raw; a page with no description trips missing-description", async () => {
      storage = withIsolatedAkmStorage();
      const wikiRoot = path.join(storage.root, "my-wiki");

      write(wikiRoot, "schema.md", "# Wiki schema\n\nConventions live here.\n");
      write(wikiRoot, "index.md", "# Index\n");
      write(wikiRoot, "log.md", "# Log\n");
      // A raw ingested source that NO page cites — should trip `uncited-raw`.
      write(wikiRoot, "raw/2026-source.md", "# Raw source\n\nSome ingested material.\n");
      // A page with a description AND a cited source, but a body link to a page
      // that does not exist — should trip `broken-xref` (non-blocking).
      write(
        wikiRoot,
        "pages/http-caching.md",
        "---\ndescription: HTTP caching notes\n---\n\nSee [Varnish](varnish.md) for details.\n",
      );
      // A page missing a frontmatter `description` — should trip `missing-description`.
      write(wikiRoot, "pages/no-description.md", "# No description here\n\nJust body text.\n");

      // Sanity: the fixture really auto-detects as `llm-wiki` (a real, live
      // consumer of the same `looksLikeRoot` probe order `akm lint` uses) —
      // failing this would mean the dispatch never even runs.
      expect(detectAdapterId(wikiRoot)).toBe("llm-wiki");

      const result = await akmLint({ dir: wikiRoot });
      expect(result.ok).toBe(true);
      expect(result.fixed).toEqual([]); // validate() never writes — nothing is ever auto-fixed for a non-akm bundle

      const byIssue = (issue: string) => result.flagged.filter((f) => f.issue === issue);

      const brokenXref = byIssue("broken-xref");
      expect(brokenXref.length).toBeGreaterThan(0);
      expect(brokenXref.some((f) => f.file === "pages/http-caching.md" && f.detail.includes("varnish"))).toBe(true);

      const uncitedRaw = byIssue("uncited-raw");
      expect(uncitedRaw.length).toBeGreaterThan(0);
      expect(uncitedRaw.some((f) => f.file === "raw/2026-source.md")).toBe(true);

      const missingDescription = byIssue("missing-description");
      expect(missingDescription.some((f) => f.file === "pages/no-description.md")).toBe(true);

      // Every llm-wiki finding is non-blocking (`fixed: false` — the adapter
      // MUST NOT write; `core/adapter/bundle-adapter.ts`'s validate() contract).
      for (const issue of result.flagged) expect(issue.fixed).toBe(false);
    });

    test("a clean llm-wiki bundle lints with zero findings", async () => {
      storage = withIsolatedAkmStorage();
      const wikiRoot = path.join(storage.root, "clean-wiki");

      write(wikiRoot, "schema.md", "# Wiki schema\n");
      write(wikiRoot, "pages/topic.md", "---\ndescription: A well-formed page\n---\n\nNo dangling links here.\n");

      const result = await akmLint({ dir: wikiRoot });
      expect(result.ok).toBe(true);
      expect(result.flagged).toEqual([]);
      expect(result.fixed).toEqual([]);
    });
  });

  /**
   * `--type` names an AKM stash subdir. For a non-akm bundle the adapter's
   * `validate()` sees the whole bundle no matter what, so the flag is a silent
   * no-op — a user scoping a run got full-bundle output with nothing saying the
   * flag had not applied (issue #762). The refusal is deliberately a WARNING and
   * not an error: full-bundle validation is a superset of the requested scope, so
   * nothing goes unreported, and a hard error would break scripts passing one
   * `--type` across mixed-adapter bundle sets.
   */
  describe("akm lint warns that --type is a no-op for a non-akm adapter (issue #762)", () => {
    let storage: IsolatedAkmStorage;
    afterEach(() => storage?.cleanup());

    function wikiBundle(root: string): void {
      write(root, "schema.md", "# Wiki schema\n");
      write(root, "pages/topic.md", "---\ndescription: A well-formed page\n---\n\nBody.\n");
    }

    function captureWarnings(): string[] {
      const lines: string[] = [];
      overrideSeam(_setWarnSinkForTests, (_level, args) => {
        lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
      return lines;
    }

    test("the warning names the flag and the adapter, and the findings are unchanged", async () => {
      storage = withIsolatedAkmStorage();
      const wikiRoot = path.join(storage.root, "typed-wiki");
      wikiBundle(wikiRoot);

      const warnings = captureWarnings();
      const scoped = await akmLint({ dir: wikiRoot, typeFilter: "memories" });

      expect(warnings.some((line) => /--type "memories"/.test(line) && /llm-wiki/.test(line))).toBe(true);
      // The content contract from the issue: scoping changes nothing, it only
      // gains a signal. Compare against an unscoped run of the same bundle.
      const unscoped = await akmLint({ dir: wikiRoot });
      expect(scoped.flagged).toEqual(unscoped.flagged);
    });

    test("no warning is emitted when --type is absent", async () => {
      storage = withIsolatedAkmStorage();
      const wikiRoot = path.join(storage.root, "untyped-wiki");
      wikiBundle(wikiRoot);

      const warnings = captureWarnings();
      await akmLint({ dir: wikiRoot });

      expect(warnings.filter((line) => /--type/.test(line))).toEqual([]);
    });
  });
}

describe("lint-cache-path-anchoring", () => {
  /**
   * Regression coverage for the unanchored `/.cache/` / `/registry/` substring
   * check that used to gate lint's file-skip logic (`isCachedLintPath` in
   * `src/commands/lint/index.ts` and its two duplicates in
   * `src/core/adapter/adapters/akm-lint.ts`).
   *
   * That check tested whether the path STRING contained the literal text
   * `/.cache/` or `/registry/` anywhere at all — not whether the file actually
   * lived inside akm's own resolved registry-cache directories. Any bundle or
   * workspace that merely happened to sit under a directory named `.cache` (a
   * normal XDG `~/.cache/...` layout, many CI sandboxes) got zero workflow-lint
   * findings, silently.
   *
   * The fix (`isAkmRegistryCachePath` in `src/core/common.ts`) anchors the
   * exclusion to `getRegistryCacheDir()`/`getRegistryIndexCacheDir()` via
   * `isWithin` (realpath + containment), not a string search. These tests
   * pin both halves: a user path that merely CONTAINS `.cache`/`registry`
   * must lint normally, and a file genuinely inside the resolved registry
   * cache must still be skipped.
   */

  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  const BROKEN_WORKFLOW = ["---", "type: workflow", "description: Broken", "---", ""].join("\n");

  function writeWorkflowFile(stashDir: string, name: string, content: string): string {
    const filePath = path.join(stashDir, "workflows", name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
    return filePath;
  }

  describe("lint cache-path anchoring (issue: unanchored /.cache/ /registry/ substring)", () => {
    test("a stash rooted under a path merely CONTAINING '.cache' still gets workflow-lint findings", async () => {
      const { dir: base, cleanup } = makeSandboxDir("akm-lint-cachepath");
      cleanups.push(cleanup);
      // Nest the real stash root under a directory literally named `.cache`,
      // regardless of where the process TMPDIR points — this reproduces the
      // "XDG_CACHE_HOME-style path" shape the audit flagged, independent of
      // the test runner's own TMPDIR.
      const stashDir = path.join(base, "nested", ".cache", "my-project");
      fs.mkdirSync(stashDir, { recursive: true });

      writeWorkflowFile(stashDir, "broken.md", BROKEN_WORKFLOW);

      const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });

      const structural = result.flagged.filter((i) => i.issue === "invalid-workflow-structure");
      expect(structural).toHaveLength(1);
      expect(structural[0]?.file).toContain("broken.md");
    });

    test("a stash rooted under a path merely CONTAINING 'registry' still gets workflow-lint findings", async () => {
      const { dir: base, cleanup } = makeSandboxDir("akm-lint-registrypath");
      cleanups.push(cleanup);
      const stashDir = path.join(base, "registry", "my-project");
      fs.mkdirSync(stashDir, { recursive: true });

      writeWorkflowFile(stashDir, "broken.md", BROKEN_WORKFLOW);

      const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });

      const structural = result.flagged.filter((i) => i.issue === "invalid-workflow-structure");
      expect(structural).toHaveLength(1);
      expect(structural[0]?.file).toContain("broken.md");
    });

    test("a file genuinely inside the resolved registry cache dir is still skipped by workflowFrontendDiagnostics", () => {
      const { dir: cacheDir, cleanup } = sandboxEnvDir("akm-real-cache-", "XDG_CACHE_HOME");
      cleanups.push(cleanup);

      const registryFile = path.join(cacheDir, "akm", "registry", "git-some-source", "workflows", "broken.md");
      fs.mkdirSync(path.dirname(registryFile), { recursive: true });
      fs.writeFileSync(registryFile, BROKEN_WORKFLOW, "utf8");

      const result = workflowFrontendDiagnostics("workflows/broken.md", BROKEN_WORKFLOW, registryFile);

      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    test("a file genuinely inside the resolved registry-index cache dir is still skipped", () => {
      const { dir: cacheDir, cleanup } = sandboxEnvDir("akm-real-cache-idx-", "XDG_CACHE_HOME");
      cleanups.push(cleanup);

      const registryIndexFile = path.join(cacheDir, "akm", "registry-index", "git-abc123", "workflows", "broken.md");
      fs.mkdirSync(path.dirname(registryIndexFile), { recursive: true });
      fs.writeFileSync(registryIndexFile, BROKEN_WORKFLOW, "utf8");

      const result = workflowFrontendDiagnostics("workflows/broken.md", BROKEN_WORKFLOW, registryIndexFile);

      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    test("a real path under the OS temp dir's own '.cache'-shaped TMPDIR still lints (sanity, mirrors os.tmpdir())", async () => {
      // Belt-and-suspenders: exercise the actual os.tmpdir()-derived sandbox
      // helper too, not just a hand-built path, so this fails the same way the
      // full `bun test ... TMPDIR=.../.cache/...` repro from the audit does.
      const tmpBase = os.tmpdir();
      if (!tmpBase.includes(".cache")) return; // only meaningful when run under a .cache-shaped TMPDIR
      const { dir: stashDir, cleanup } = makeSandboxDir("akm-lint-realtmp");
      cleanups.push(cleanup);
      writeWorkflowFile(stashDir, "broken.md", BROKEN_WORKFLOW);

      const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });

      const structural = result.flagged.filter((i) => i.issue === "invalid-workflow-structure");
      expect(structural).toHaveLength(1);
    });

    test("a USER workflow subdirectory literally named '.cache' still gets lint findings (collectWorkflowFiles name-based exclusion)", async () => {
      // Regression for the two remaining name-based exclusions
      // (`entry.name === ".cache" || entry.name === "registry"`) in
      // `collectWorkflowFiles` — distinct from the substring bug above.
      // These skipped ANY directory named `.cache`/`registry` ANYWHERE in a
      // bundle, including ordinary user content nested under such a name, not
      // just akm's own resolved cache. `workflows/.cache/` here is user
      // content, never akm's real cache dir.
      const { dir: stashDir, cleanup } = makeSandboxDir("akm-lint-user-dotcache-dir");
      cleanups.push(cleanup);
      writeWorkflowFile(stashDir, path.join(".cache", "broken.md"), BROKEN_WORKFLOW);

      const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });

      const structural = result.flagged.filter((i) => i.issue === "invalid-workflow-structure");
      expect(structural).toHaveLength(1);
      expect(structural[0]?.file).toContain(path.join(".cache", "broken.md"));
    });

    test("a USER 'raw/' source nested under a directory literally named 'registry' still trips uncited-raw (collectAdapterFiles name-based exclusion)", async () => {
      // Regression for the `segments.includes(".cache") || segments.includes("registry")`
      // exclusion in `collectAdapterFiles`, used for every non-akm adapter's
      // whole-bundle walk (llm-wiki here). A user directory literally named
      // `registry` anywhere under the bundle root — not akm's own resolved
      // registry cache — must still be linted.
      const { dir: base, cleanup } = makeSandboxDir("akm-lint-user-registry-dir");
      cleanups.push(cleanup);
      const wikiRoot = path.join(base, "my-wiki");
      fs.mkdirSync(path.join(wikiRoot, "raw", "registry"), { recursive: true });
      fs.mkdirSync(path.join(wikiRoot, "pages"), { recursive: true });
      fs.writeFileSync(path.join(wikiRoot, "schema.md"), "# Wiki schema\n\nConventions live here.\n", "utf8");
      fs.writeFileSync(path.join(wikiRoot, "index.md"), "# Index\n", "utf8");
      fs.writeFileSync(path.join(wikiRoot, "log.md"), "# Log\n", "utf8");
      // Never cited by any page's `sources:` — should trip `uncited-raw`, but
      // only if the file was actually visited despite the `registry` segment.
      fs.writeFileSync(
        path.join(wikiRoot, "raw", "registry", "orphan.md"),
        "# Orphan source\n\nSome ingested material nobody cites.\n",
        "utf8",
      );

      expect(detectAdapterId(wikiRoot)).toBe("llm-wiki");

      const result = await akmLint({ dir: wikiRoot });
      const uncitedRaw = result.flagged.filter((f) => f.issue === "uncited-raw");
      expect(uncitedRaw.some((f) => f.file.includes(path.join("raw", "registry", "orphan.md")))).toBe(true);
    });
  });
});

/**
 * #884 — `akm lint --prune-dangling-edges`, the OPT-IN half of the fix.
 *
 * Resolving prune tombstones (see `lint-archived-memory-belief-edge.test.ts`)
 * stops NEW dangling edges appearing, but cannot help an edge whose target was
 * removed outside the prune path — a hand `git rm`, or a pre-fix release. That
 * is the shape of the 224 findings #884 reported, and clearing them deletes
 * user assertions, so it never happens implicitly: not on a bare `akm lint`,
 * and not on `--fix`.
 */

function writeMemory(stashDir: string, slug: string, frontmatter: string): void {
  fs.writeFileSync(path.join(stashDir, "memories", `${slug}.md`), `---\n${frontmatter}---\n\nBody.\n`);
}

function read(stashDir: string, slug: string): string {
  return fs.readFileSync(path.join(stashDir, "memories", `${slug}.md`), "utf8");
}

describe("akm lint --prune-dangling-edges (#884)", () => {
  let storage: IsolatedAkmStorage;
  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    resetMemoryArchiveCache();
  });
  afterEach(() => {
    resetMemoryArchiveCache();
    storage.cleanup();
  });

  test("a plain lint reports the dangling edge and changes nothing on disk", async () => {
    const stashDir = storage.stashDir;
    writeMemory(stashDir, "holder", "description: h\ncontradictedBy:\n  - memories/gone\n");
    const before = read(stashDir, "holder");

    const result = await akmLint({ dir: stashDir, config: makeConfig(stashDir) });

    expect(result.flagged.filter((f) => f.issue === "missing-ref").length).toBe(1);
    expect(read(stashDir, "holder")).toBe(before);
  });

  test("--fix alone does NOT drop the edge — the repair is not folded into it", async () => {
    const stashDir = storage.stashDir;
    writeMemory(stashDir, "holder", "description: h\ncontradictedBy:\n  - memories/gone\n");

    const result = await akmLint({ dir: stashDir, fix: true, config: makeConfig(stashDir) });

    expect(result.flagged.filter((f) => f.issue === "missing-ref").length).toBe(1);
    expect(read(stashDir, "holder")).toContain("memories/gone");
  });

  test("the flag drops the dangling edge and removes the now-empty key", async () => {
    const stashDir = storage.stashDir;
    writeMemory(stashDir, "holder", "description: h\ncontradictedBy:\n  - memories/gone\n");

    const result = await akmLint({ dir: stashDir, pruneDanglingEdges: true, config: makeConfig(stashDir) });

    expect(result.flagged.filter((f) => f.issue === "missing-ref")).toEqual([]);
    expect(result.fixed.some((f) => f.detail.includes("dangling contradictedBy edge dropped"))).toBe(true);
    const after = read(stashDir, "holder");
    expect(after).not.toContain("memories/gone");
    expect(after).not.toContain("contradictedBy");
    expect(after).toContain("description: h");
    expect(after).toContain("Body.");
  });

  test("a surviving edge in the same list is preserved", async () => {
    const stashDir = storage.stashDir;
    writeMemory(stashDir, "live", "description: real target\n");
    writeMemory(stashDir, "holder", "description: h\ncontradictedBy:\n  - memories/gone\n  - memories/live\n");

    await akmLint({ dir: stashDir, pruneDanglingEdges: true, config: makeConfig(stashDir) });

    const after = read(stashDir, "holder");
    expect(after).not.toContain("memories/gone");
    expect(after).toContain("memories/live");
    expect(after).toContain("contradictedBy:");
  });

  test("inline-flow and scalar spellings are both repaired", async () => {
    const stashDir = storage.stashDir;
    writeMemory(stashDir, "live", "description: real target\n");
    writeMemory(stashDir, "flow", "description: h\ncontradictedBy: [memories/gone, memories/live]\n");
    writeMemory(stashDir, "scalar", "description: h\nsupersededBy: memories/gone\n");

    await akmLint({ dir: stashDir, pruneDanglingEdges: true, config: makeConfig(stashDir) });

    expect(read(stashDir, "flow")).toContain("contradictedBy: [memories/live]");
    expect(read(stashDir, "scalar")).not.toContain("supersededBy");
  });

  test("xrefs are NOT repaired — only the belief channels are in scope", async () => {
    const stashDir = storage.stashDir;
    writeMemory(stashDir, "holder", "description: h\nxrefs:\n  - memories/gone\n");

    const result = await akmLint({ dir: stashDir, pruneDanglingEdges: true, config: makeConfig(stashDir) });

    expect(result.flagged.filter((f) => f.issue === "missing-ref").length).toBe(1);
    expect(read(stashDir, "holder")).toContain("memories/gone");
  });

  test("an edge to an ARCHIVED memory is never dropped — it resolves, so it is not dangling", async () => {
    const stashDir = storage.stashDir;
    // A tombstone written in the prune path's layout.
    const archiveDir = path.join(stashDir, ".akm", "memory-cleanup", "archive", "2026-01-01-memory-pruned");
    fs.mkdirSync(path.join(archiveDir, "memories"), { recursive: true });
    fs.writeFileSync(path.join(archiveDir, "memories", "pruned.md"), "---\ndescription: archived\n---\n\nBody.\n");
    fs.writeFileSync(
      path.join(archiveDir, "cleanup.md"),
      "---\nkind: memory-cleanup-archive\nref: memory:pruned\noriginalPath: memories/pruned.md\n---\n\nArchived.\n",
    );
    writeMemory(stashDir, "holder", "description: h\ncontradictedBy:\n  - memories/pruned\n");
    resetMemoryArchiveCache();

    const result = await akmLint({ dir: stashDir, pruneDanglingEdges: true, config: makeConfig(stashDir) });

    expect(result.flagged.filter((f) => f.issue === "missing-ref")).toEqual([]);
    expect(read(stashDir, "holder")).toContain("memories/pruned");
  });

  test("comments and unrelated keys survive the rewrite", async () => {
    const stashDir = storage.stashDir;
    fs.writeFileSync(
      path.join(stashDir, "memories", "holder.md"),
      "---\n# a comment\ndescription: h\ntags:\n  - one\ncontradictedBy:\n  - memories/gone\nupdated: 2026-01-01\n---\n\nBody.\n",
    );

    await akmLint({ dir: stashDir, pruneDanglingEdges: true, config: makeConfig(stashDir) });

    const after = read(stashDir, "holder");
    expect(after).toContain("# a comment");
    expect(after).toContain("tags:");
    expect(after).toContain("  - one");
    expect(after).toContain("updated: 2026-01-01");
    expect(after).not.toContain("contradictedBy");
  });
});

{
  /**
   * #884 — pruning a memory left every inbound belief edge dangling.
   *
   * `analyzeMemoryCleanup`/`applyMemoryCleanup` ARCHIVE a pruned memory (rename
   * under `.akm/memory-cleanup/archive` + a `cleanup.md` audit record) rather
   * than deleting it, but ref resolution only ever looked at the memory's
   * ORIGINAL location. Once #882 made `contradictedBy`/`supersededBy`
   * validatable, every memory pointing at a pruned one started reporting
   * `missing-ref`.
   *
   * The fix resolves the archive tombstone. These tests drive the REAL prune
   * producer (not a hand-built archive fixture) so the tombstone contract is
   * pinned end-to-end: if `archiveMemory` ever changes its layout or drops
   * `originalPath`, the first test fails rather than silently regressing to
   * "everything is missing".
   */

  function writeMemory(stashDir: string, slug: string, frontmatter: string, body = "Body.\n"): void {
    fs.writeFileSync(path.join(stashDir, "memories", `${slug}.md`), `---\n${frontmatter}---\n\n${body}`);
  }

  /**
   * A parent plus two byte-identical derived children — the `duplicate-derived`
   * shape `analyzeMemoryCleanup` prunes. Returns the ref that gets archived.
   */
  function seedPrunableDuplicate(stashDir: string): string {
    writeMemory(stashDir, "deploy", "description: parent memory\n");
    const derived =
      "inferred: true\n" +
      "source: memories/deploy\n" +
      "title: Check VPN before deploy\n" +
      "description: VPN is required before deploys.\n";
    const body = "# Check VPN before deploy\n\nEnable VPN before starting the release.\n";
    writeMemory(stashDir, "deploy.derived", derived, body);
    writeMemory(stashDir, "deploy-duplicate.derived", derived, body);
    return "memories/deploy-duplicate.derived";
  }

  /** Run the real prune. Returns the stash-relative original paths that were archived. */
  function prune(stashDir: string): string[] {
    const applied = applyMemoryCleanup(stashDir, analyzeMemoryCleanup(stashDir));
    resetMemoryArchiveCache(); // the sweep below must see the archive this call just wrote
    return applied.archived.map((record) => record.originalPath);
  }

  describe("belief edges to a pruned memory resolve through the archive tombstone (#884)", () => {
    let storage: IsolatedAkmStorage;
    beforeEach(() => {
      storage = withIsolatedAkmStorage();
      resetMemoryArchiveCache();
    });
    afterEach(() => {
      resetMemoryArchiveCache();
      storage.cleanup();
    });

    test("a contradictedBy edge to a pruned memory is not reported as missing-ref", async () => {
      const stashDir = storage.stashDir;
      const prunedRef = seedPrunableDuplicate(stashDir);
      writeMemory(stashDir, "holder", `description: holds the edge\ncontradictedBy:\n  - ${prunedRef}\n`);

      // Precondition: the edge resolves while the target is still live, so a
      // pass here can never be "the ref was unresolvable-shaped all along".
      const before = await akmLint({ dir: stashDir, config: makeConfig(stashDir) });
      expect(before.flagged.filter((f) => f.issue === "missing-ref")).toEqual([]);

      expect(prune(stashDir)).toEqual(["memories/deploy-duplicate.derived.md"]);
      expect(fs.existsSync(path.join(stashDir, "memories", "deploy-duplicate.derived.md"))).toBe(false);

      const after = await akmLint({ dir: stashDir, config: makeConfig(stashDir) });
      expect(after.flagged.filter((f) => f.issue === "missing-ref")).toEqual([]);
    });

    test("the legacy type:slug spelling of the same edge also resolves", async () => {
      const stashDir = storage.stashDir;
      seedPrunableDuplicate(stashDir);
      writeMemory(
        stashDir,
        "holder",
        "description: holds the edge\ncontradictedBy:\n  - memory:deploy-duplicate.derived\n",
      );

      expect(prune(stashDir)).toEqual(["memories/deploy-duplicate.derived.md"]);

      const after = await akmLint({ dir: stashDir, config: makeConfig(stashDir) });
      expect(after.flagged.filter((f) => f.issue === "missing-ref")).toEqual([]);
    });

    test("a supersededBy edge to a pruned memory resolves on the same channel", async () => {
      const stashDir = storage.stashDir;
      const prunedRef = seedPrunableDuplicate(stashDir);
      writeMemory(stashDir, "holder", `description: holds the edge\nsupersededBy:\n  - ${prunedRef}\n`);

      expect(prune(stashDir)).toEqual(["memories/deploy-duplicate.derived.md"]);

      const after = await akmLint({ dir: stashDir, config: makeConfig(stashDir) });
      expect(after.flagged.filter((f) => f.issue === "missing-ref")).toEqual([]);
    });

    test("an edge to a memory that was never archived is STILL reported (no blanket suppression)", async () => {
      const stashDir = storage.stashDir;
      seedPrunableDuplicate(stashDir);
      // The #884 stash's real shape: the target was removed by a hand `git rm`,
      // so there is no tombstone and the edge is genuinely dangling.
      writeMemory(stashDir, "holder", "description: holds the edge\ncontradictedBy:\n  - memories/never-existed\n");

      prune(stashDir);

      const after = await akmLint({ dir: stashDir, config: makeConfig(stashDir) });
      const missing = after.flagged.filter((f) => f.issue === "missing-ref");
      expect(missing.length).toBe(1);
      expect(missing[0]?.detail).toContain("memories/never-existed");
    });

    test("a tombstone never shadows a live file of the same name", async () => {
      const stashDir = storage.stashDir;
      seedPrunableDuplicate(stashDir);
      writeMemory(
        stashDir,
        "holder",
        "description: holds the edge\ncontradictedBy:\n  - memories/deploy-duplicate.derived\n",
      );
      prune(stashDir);

      // Re-create the memory at its original path. Resolution must prefer the
      // live file; the stale tombstone must not make a later real deletion
      // invisible either, so re-deleting still resolves (via the tombstone).
      writeMemory(stashDir, "deploy-duplicate.derived", "description: back again\n");
      resetMemoryArchiveCache();
      const after = await akmLint({ dir: stashDir, config: makeConfig(stashDir) });
      expect(after.flagged.filter((f) => f.issue === "missing-ref")).toEqual([]);
    });

    test("a corrupt audit record degrades to missing-ref rather than throwing", async () => {
      const stashDir = storage.stashDir;
      const prunedRef = seedPrunableDuplicate(stashDir);
      writeMemory(stashDir, "holder", `description: holds the edge\ncontradictedBy:\n  - ${prunedRef}\n`);
      prune(stashDir);

      const archiveRoot = path.join(stashDir, ".akm", "memory-cleanup", "archive");
      for (const dir of fs.readdirSync(archiveRoot)) {
        fs.writeFileSync(path.join(archiveRoot, dir, "cleanup.md"), "not: [valid\nfrontmatter\n");
      }
      resetMemoryArchiveCache();

      const after = await akmLint({ dir: stashDir, config: makeConfig(stashDir) });
      expect(after.flagged.filter((f) => f.issue === "missing-ref").length).toBe(1);
    });
  });

  /**
   * alpha.9: the consolidate pair pass retires assets through a GENERALIZED
   * `archiveCleanupCandidate` — any memory, knowledge or lesson file, not only
   * `.derived` memories. This is the same #884 ref-resolution guarantee, but
   * for a producer this file's own tests never drive: `akm proposal accept`
   * on a `retire` proposal targeting a plain KNOWLEDGE asset (no `.derived`
   * shape at all).
   */
  describe("a retire proposal's archived KNOWLEDGE asset also resolves through the tombstone (alpha.9)", () => {
    let storage: IsolatedAkmStorage;
    beforeEach(() => {
      storage = withIsolatedAkmStorage();
      resetMemoryArchiveCache();
    });
    afterEach(() => {
      resetMemoryArchiveCache();
      storage.cleanup();
    });

    test("an xrefs edge to a retired knowledge asset is not reported as missing-ref", async () => {
      const stashDir = storage.stashDir;
      fs.mkdirSync(path.join(stashDir, "knowledge"), { recursive: true });
      const oldGuideContent = "---\ndescription: an older guide, superseded by a newer one\n---\n\nOld content.\n";
      fs.writeFileSync(path.join(stashDir, "knowledge", "old-guide.md"), oldGuideContent);
      const newGuideContent = "---\ndescription: the newer guide\n---\n\nNew content.\n";
      fs.writeFileSync(path.join(stashDir, "knowledge", "new-guide.md"), newGuideContent);
      writeMemory(stashDir, "holder", "description: holds the edge\nxrefs:\n  - knowledge/old-guide\n");

      const before = await akmLint({ dir: stashDir, config: makeConfig(stashDir) });
      expect(before.flagged.filter((f) => f.issue === "missing-ref")).toEqual([]);

      const config = makeConfig(stashDir);
      // B2 (post-review): accept verifies both sides' recorded body hashes
      // against the current files, so the fixture uses the REAL hashes of the
      // files actually on disk rather than placeholder bytes.
      const proposal = createRetireProposal(stashDir, {
        ref: "knowledge/old-guide",
        source: "consolidate-pair",
        target: { source: "stash", root: stashDir },
        retirement: {
          retiredRef: "knowledge/old-guide",
          successorRef: "knowledge/new-guide",
          cosine: 0.96,
          judgeLabel: "duplicate",
          judgeReason: "Same durable facts as the newer guide.",
          judgedScope: {},
          retiredContentHash: contentHash(oldGuideContent, "body"),
          successorContentHash: contentHash(newGuideContent, "body"),
          reason: "duplicate",
        },
      });
      await akmProposalAccept({ stashDir, id: proposal.id, config });
      resetMemoryArchiveCache(); // the lint sweep below must see the archive accept just wrote

      expect(fs.existsSync(path.join(stashDir, "knowledge", "old-guide.md"))).toBe(false);

      const after = await akmLint({ dir: stashDir, config: makeConfig(stashDir) });
      expect(after.flagged.filter((f) => f.issue === "missing-ref")).toEqual([]);
    });
  });
}

/**
 * `akm lint` no longer reports a clean scan for a task file that cannot run
 * (issue #760).
 *
 * Two blind spots, one root cause — every task reader collapsed a YAML parse
 * failure onto `{}`, and every task rule short-circuits on an empty mapping:
 *
 *   1. A `tasks/*.yml` whose YAML does not parse (bad indentation, an
 *      unterminated quote, tab characters) produced `flagged: 0`.
 *   2. A `tasks/*.yaml` file — the near-miss spelling akm never indexes and
 *      never schedules — was not even collected by the directory walk, so it
 *      was invisible rather than flagged.
 *
 * All THREE task-lint surfaces are pinned here, because the bug was present in
 * each and they must agree: the CLI sweep (`commands/lint/index.ts`), the
 * `akm` adapter's `validate` (the proposal-preflight surface), and the
 * dedicated `akm-task` format adapter.
 */

/**
 * Genuinely unparseable YAML: an unterminated single quote plus a tab-indented
 * continuation. `yaml`'s parser throws on this — it is not merely a document
 * that parses to a non-mapping.
 */
const MALFORMED_TASK = "version: 4\nrun: 'echo hi\nname:\n\tbroken: '@daily'\n";

const VALID_TASK = "version: 4\nrun: echo hi\n";

function writeTask(stashDir: string, relPath: string, content: string): string {
  const full = path.join(stashDir, "tasks", relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
  return full;
}

function component(root: string, adapter: string): BundleComponent {
  return { id: "fixture", adapter, root, writable: true };
}

describe("akm lint — malformed task YAML (issue #760)", () => {
  let storage: IsolatedAkmStorage;
  afterEach(() => storage?.cleanup());

  test("a tasks/*.yml that does not parse is flagged, not reported clean", async () => {
    storage = withIsolatedAkmStorage();
    writeTask(storage.stashDir, "broken.yml", MALFORMED_TASK);

    const result = await akmLint({ dir: storage.stashDir, config: makeConfig(storage.stashDir) });

    expect(result.summary.flagged).toBeGreaterThan(0);
    const parseFindings = result.flagged.filter(
      (issue) => issue.issue === "invalid-task-yaml" && issue.file.endsWith("broken.yml"),
    );
    expect(parseFindings.length).toBe(1);
    expect(parseFindings[0]?.detail).toMatch(/invalid|YAML|parse/i);
  });

  test("a well-formed task still lints clean — the new check is not a blanket flag", async () => {
    storage = withIsolatedAkmStorage();
    writeTask(storage.stashDir, "nightly.yml", VALID_TASK);

    const result = await akmLint({ dir: storage.stashDir, config: makeConfig(storage.stashDir) });

    expect(result.flagged.filter((issue) => issue.issue === "invalid-task-yaml")).toEqual([]);
  });

  test("a v2 task is flagged naming `akm migrate apply` (the runtime reads only v4)", async () => {
    // Lint agrees with the runtime: `akm task run`/`sync` refuse a v2/v3
    // source, so lint reports it with the command that converts it.
    storage = withIsolatedAkmStorage();
    writeTask(storage.stashDir, "legacy.yml", "version: 2\nschedule: '@daily'\nprompt: hello\n");

    const result = await akmLint({ dir: storage.stashDir, config: makeConfig(storage.stashDir) });

    const findings = result.flagged.filter((issue) => issue.file.endsWith("legacy.yml"));
    expect(findings.map((issue) => issue.issue)).toEqual(["invalid-task-yaml"]);
    expect(findings[0]?.detail).toContain("akm migrate apply");
  });

  test("a cron the local scheduler backend cannot parse is flagged (what `akm task sync` would refuse)", async () => {
    storage = withIsolatedAkmStorage();
    // 4 fields: the v4 grammar accepts any nonempty string, the backend wants 5.
    writeTask(storage.stashDir, "bad-cron.yml", "version: 4\nrun: echo hi\nschedule: '99 * * *'\n");

    const result = await akmLint({ dir: storage.stashDir, config: makeConfig(storage.stashDir), typeFilter: "tasks" });

    const findings = result.flagged.filter((issue) => issue.file.endsWith("bad-cron.yml"));
    expect(findings.map((issue) => issue.issue)).toEqual(["invalid-task-yaml"]);
    expect(findings[0]?.detail).toContain("expected 5 fields");
  });

  test("a schedule entry that leaves a required input unsatisfied is flagged", async () => {
    storage = withIsolatedAkmStorage();
    writeTask(
      storage.stashDir,
      "bad-schedule-input.yml",
      "version: 4\nrun: echo hi\ninputs:\n  ticket:\n    type: string\n    required: true\nschedule:\n  - cron: '0 8 * * 1'\n",
    );

    const result = await akmLint({ dir: storage.stashDir, config: makeConfig(storage.stashDir), typeFilter: "tasks" });

    const findings = result.flagged.filter((issue) => issue.file.endsWith("bad-schedule-input.yml"));
    expect(findings.map((issue) => issue.issue)).toEqual(["invalid-task-yaml"]);
    expect(findings[0]?.detail).toContain("declared inputs");
  });

  test("a tasks/*.yaml file is flagged for its extension instead of being skipped", async () => {
    storage = withIsolatedAkmStorage();
    // Content is VALID — the finding must come from the extension alone, so the
    // near-miss cannot hide behind "well, it was broken anyway".
    writeTask(storage.stashDir, "misnamed.yaml", VALID_TASK);

    const result = await akmLint({ dir: storage.stashDir, config: makeConfig(storage.stashDir) });

    const findings = result.flagged.filter((issue) => issue.file.endsWith("misnamed.yaml"));
    expect(findings.map((issue) => issue.issue)).toEqual(["invalid-task-yaml"]);
    expect(findings[0]?.detail).toMatch(/\.yaml/);
    expect(findings[0]?.detail).toMatch(/never indexed or scheduled/);
  });

  test("a malformed tasks/*.yaml reports BOTH the extension and the parse failure", async () => {
    storage = withIsolatedAkmStorage();
    writeTask(storage.stashDir, "double-trouble.yaml", MALFORMED_TASK);

    const result = await akmLint({ dir: storage.stashDir, config: makeConfig(storage.stashDir) });

    const details = result.flagged
      .filter((issue) => issue.file.endsWith("double-trouble.yaml"))
      .map((issue) => issue.detail);
    expect(details.some((d) => /invalid|YAML|parse/i.test(d))).toBe(true);
    expect(details.some((d) => /\.yaml extension/.test(d))).toBe(true);
  });
});

describe("akm adapter validate() — malformed task YAML (issue #760)", () => {
  let storage: IsolatedAkmStorage;
  afterEach(() => storage?.cleanup());

  test("reports the parse failure the CLI sweep reports, so the two surfaces agree", async () => {
    storage = withIsolatedAkmStorage();
    writeTask(storage.stashDir, "broken.yml", MALFORMED_TASK);

    const diagnostics = await akmAdapter.validate(
      component(storage.stashDir, "akm"),
      [{ path: "tasks/broken.yml", op: "update" }],
      createValidateContext({ root: storage.stashDir }),
    );

    expect(diagnostics.filter((d) => d.issue === "invalid-task-yaml").length).toBeGreaterThan(0);
  });
});

describe("akm-task adapter validate() — malformed task YAML (issue #760)", () => {
  let storage: IsolatedAkmStorage;
  afterEach(() => storage?.cleanup());

  test("a malformed .yml is invalid-task-yaml, not silence", async () => {
    storage = withIsolatedAkmStorage();
    const root = path.join(storage.root, "task-bundle");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "broken.yml"), MALFORMED_TASK, "utf8");

    const diagnostics = await akmTaskAdapter.validate(
      component(root, "akm-task"),
      [{ path: "broken.yml", op: "update" }],
      createValidateContext({ root }),
    );

    expect(diagnostics.map((d) => d.issue)).toEqual(["invalid-task-yaml"]);
    expect(diagnostics[0]?.detail).toMatch(/invalid|YAML|parse/i);
  });

  test("a .yaml task file reaches validate() and is flagged for the extension", async () => {
    storage = withIsolatedAkmStorage();
    const root = path.join(storage.root, "task-bundle");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "misnamed.yaml"), VALID_TASK, "utf8");

    const diagnostics = await akmTaskAdapter.validate(
      component(root, "akm-task"),
      [{ path: "misnamed.yaml", op: "update" }],
      createValidateContext({ root }),
    );

    expect(diagnostics.map((d) => d.issue)).toEqual(["invalid-task-yaml"]);
    expect(diagnostics[0]?.detail).toMatch(/\.yaml/);
  });

  test("`akm lint` on an akm-task bundle collects the .yaml near miss end to end", async () => {
    storage = withIsolatedAkmStorage();
    const root = path.join(storage.root, "task-bundle");
    fs.mkdirSync(root, { recursive: true });
    // A conformant `.yml` task makes the root detect as `akm-task`.
    fs.writeFileSync(path.join(root, "nightly.yml"), VALID_TASK, "utf8");
    fs.writeFileSync(path.join(root, "misnamed.yaml"), VALID_TASK, "utf8");

    const result = await akmLint({ dir: root, config: makeConfig(storage.stashDir) });

    const findings = result.flagged.filter((issue) => issue.file.endsWith("misnamed.yaml"));
    expect(findings.map((issue) => issue.issue)).toEqual(["invalid-task-yaml"]);
  });
});
