import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { main } from "../../src/cli";
import { GLOBAL_OUTPUT_ARGS } from "../../src/cli/shared";
import { VALID_ADAPTER_IDS } from "../../src/core/adapter/adapter-ids";
import { ConfigError, NotFoundError, UsageError } from "../../src/core/errors";
import { formatExemptSurfaces } from "../../src/output/format-exempt";
import { runCliCapture } from "../_helpers/cli";
import { makeSandboxDir, makeStashDir, type SandboxedDir, withEnv } from "../_helpers/sandbox";

// Helpers.
//
// Migrated from per-test spawnSync("bun", ["src/cli.ts", ...]) to the shared
// in-process harness (tests/_helpers/cli.ts). The harness drives the akm citty
// command directly, so there is no subprocess startup cost. Output and exit
// codes are captured in-process.
//
// The preload (tests/_preload.ts) already sandboxes HOME, the XDG dirs, and the
// AKM dir overrides per test, so the explicit isolated dirs the spawn version
// passed via env are no longer needed for isolation. Env/temp-dir mutation goes
// through the allowlisted sandbox helpers (withEnv / makeStashDir /
// makeSandboxDir) to satisfy the test-isolation lint.
//
// The one case that needs to run from a project working directory (registry
// remove) still spawns a real subprocess: it asserts project-vs-user config
// layering driven by process.cwd(), and changing cwd in-process to a temp dir
// breaks Bun's bare-specifier module resolver for the CLI's lazy dynamic
// imports. That is a genuine process-level behavior, so it stays a subprocess.

const disposers: SandboxedDir[] = [];

afterAll(() => {
  for (const d of disposers) d.cleanup();
  disposers.length = 0;
});

const repoRoot = path.resolve(import.meta.dir, "..", "..");

async function runCli(...args: string[]): Promise<{ stdout: string; stderr: string; status: number }> {
  const { stdout, stderr, code } = await runCliCapture(args);
  return { stdout, stderr, status: code };
}

/**
 * Subprocess runner, retained only for the one cwd-sensitive test. Spawning a
 * fresh Bun process is the correct way to exercise project-directory config
 * resolution (the subprocess resolves modules from the repo regardless of cwd).
 * It passes env to spawnSync rather than mutating process.env, so it does not
 * affect the in-process tests.
 */
function spawnCli(
  args: string[],
  options: { cwd: string; env?: Record<string, string | undefined> },
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("bun", [path.join(repoRoot, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    timeout: 10_000,
    cwd: options.cwd,
    env: { ...process.env, AKM_BUNDLE_DIR: undefined, ...options.env },
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
}

// The default sandbox (from the preload) has no stash configured, which is what
// the original spawn version achieved by passing AKM_BUNDLE_DIR undefined.

// Tests.

describe("CLI error handling", () => {
  test("search without stash dir prints JSON error with hint", async () => {
    const { stderr, status } = await runCli("search", "test");
    // ConfigError (no bundle dir configured) -> exit 78 / STASH_DIR_NOT_FOUND.
    // Ground-truthed by probing the actual CLI output before pinning.
    expect(status).toBe(78);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.code).toBe("STASH_DIR_NOT_FOUND");
    expect(stderr).toContain("No bundle directory found");
    expect(stderr).toContain("hint");
  });

  test("show with malformed ref prints JSON usage error", async () => {
    const { stderr, status } = await runCli("show", "../invalid");
    expect(status).toBe(2);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error).toBe("string");
    expect(parsed.code).toBe("MISSING_REQUIRED_ARGUMENT");
  });

  test("search --from invalid prints hint about source", async () => {
    const { stderr, status } = await runCli("search", "test", "--from", "invalid");
    // Named-source validation: unknown source names produce INVALID_SOURCE_VALUE
    // with a message that lists valid source names (or says none are configured).
    // Usage error -> exit 2. Ground-truthed by probing the actual CLI output
    // before pinning.
    expect(status).toBe(2);
    expect(stderr).toContain("Unknown source name");
    expect(stderr).toContain("INVALID_SOURCE_VALUE");
    expect(stderr).toContain("hint");
  });

  test("search --detail invalid prints hint about detail", async () => {
    const stash = makeStashDir();
    disposers.push(stash);
    const { stderr, status } = await withEnv({ AKM_BUNDLE_DIR: stash.dir }, () =>
      runCli("search", "test", "--detail", "invalid"),
    );
    // Usage error (INVALID_DETAIL_VALUE) -> exit 2. Ground-truthed by probing
    // the actual CLI output before pinning.
    expect(status).toBe(2);
    expect(stderr).toContain("Invalid value for --detail");
    expect(stderr).toContain("hint");
  });

  test("health --detail invalid value yields UsageError with exit 2", async () => {
    const { stderr, status } = await runCli("health", "--detail", "verbose");
    expect(status).toBe(2);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_DETAIL_VALUE");
  });

  test("health --window-compare with bad duration yields UsageError exit 2", async () => {
    const { stderr, status } = await runCli("health", "--window-compare", "bogus");
    expect(status).toBe(2);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_FLAG_VALUE");
  });

  test("health --window-compare combined with --windows is mutually exclusive (exit 2)", async () => {
    const sinceArg = new Date(Date.now() - 3600_000).toISOString();
    const { stderr, status } = await runCli(
      "health",
      "--window-compare",
      "1h",
      "--windows",
      `name=a,since=${sinceArg}`,
    );
    expect(status).toBe(2);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_FLAG_VALUE");
  });

  test("error output is valid JSON", async () => {
    const { stderr } = await runCli("show", "invalid-ref-no-colon");
    const trimmed = stderr.trim();
    const parsed = JSON.parse(trimmed);
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error).toBe("string");
  });

  test("config set with invalid JSON prints hint about quoting", async () => {
    const { stderr, status } = await runCli("config", "set", "embedding", "not-valid-json");
    // Usage error (INVALID_JSON_CONFIG_VALUE) -> exit 2. Ground-truthed by
    // probing the actual CLI output before pinning.
    expect(status).toBe(2);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_JSON_CONFIG_VALUE");
    expect(parsed.hint).toContain("Quote JSON values");
  });

  test("CLI hint comes from the error instance, not a regex over the message", async () => {
    // Reproduces the failure path: search without a stash dir throws ConfigError
    // with code STASH_DIR_NOT_FOUND. The CLI surfaces error.hint(), not a regex
    // against the message string.
    const { stderr, status } = await runCli("search", "test");
    // ConfigError (no bundle dir configured) -> exit 78. Ground-truthed by
    // probing the actual CLI output before pinning.
    expect(status).toBe(78);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("STASH_DIR_NOT_FOUND");
    expect(parsed.hint).toBe(new ConfigError("x", "STASH_DIR_NOT_FOUND").hint());
    expect(parsed.hint).toContain("akm setup");
  });
});

// P1a carried advisory, wired here per docs/plans/specs/p1b-model-extraction.md
// §1.5 (binding choice: "the envelope tests extend
// tests/integration/cli-errors.test.ts. No tasks-cli-envelope family exists
// at head … and minting one for two cases would fragment the CLI-envelope
// surface.") and §5.5. Both codes were declared and WIRED by P1a (D7,
// src/core/errors.ts) — this is new CLI-envelope-level coverage of an
// already-correct throw, not a behavior flip: one test per code asserting
// the {ok:false,error,code} JSON envelope on stderr and exit 2.
describe("CLI envelope coverage for P1a's diagnostic codes (COMPOSITION_INVALID, TASK_SOURCE_INVALID)", () => {
  test("akm task run of a malformed task source emits {ok:false,code:TASK_SOURCE_INVALID} on stderr, exit 2", async () => {
    const stash = makeStashDir();
    disposers.push(stash);
    fs.mkdirSync(path.join(stash.dir, "tasks"), { recursive: true });
    // P4 (docs/plans/specs/p4-deletions-closeout.md §3.2.2, row B-18/B-19,
    // F-A2.35) retired the R-06 shape this fixture used to pin — task source
    // v4 makes scheduling OPTIONAL, so "neither akm.schedule nor on:
    // declared" is no longer an error at all (D2-N6). `run:` and `uses:`
    // both present is task source v4's own "exactly one executable selector"
    // TASK_SOURCE_INVALID instead — the same code, a different malformation.
    fs.writeFileSync(
      path.join(stash.dir, "tasks", "bad-source.yml"),
      "version: 4\nrun: echo hi\nuses: commands/x\n",
      "utf8",
    );

    const { stderr, status } = await withEnv({ AKM_BUNDLE_DIR: stash.dir }, () => runCli("task", "run", "bad-source"));

    expect(status).toBe(2);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("TASK_SOURCE_INVALID");
    expect(typeof parsed.error).toBe("string");
    expect(parsed.hint).toBe(new UsageError("x", "TASK_SOURCE_INVALID").hint());
  });

  // P4 (spec §3.2.2, rows B-14/B-15, F-A2.35): task source v3 AND v2 are
  // both retired from `src` now, with the SAME TASK_SCHEMA_VERSION_UNSUPPORTED
  // code and migrate hint (the migrator runs both generations in sequence).
  test.each([
    ["v3", "version: 3\nrun: echo hi\nschedule: '@daily'\n"],
    ["v2", "version: 2\nschedule: '@daily'\ncommand: echo hi\n"],
  ] as const)("akm task run of a %s task source emits {ok:false,code:TASK_SCHEMA_VERSION_UNSUPPORTED} on stderr, exit 2, naming the migrate command", async (_label, yaml) => {
    const stash = makeStashDir();
    disposers.push(stash);
    fs.mkdirSync(path.join(stash.dir, "tasks"), { recursive: true });
    fs.writeFileSync(path.join(stash.dir, "tasks", "legacy-source.yml"), yaml, "utf8");

    const { stderr, status } = await withEnv({ AKM_BUNDLE_DIR: stash.dir }, () =>
      runCli("task", "run", "legacy-source"),
    );

    expect(status).toBe(2);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("TASK_SCHEMA_VERSION_UNSUPPORTED");
    expect(typeof parsed.error).toBe("string");
    // Both fixtures are unmigratable shapes (issue #869): the message names
    // the blocked reason and tells the operator a human decision is needed,
    // rather than pointing at `akm migrate apply`, which would just report
    // the same block.
    expect(parsed.error).toContain("needs a human decision");
    expect(parsed.hint).toContain("Review the file and resolve the ambiguity by hand");
  });

  test("akm workflow run of a step passing with: to a task target emits {ok:false,code:COMPOSITION_INVALID} on stderr, exit 2", async () => {
    const stash = makeStashDir();
    disposers.push(stash);
    fs.mkdirSync(path.join(stash.dir, "tasks"), { recursive: true });
    fs.mkdirSync(path.join(stash.dir, "workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(stash.dir, "commands", "review.md"),
      "Review the workflow-composed task target.\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(stash.dir, "tasks", "nightly.yml"),
      ["version: 4", "uses: commands/review", ""].join("\n"),
    );
    // Lane A's with-rejection (P1a, taskDispatch's head guard): a workflow
    // step composing a task target with a with: block.
    fs.writeFileSync(
      path.join(stash.dir, "workflows", "with-on-task.yml"),
      [
        "name: With on task",
        "on:",
        "  workflow_dispatch:",
        "jobs:",
        "  main:",
        "    runs-on: [self-hosted]",
        "    steps:",
        "      - id: dispatch",
        "        uses: tasks/nightly",
        "        with:",
        "          scope: all",
        "",
      ].join("\n"),
    );

    await withEnv({ AKM_BUNDLE_DIR: stash.dir }, () => runCli("index", "--full"));
    const { stderr, status } = await withEnv({ AKM_BUNDLE_DIR: stash.dir }, () =>
      runCli("workflow", "run", "workflows/with-on-task"),
    );

    expect(status).toBe(2);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("COMPOSITION_INVALID");
    expect(parsed.error).toBe(
      "Workflow step dispatch cannot pass with: to task target tasks/nightly; tasks/nightly declares no inputs.",
    );
    expect(parsed.hint).toBe(new UsageError("x", "COMPOSITION_INVALID").hint());
  });
});

// P4 (docs/plans/specs/p4-deletions-closeout.md §5.2, carried advisory R-R7):
// investigated adding CLI-envelope + exit-2 coverage for TARGET_REF_INVALID
// and TASK_TARGET_UNSUPPORTED — the two D7 codes with no test at this level
// before P4's INVALID_FLAG_VALUE re-coding sweep — and found BOTH
// unreachable through any real `akm` invocation, so no test is added for
// either (a fabricated assertion of an unreachable code would be worse than
// no coverage). Recorded per the phase's own rule ("a defect discovered …
// is recorded … and left unfixed") rather than silently absorbed:
//
//   - TARGET_REF_INVALID: `classifyTargetRef`'s only two callers each
//     immediately re-code its thrown UsageError before it can reach a CLI
//     boundary. `src/tasks/source/task-source-v4.ts`'s `parseTarget` wraps
//     it through `sourceError(ctx, ["uses"], cause.message)`, which always
//     re-throws as TASK_SOURCE_INVALID (verified empirically: a v4 task with
//     `uses: nonsense/target` surfaces `{code:"TASK_SOURCE_INVALID"}`, not
//     TARGET_REF_INVALID). `src/workflows/source-ir/uses.ts`'s
//     `classifyWorkflowSourceUses` similarly feeds a compile-time
//     `WorkflowSourceSemanticError` (its own `unsupported-uses-target` family
//     of codes), which the freeze wrapper's P4-N2 mapping (§3.3.4) recodes
//     onto WORKFLOW_SOURCE_INVALID or COMPOSITION_INVALID at the CLI
//     boundary. TARGET_REF_INVALID's `.code` is exercised only at the unit
//     level (`tests/execution/target-ref.test.ts`).
//   - TASK_TARGET_UNSUPPORTED: script-capture.ts's two live throw sites are
//     both structurally unreachable in THIS runtime — `SCRIPT_EXTENSIONS`
//     (src/core/recognition-util.ts) and `SCRIPT_INTERPRETERS`'s key set
//     (script-capture.ts) are the identical 16 extensions, so no script
//     asset can ever resolve (a prerequisite reached before
//     `scriptInterpreter` runs) with an extension `scriptInterpreter` then
//     rejects; and the Bun-required arm's guard (`!process.versions.bun`) is
//     always false under `bun test`.
//
// WORKFLOW_SOURCE_INVALID, TASK_SOURCE_INVALID, COMPOSITION_INVALID, and
// INPUT_BINDING_INVALID all already have CLI-level coverage: the describe
// block above; tests/integration/commands/tasks-input-flags.test.ts;
// tests/integration/workflows/workflow-source-collision.test.ts;
// tests/integration/commands/workflow-cli-contract.test.ts.

describe("error class hints", () => {
  test("ConfigError derives hint from code by default", () => {
    expect(new ConfigError("missing stash", "STASH_DIR_NOT_FOUND").hint()).toContain("akm setup");
    expect(new ConfigError("not a dir", "STASH_DIR_NOT_A_DIRECTORY").hint()).toContain("directory");
    expect(new ConfigError("unreadable", "STASH_DIR_UNREADABLE").hint()).toContain("permission");
    expect(new ConfigError("no embedding", "EMBEDDING_NOT_CONFIGURED").hint()).toContain("akm config set embedding");
    expect(new ConfigError("no llm", "LLM_NOT_CONFIGURED").hint()).toContain("defaults.llmEngine");
  });

  test("ConfigError without a code-mapped hint returns undefined", () => {
    expect(new ConfigError("bad config", "INVALID_CONFIG_FILE").hint()).toBeUndefined();
    expect(new ConfigError("can't resolve", "CONFIG_DIR_UNRESOLVABLE").hint()).toBeUndefined();
  });

  test("UsageError derives hint from code by default", () => {
    expect(new UsageError("bad source", "INVALID_SOURCE_VALUE").hint()).toBe(
      "Pick one of: local, registry, all, or a configured source name.",
    );
    expect(new UsageError("bad format", "INVALID_FORMAT_VALUE").hint()).toBe(
      "Pick one of: json, jsonl, yaml, text, md, html.",
    );
    expect(new UsageError("bad detail", "INVALID_DETAIL_VALUE").hint()).toBe(
      "Pick one of: brief, normal, full. For agent/summary projections use --shape.",
    );
    expect(new UsageError("bad shape", "INVALID_SHAPE_VALUE").hint()).toBe(
      "Pick one of: human, agent, summary (summary falls back to agent, with a warning, on commands with no summary projection).",
    );
    expect(new UsageError("bad json", "INVALID_JSON_CONFIG_VALUE").hint()).toContain("Quote JSON values");
    expect(new UsageError("bad target", "MISSING_OR_AMBIGUOUS_TARGET").hint()).toContain("akm bundle update --all");
    expect(new UsageError("not updatable", "TARGET_NOT_UPDATABLE").hint()).toContain("akm bundle list");
  });

  test("UsageError without a code-mapped hint returns undefined", () => {
    // INVALID_FLAG_VALUE is intentionally a generic fallback — points at --help.
    expect(new UsageError("bad flag", "INVALID_FLAG_VALUE").hint()).toContain("akm <command> --help");
    expect(new UsageError("unknown key", "UNKNOWN_CONFIG_KEY").hint()).toBeUndefined();
    expect(new UsageError("bad json arg", "INVALID_JSON_ARGUMENT").hint()).toBeUndefined();
  });

  test("NotFoundError derives hint from code by default", () => {
    // Wave C #284 added canned hints for the remaining codes.
    expect(new NotFoundError("missing source", "SOURCE_NOT_FOUND").hint()).toContain("akm bundle list");
    expect(new NotFoundError("missing asset", "ASSET_NOT_FOUND").hint()).toContain("akm search");
    expect(new NotFoundError("missing wf", "WORKFLOW_NOT_FOUND").hint()).toContain("akm workflow list");
    expect(new NotFoundError("missing file", "FILE_NOT_FOUND").hint()).toContain("path exists");
  });

  test("explicit hint at construction overrides the code-derived default", () => {
    const explicit = new UsageError("oops", "INVALID_FLAG_VALUE", "do this instead");
    expect(explicit.hint()).toBe("do this instead");

    const overrideMapped = new UsageError("oops", "INVALID_SOURCE_VALUE", "custom");
    expect(overrideMapped.hint()).toBe("custom");

    const cfg = new ConfigError("oops", "STASH_DIR_NOT_FOUND", "custom config hint");
    expect(cfg.hint()).toBe("custom config hint");

    const nf = new NotFoundError("oops", "ASSET_NOT_FOUND", "find it here");
    expect(nf.hint()).toBe("find it here");
  });
});

describe("config path subcommand", () => {
  test("config path prints the config file path", async () => {
    const { stdout, status } = await runCli("config", "path");
    expect(status).toBe(0);
    expect(stdout.trim()).toContain("config.json");
  });

  test("config path --all returns all path keys", async () => {
    const { stdout, status } = await runCli("config", "path", "--all", "--format=json");
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed).toHaveProperty("config");
    expect(parsed).toHaveProperty("bundle");
    expect(parsed).toHaveProperty("cache");
    expect(parsed).toHaveProperty("index");
  });
});

describe("registry remove", () => {
  // KEPT AS A SUBPROCESS: this test asserts project-vs-user config layering that
  // depends on the CLI running with its working directory inside a project dir.
  // Running it in-process would require process.chdir() to a temp dir, which
  // breaks Bun's bare-specifier resolution for the CLI's lazy dynamic imports
  // (manifests as "Cannot find package 'citty'"). Spawning a real subprocess is
  // the correct, faithful way to exercise this cwd-dependent behavior.
  test("does not persist project registries into user config", () => {
    const project = makeSandboxDir("akm-cli-err-project");
    const xdgConfig = makeSandboxDir("akm-cli-err-cfg");
    const xdgCache = makeSandboxDir("akm-cli-err-cache");
    const xdgData = makeSandboxDir("akm-cli-err-data");
    const home = makeSandboxDir("akm-cli-err-home");
    disposers.push(project, xdgConfig, xdgCache, xdgData, home);

    const userConfigPath = path.join(xdgConfig.dir, "akm", "config.json");
    const projectConfigPath = path.join(project.dir, ".akm", "config.json");

    fs.mkdirSync(path.dirname(userConfigPath), { recursive: true });
    fs.writeFileSync(
      userConfigPath,
      `${JSON.stringify(
        {
          configVersion: "0.9.0",
          registries: [{ url: "https://user.example/index.json", name: "user" }],
        },
        null,
        2,
      )}\n`,
    );

    fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
    fs.writeFileSync(
      projectConfigPath,
      `${JSON.stringify(
        {
          configVersion: "0.9.0",
          registries: [{ url: "https://project.example/index.json", name: "project" }],
        },
        null,
        2,
      )}\n`,
    );

    const { status } = spawnCli(["registry", "remove", "user", "-y", "--format=json"], {
      cwd: project.dir,
      env: {
        HOME: home.dir,
        XDG_CONFIG_HOME: xdgConfig.dir,
        XDG_CACHE_HOME: xdgCache.dir,
        XDG_DATA_HOME: xdgData.dir,
      },
    });

    expect(status).toBe(0);

    const savedUserConfig = JSON.parse(fs.readFileSync(userConfigPath, "utf8"));
    expect(savedUserConfig.registries).toEqual([]);
    expect(savedUserConfig.registries).not.toContainEqual({
      url: "https://project.example/index.json",
      name: "project",
    });
  });
});

// Output-shape registry regression guard.
//
// On 2026-05-25 four CLI verbs (akm lint, akm tasks, akm graph, akm db) were
// each broken by the same root cause: their command name was never registered
// in src/output/shapes/passthrough.ts. Every invocation returned an
// {"ok":false,"error":"output shape not registered for command: <name>"}
// envelope with exit 0. The verbs ran their command logic correctly, then died
// at the output-rendering step.
//
// The bug class: adding a defineCommand in src/cli.ts whose handler calls
// output("X", result) without also adding "X" to PASSTHROUGH_COMMANDS (or
// registering a custom shape elsewhere) leaves the command non-functional in a
// way that no other test catches.
//
// This regression guard invokes each read-only verb against the isolated sandbox
// stash and asserts the output doesn't carry the specific error string. It's
// intentionally a curated list rather than discover-from---help: the list IS the
// contract we maintain, and adding a new verb means adding it here so the guard
// covers it.
describe("output shape registry — every CLI verb returns a registered shape", () => {
  // Verbs that take no required args and are read-only against the
  // empty/isolated temp stash. Anything that requires a ref, takes interactive
  // input, mutates external state, or needs network access belongs elsewhere.
  const READ_ONLY_VERBS: readonly (readonly string[])[] = [
    ["health"],
    ["lint"],
    ["info"],
    ["task"],
    ["config"],
    ["log"],
    ["registry"],
    ["bundle", "list"],
  ];

  for (const verb of READ_ONLY_VERBS) {
    test(`akm ${verb.join(" ")} --format json does not return an "output shape not registered" envelope`, async () => {
      const { stdout } = await runCli(...verb, "--format", "json");
      // The bug class produces this exact substring. Any future verb that calls
      // output() without a registered shape will trip this.
      expect(stdout).not.toContain("output shape not registered");
    });
  }
});

// R-032: unknown commands and missing required args must exit 2 (usage),
// matching STABILITY.md's exit-code table — not 1. The root cause was
// citty's own `runMain` unconditionally calling `process.exit(1)` for any
// error escaping `runCommand`, including its unexported `CLIError` (unknown
// command / missing args / "no command specified"). `src/cli.ts` no longer
// calls `runMain`; it drives `runCommand` directly and reclassifies that one
// error family as USAGE (2). This can only be observed through a real
// subprocess: the in-process harness (`runCliCapture` in
// tests/_helpers/cli.ts) drives citty's `runCommand` directly and never runs
// `src/cli.ts`'s `import.meta.main`-gated startup block where the fix lives
// (see that harness's own module docstring, and
// tests/integration/commands/distill/distill-cli-flag.test.ts's comment on
// the same split).
describe("R-032: citty CLIError family exits 2, not 1", () => {
  test("akm totally-bogus (unknown top-level command) exits 2", () => {
    const { status, stderr } = spawnCli(["totally-bogus"], { cwd: repoRoot });
    expect(status).toBe(2);
    expect(stderr).toContain("Unknown command");
    expect(stderr).toContain("totally-bogus");
  });

  test("akm wiki list (unknown top-level command, pre-0.9.0 surface) exits 2", () => {
    const { status, stderr } = spawnCli(["wiki", "list"], { cwd: repoRoot });
    expect(status).toBe(2);
    expect(stderr).toContain("Unknown command");
    expect(stderr).toContain("wiki");
  });

  // C4: `config enable`/`config disable` (a hardcoded skills.sh registry
  // toggle) were removed in 0.9.0 — use `akm registry add|remove`. Real
  // subprocess required: the in-process harness does not reproduce citty's
  // exit code for an unknown subcommand of a known group.
  test("akm config enable <target> (removed in 0.9.0) exits 2 as an unknown subcommand", () => {
    const { status, stderr } = spawnCli(["config", "enable", "skills.sh"], { cwd: repoRoot });
    expect(status).toBe(2);
    expect(stderr).toContain("Unknown command");
    expect(stderr).toContain("enable");
  });

  test("akm config disable <target> (removed in 0.9.0) exits 2 as an unknown subcommand", () => {
    const { status, stderr } = spawnCli(["config", "disable", "skills.sh"], { cwd: repoRoot });
    expect(status).toBe(2);
    expect(stderr).toContain("Unknown command");
    expect(stderr).toContain("disable");
  });

  test("akm import (missing required SOURCE positional) exits 2", () => {
    const { status, stderr } = spawnCli(["import"], { cwd: repoRoot });
    expect(status).toBe(2);
    expect(stderr).toContain("Missing required positional argument");
  });

  // Owner ruling 12 canonical bare-group behavior: every `akm <group>` with no
  // subcommand produces the SAME structured usage envelope on stderr and exits
  // 2. Before 0.9.0 the twelve groups split three ways — some ran an implicit
  // default action and exited 0, and `log`/`lessons`/`registry` fell through to
  // citty's human usage banner on stdout. Matching exit codes was not enough:
  // a script could not parse the failure uniformly.
  // One test PER GROUP rather than one loop over all eleven. The loop form
  // spawned eleven real subprocesses inside a single test, and at roughly half
  // a second of Bun startup each it sat right on the harness's default 5s
  // per-test budget — green locally, intermittently red under CI load, and
  // reported as a timeout that names no group. Per-group tests each carry one
  // spawn, and a failure says which group broke.
  //
  // 0.9.0 CLI overhaul (S3): `log` and `lessons` dropped out of this list —
  // `log` is now a terminal leaf command (bare `akm log` is a valid
  // invocation, not a bare-group usage error; see
  // tests/commands/observability-cli-envelope.test.ts) and `lessons` was
  // removed entirely.
  for (const group of ["migrate", "registry", "config", "proposal", "env", "secret", "task", "workflow"]) {
    test(`bare akm ${group} emits the canonical usage envelope and exits 2`, () => {
      const { status, stderr } = spawnCli([group], { cwd: repoRoot });
      expect(status).toBe(2);
      const parsed = JSON.parse(stderr.trim());
      expect(parsed.ok).toBe(false);
      expect(parsed.code).toBe("MISSING_REQUIRED_ARGUMENT");
      expect(parsed.error).toContain(`\`akm ${group}\` requires a subcommand`);
    });
  }

  test("akm --help still exits 0 and prints usage (unaffected by the R-032 fix)", () => {
    const { status, stdout } = spawnCli(["--help"], { cwd: repoRoot });
    expect(status).toBe(0);
    expect(stdout).toContain("USAGE");
    expect(stdout).toContain("4   health warn");
    expect(stdout).toContain("70  internal / unclassified error");
    expect(stdout).toContain("1   not found / command-reported failure");
  });

  // S11 item 3: citty's CLIError is now routed through the SAME
  // `{ok:false,error,code,hint}` envelope every other command's failure
  // uses, instead of citty's own usage-banner + raw `console.error(message)`.
  test("akm totally-bogus emits the standard JSON envelope with a stable code", () => {
    const { status, stderr } = spawnCli(["totally-bogus"], { cwd: repoRoot });
    expect(status).toBe(2);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("UNKNOWN_COMMAND");
    expect(parsed.error).toBe("Unknown command totally-bogus");
    expect(parsed.hint).toContain("akm --help");
  });

  // S11 item 3: did-you-mean via edit distance over the sibling command set
  // at the point of failure.
  test("akm serach (typo of search) suggests the close sibling command", () => {
    const { status, stderr } = spawnCli(["serach"], { cwd: repoRoot });
    expect(status).toBe(2);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.hint).toContain("Did you mean `search`?");
  });

  test("akm totally-bogus (nothing close) gets the plain pointer, no false suggestion", () => {
    const { stderr } = spawnCli(["totally-bogus"], { cwd: repoRoot });
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.hint).not.toContain("Did you mean");
    expect(parsed.hint).toBe("Run `akm --help` for usage.");
  });

  // Retired 0.9-overhaul spellings get their REPLACEMENT, never a
  // did-you-mean: edit distance steers agents into the wrong command
  // (`init`→`info`, `update`→`upgrade` — the latter replaces the binary).
  test("retired top-level spellings hint the replacement, not did-you-mean", () => {
    const cases: Array<[string[], string]> = [
      [["init"], "akm bundle create"],
      [["update"], "akm bundle update"],
      [["tasks", "doctor"], "akm task <subcommand>"],
      [["history"], "akm log --ref"],
      [["mv", "a", "b"], "rekey-asset-ref.ts"],
      [["extract"], "akm proposal extract"],
      // The removed `akm vault ...` family (0.9.0 release-notes headline)
      // falls through to a generic did-you-mean without this hint.
      [["vault", "list"], "akm env list"],
      [["vault", "get", "x"], "akm secret set"],
    ];
    for (const [argv, expected] of cases) {
      const { status, stderr } = spawnCli(argv, { cwd: repoRoot });
      expect(status, argv.join(" ")).toBe(2);
      const parsed = JSON.parse(stderr.trim());
      expect(parsed.code, argv.join(" ")).toBe("UNKNOWN_COMMAND");
      expect(parsed.hint, argv.join(" ")).toContain(expected);
      expect(parsed.hint, argv.join(" ")).not.toContain("Did you mean");
      // Every retired-spelling hint routes to the in-CLI rename table.
      expect(parsed.hint, argv.join(" ")).toContain("akm help migrate 0.9.0");
    }
  });

  test("retired group-scoped spellings resolve against their parent group", () => {
    const cases: Array<[string[], string]> = [
      [["env", "set", "prod", "KEY"], "edit the `.env` file"],
      [["registry", "search", "x"], "akm search --from registry"],
      [["workflow", "watch", "run-1"], "akm log --run"],
      [["config", "show"], "akm config list"],
      [["task", "enable", "t1"], "akm task sync"],
      [["task", "show", "t1"], "akm show"],
      [["log", "tail"], "@offset:"],
    ];
    for (const [argv, expected] of cases) {
      const { status, stderr } = spawnCli(argv, { cwd: repoRoot });
      expect(status, argv.join(" ")).toBe(2);
      const parsed = JSON.parse(stderr.trim());
      expect(parsed.hint, argv.join(" ")).toContain(expected);
    }
  });

  // Removed 0.9 flags (as opposed to removed commands) get no hint at all
  // today — just a generic "unknown flag" from src/cli/unknown-flags.ts.
  // `retiredFlagHint` (src/cli/retired-commands.ts) closes that gap. Uses a
  // real subprocess (like the retired-spellings tests above), not the
  // `runCli` in-process harness: a `UsageError` thrown by `assertKnownFlags`
  // — BEFORE citty's own `runCommand` ever starts — escapes the harness's
  // replicated startup contract without going through `emitJsonError`, so it
  // lands in `stderr` as a raw message instead of the JSON envelope the real
  // CLI always produces here (verified directly: `bun src/cli.ts index
  // --background` prints the proper `{"ok":false,...}` envelope).
  test("retired flags on their current command hint the replacement procedure", () => {
    const cases: Array<[string[], string]> = [
      [["index", "--background"], "--quiet"],
      [["setup", "--detect-only"], "akm setup"],
      [["setup", "--reset-recommended"], "recommended defaults"],
      [["proposal", "extract", "--watch"], "proposal extract --auto"],
      [["proposal", "extract", "--debounce-ms"], "proposal extract --auto"],
    ];
    for (const [argv, expected] of cases) {
      const { status, stderr } = spawnCli(argv, { cwd: repoRoot });
      expect(status, argv.join(" ")).toBe(2);
      const parsed = JSON.parse(stderr.trim());
      expect(parsed.code, argv.join(" ")).toBe("UNKNOWN_FLAG");
      expect(parsed.hint, argv.join(" ")).toContain(expected);
      expect(parsed.hint, argv.join(" ")).toContain("akm help migrate 0.9.0");
    }
  });
});

// S11 item 1/2: the sectioned root help groups top-level commands instead of
// citty's flat alphabetical-by-declaration COMMANDS dump, and hides the
// self-update-only `migrate` group from it (while it still executes).
describe("S11: sectioned root help", () => {
  test("bare akm prints the sectioned overview and exits 0", () => {
    const { status, stdout, stderr } = spawnCli([], { cwd: repoRoot });
    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("AGENT LOOP");
    expect(stdout).toContain("Run `akm help <command>`");
  });

  test("akm --help pins section order and command membership", () => {
    const { stdout } = spawnCli(["--help"], { cwd: repoRoot });
    const headings = ["AGENT LOOP", "ASSETS", "AUTOMATION", "SYSTEM"];
    const sections = Object.fromEntries(
      headings.map((heading, index) => {
        const start = stdout.indexOf(`${heading}\n`);
        const end = index + 1 < headings.length ? stdout.indexOf(`\n${headings[index + 1]}\n`, start) : stdout.length;
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThan(start);
        const commands = stdout
          .slice(start + heading.length + 1, end)
          .split("\n")
          .flatMap((line) => line.match(/^ {2}(\S+)\s{2,}/)?.[1] ?? []);
        return [heading, commands];
      }),
    );
    expect(sections).toEqual({
      "AGENT LOOP": ["curate", "search", "show", "feedback", "remember"],
      ASSETS: ["import", "clone", "bundle", "env", "secret", "sync", "proposal"],
      AUTOMATION: ["improve", "agent", "command", "workflow", "task"],
      SYSTEM: [
        "setup",
        "index",
        "lint",
        "health",
        "config",
        "models",
        "registry",
        "info",
        "log",
        "migrate",
        "help",
        "hints",
        "upgrade",
        "completions",
      ],
    });
    expect(stdout).toContain("Run `akm help <command>`");
    expect(stdout).toContain("Agents: run `akm hints`");
  });

  test("akm --help lists migrate in the SYSTEM section", () => {
    // Previously hidden (S11): the upgrade instructions tell users to run
    // `akm migrate status`/`apply` first, so the command needs to be
    // discoverable from `akm --help` rather than a self-update-only secret.
    const { stdout } = spawnCli(["--help"], { cwd: repoRoot });
    expect(stdout).toContain("  migrate ");
  });

  test("akm migrate status still executes", () => {
    // Not asserting exit 0 — status depends on ambient config/DB state this
    // suite doesn't sandbox for this one subprocess.
    const { stdout, stderr } = spawnCli(["migrate", "status"], { cwd: repoRoot });
    expect(stderr).not.toContain("Unknown command");
    expect(stdout).toContain('"status"');
  });

  test("akm migrate --help renders its own usage", () => {
    const { status, stdout, stderr } = spawnCli(["migrate", "--help"], { cwd: repoRoot });
    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("akm migrate");
    expect(stdout).toContain("USAGE");
  });

  test("bare akm help prints the same sectioned overview and exits 0", () => {
    const { status, stdout } = spawnCli(["help"], { cwd: repoRoot });
    expect(status).toBe(0);
    expect(stdout).toContain("AGENT LOOP");
    expect(stdout).toContain("Run `akm help <command>`");
  });

  test.each(["bundle", "env", "task"])("akm help %s renders that command's usage", (command) => {
    const { status, stdout, stderr } = spawnCli(["help", command], { cwd: repoRoot });
    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain(`akm ${command}`);
    expect(stdout).toContain("USAGE");
  });

  test("akm bundle add --help lists every registry adapter id in --adapter's description (#909)", () => {
    // Regression: there was no way to discover the valid `components.*.adapter`
    // names from the CLI at all (`akm bundle add --help` named no `--adapter`
    // flag, let alone a registry listing). RED on old code: no `--adapter` flag
    // existed, so none of these assertions held.
    const { status, stdout, stderr } = spawnCli(["bundle", "add", "--help"], { cwd: repoRoot });
    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("--adapter");
    for (const id of VALID_ADAPTER_IDS) {
      expect(stdout).toContain(id);
    }
  });

  test("akm task run --help includes the akm prefix on nested USAGE lines", () => {
    const { stdout } = spawnCli(["task", "run", "--help"], { cwd: repoRoot });
    expect(stdout).toContain("akm task run");
  });
});

// R-051: five TERMINAL leaf commands (akm health, akm index, akm lint, the
// former akm log tail, and akm hints) were declared via a raw
// `defineCommand`/inline `runWithJsonErrors` rather than `defineJsonCommand`,
// so they did not automatically inherit `GLOBAL_OUTPUT_ARGS`
// (src/cli/shared.ts) the way every `defineJsonCommand` leaf does. All five
// already PARSED `--format`/`--detail`/`--shape`/`--output` correctly (none
// declares a positional a stray value could fall into), so this was a
// `--help` visibility / consistency gap, not a live parsing defect. This
// package (PKG-8) owns and fixed three of the five (`health`/`index`/
// `lint`); the other two (`log tail`, `hints`) lived in
// src/commands/observability-cli.ts, owned by a different package at the
// time — `hints` is format-exempt (see
// `formatExemptSurfaces()` below), and `log tail` was the last one, fixed by
// the W3-A backlog package. All six leaves now declare the flags, so the
// allowlist this comment used to describe is gone: the guard below simply
// fails loudly on any leaf that doesn't declare them.
//
// Scope note: this walk only considers TERMINAL leaves — commands with a
// `run` and no `subCommands` of their own. `defineGroupCommand`-based
// dispatch groups (`akm graph`, `akm task`, `akm proposal`, …) also have a
// `run` (their subcommand-routing + bare-invocation guard), but whether
// their OWN bare-invocation behavior needs `GLOBAL_OUTPUT_ARGS` is a
// separate, broader question this triage item didn't scope or fix. Note: as
// of 0.9.0 (owner ruling 12) the canonical bare-group behavior is a usage
// error (exit 2) via `defineGroupCommand`'s shared default, not a
// command-specific `output()` call — `akm graph`'s bare invocation used to
// call `output()` directly (the gap this comment originally flagged) but no
// longer does. Some other groups may still carry a similar gap where
// `defaultRun` remains an explicit override; touching those means editing
// files this package does not own.
describe("GLOBAL_OUTPUT_ARGS coverage guard (R-051)", () => {
  // biome-ignore lint/suspicious/noExplicitAny: walking citty's dynamically-shaped command tree
  type AnyCittyCommandForTest = Record<string, any>;

  interface RunnableCommand {
    /** Space-joined path, e.g. "log tail" — matches format-exempt.ts's naming. */
    path: string;
    args: Record<string, unknown>;
  }

  /**
   * Walk the full `main` command tree and collect every TERMINAL leaf — a
   * node with its own `run` and no `subCommands` of its own — at every
   * depth. Excludes both pure routing groups with no `run` at all (never
   * render output on their own) and `defineGroupCommand` dispatch groups
   * that have both a `run` AND `subCommands` (out of scope — see the
   * describe-block comment above). 0.9.0 CLI overhaul (S3): `akm log` was
   * one such pure routing group (`list`/`tail` subcommands); it is now
   * itself a terminal leaf (the `tail` subcommand was dropped) and so is
   * swept up by this walk like any other leaf. `akm lessons` (the other
   * former example here) was dropped entirely.
   */
  function collectTerminalLeafCommands(
    cmd: AnyCittyCommandForTest,
    parentPath: readonly string[] = [],
  ): RunnableCommand[] {
    const results: RunnableCommand[] = [];
    const subCommands = cmd.subCommands as Record<string, AnyCittyCommandForTest> | undefined;
    const hasSubCommands = !!subCommands && Object.keys(subCommands).length > 0;
    if (typeof cmd.run === "function" && parentPath.length > 0 && !hasSubCommands) {
      results.push({ path: parentPath.join(" "), args: (cmd.args ?? {}) as Record<string, unknown> });
    }
    if (subCommands) {
      for (const [key, sub] of Object.entries(subCommands)) {
        results.push(...collectTerminalLeafCommands(sub, [...parentPath, key]));
      }
    }
    return results;
  }

  test("every non-format-exempt terminal leaf declares GLOBAL_OUTPUT_ARGS", () => {
    const { commands: exemptCommands, subcommands: exemptSubcommands } = formatExemptSurfaces();
    const requiredKeys = Object.keys(GLOBAL_OUTPUT_ARGS);
    const leaves = collectTerminalLeafCommands(main as unknown as AnyCittyCommandForTest);
    expect(leaves.length).toBeGreaterThan(20); // sanity: the walk actually found the tree

    const missing: string[] = [];
    for (const { path, args } of leaves) {
      const topLevel = path.split(" ")[0] ?? path;
      if (exemptCommands.includes(topLevel)) continue;
      if (exemptSubcommands.includes(path)) continue;
      const argKeys = new Set(Object.keys(args));
      const hasAll = requiredKeys.every((key) => argKeys.has(key));
      if (!hasAll) missing.push(`akm ${path}`);
    }
    expect(missing).toEqual([]);
  });

  test("the three PKG-8-owned sites (health, index, lint) declare GLOBAL_OUTPUT_ARGS", () => {
    const requiredKeys = Object.keys(GLOBAL_OUTPUT_ARGS);
    const leaves = collectTerminalLeafCommands(main as unknown as AnyCittyCommandForTest);
    for (const path of ["health", "lint"]) {
      const leaf = leaves.find((entry) => entry.path === path);
      expect(leaf).toBeDefined();
      const argKeys = new Set(Object.keys(leaf?.args ?? {}));
      for (const key of requiredKeys) {
        expect(argKeys.has(key)).toBe(true);
      }
    }
    // `index` (index-redesign B5) is no longer a pure leaf — `akm index
    // status` sits under it as a real citty subcommand — so it no longer
    // shows up in `collectTerminalLeafCommands`'s `!hasSubCommands` walk.
    // Its own default body (`akm index` with no subcommand) still builds the
    // index directly and still needs GLOBAL_OUTPUT_ARGS on its own `args`,
    // so check the citty tree directly instead. `index status` is a genuine
    // leaf and is already covered by the walk-based test above.
    const indexGroup = (main as unknown as { subCommands?: Record<string, AnyCittyCommandForTest> }).subCommands?.index;
    expect(indexGroup).toBeDefined();
    const indexArgKeys = new Set(Object.keys(indexGroup?.args ?? {}));
    for (const key of requiredKeys) {
      expect(indexArgKeys.has(key)).toBe(true);
    }
  });
});

// R-050(c) (S11: R-050(b)'s own "--detail is a no-op on info/list/remember"
// boilerplate was dropped from the canonical wording — `list` doesn't exist
// as a bare command any more (folded into `akm bundle list`, S7), and a
// caveat naming stale commands is worse than no caveat). `--shape summary`
// is still a hard usage error everywhere except `akm show`, and that caveat
// should still be visible from a leaf's own `--help`, not only the root's.
describe("GLOBAL_OUTPUT_ARGS help text is scoped honestly (R-050c)", () => {
  test("--shape repeats the 'summary is show-only' caveat root help documents", () => {
    expect(GLOBAL_OUTPUT_ARGS.shape.description).toContain("summary");
    expect(GLOBAL_OUTPUT_ARGS.shape.description).toContain("akm show");
  });
});
