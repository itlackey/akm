// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-07 (Chunk 0a — brief §11, R4): CLI output baselines for the Chunk 9
 * sweep, families A (output helpers / shape registries / renderers-backed
 * show content), D (argv-handling surfaces), and F (error envelopes).
 *
 * These suites CAPTURE current HEAD behavior as committed golden fixtures —
 * they do not assert what the CLI "should" do, only what it does today, so
 * Chunk 9's rewire of `cli.ts` / `src/cli/shared.ts` / `src/output/**` can
 * diff its result against this oracle (designation `frozen-migration-input`
 * in `tests/fixtures/goldens/DESIGNATIONS.json`; text outputs that embed a
 * ref are `re-baseline` @ Chunk 5's grammar codemod — see brief §3.3).
 *
 * Conventions (brief §3.2, R6): assertions are key-set + scrubbed-string
 * based (sorted `Object.keys`, `<STASH>`/<TS>`/`<DUR>` placeholders via
 * `tests/_helpers/golden.ts`), never raw-byte CLI snapshots. Fixture-local
 * ref names come from `tests/fixtures/goldens/cli/fixture-refs.ts`.
 *
 * Every scenario drives the CLI in-process via `runCliCapture`
 * (`tests/_helpers/cli.ts`) — no subprocess spawns (brief §3.4, plan §15
 * rule 3's spawn allowlist ratchet is pinned at exactly 63; this file adds
 * none). `runCliCapture` deliberately skips the real `import.meta.main`
 * startup block (argv mutation, banner, stale-index cleanup, the global
 * `unhandledRejection`/`uncaughtException` handlers) — those pure-startup
 * behaviors are NOT covered here; they are exercised only by spawn-based
 * integration tests (pattern: `tests/integration/show-argv-entrypoint.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createProposal, isProposalSkipped } from "../../src/commands/proposal/repository";
import { getConfigPath } from "../../src/core/paths";
import { runCliCapture } from "../_helpers/cli";
import { expectGolden } from "../_helpers/golden";
import { type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";
import {
  A_AGENT_NAME,
  A_COMMAND_NAME,
  A_KNOWLEDGE_NAME,
  A_MEMORY_NAME,
  A_SCRIPT_NAME,
  A_SKILL_NAME,
  A_WORKFLOW_NAME,
  agentRef,
  commandRef,
  knowledgeRef,
  lessonRef,
  memoryRef,
  scriptRef,
  skillRef,
} from "../fixtures/goldens/cli/fixture-refs";

let storage: IsolatedAkmStorage;
let stashDir = "";

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return runCliCapture(args);
}

function writeFile(rel: string, content: string): void {
  const abs = path.join(stashDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Standard fixture asset sweep shared by most family-A/D/F scenarios. */
function seedAssets(): void {
  writeFile(`scripts/${A_SCRIPT_NAME}`, "#!/usr/bin/env bash\necho deploy\n");
  writeFile(`commands/${A_COMMAND_NAME}`, "---\ndescription: Release\n---\nRun release {{version}}\n");
  writeFile(`skills/${A_SKILL_NAME}/SKILL.md`, "# Ops\nFollow this runbook for on-call operations.\n");
  writeFile(`agents/${A_AGENT_NAME}`, "---\ndescription: Coach\n---\nYou are a coach.\n");
  writeFile(`knowledge/${A_KNOWLEDGE_NAME}`, "# Guide\nUse this.\n");
  writeFile(`memories/${A_MEMORY_NAME}.md`, "---\ndescription: history subject\n---\n\nA memory used for history.\n");
}

beforeEach(() => {
  // Full 5-dir isolation (stash + data/cache/config/state), not just the
  // stash: several scenarios in this file (curate/history index; the
  // raw-throw-Error `lessons coverage` case) are sensitive to a stale
  // index.db/state.db bleeding in from an XDG_DATA_HOME that `_preload.ts`
  // only sandboxes once per PROCESS, not per test (see its module docstring).
  storage = withIsolatedAkmStorage();
  stashDir = storage.stashDir;
  writeSandboxConfig({ semanticSearchMode: "off" });
  seedAssets();
});

afterEach(() => {
  storage.cleanup();
  stashDir = "";
});

// ─────────────────────────────────────────────────────────────────────────
// Family A — output helpers / shape registries / show content per asset type
// ─────────────────────────────────────────────────────────────────────────

describe("family A — search/show/list/info/curate/history/proposal/env/secret/events/config", () => {
  test("search <term> — json + text", async () => {
    const json = await runCli(["search", A_SCRIPT_NAME.replace(/\.sh$/, ""), "--format=json"]);
    expect(json.code).toBe(0);
    const parsedJson = JSON.parse(json.stdout) as Record<string, unknown>;
    expectGolden("tests/fixtures/goldens/cli/a-search.json", {
      argv: ["search", A_SCRIPT_NAME.replace(/\.sh$/, ""), "--format=json"],
      exitCode: json.code,
      stdoutKeys: Object.keys(parsedJson).sort(),
      hitKeys:
        Array.isArray(parsedJson.hits) && parsedJson.hits.length > 0
          ? Object.keys(parsedJson.hits[0] as Record<string, unknown>).sort()
          : [],
    });

    const text = await runCli(["search", A_SCRIPT_NAME.replace(/\.sh$/, ""), "--format=text"]);
    expect(text.code).toBe(0);
    expectGolden(
      "tests/fixtures/goldens/cli/a-search-text.json",
      { argv: ["search", "…", "--format=text"], exitCode: text.code, stdoutScrubbed: text.stdout },
      { stash: stashDir },
    );
  });

  test("show — per asset type (script/command/skill/agent/knowledge), json + text", async () => {
    const refs = [scriptRef(), commandRef(), skillRef(), agentRef(), knowledgeRef()];
    const perType: Record<string, { jsonKeys: string[]; textNonEmpty: boolean }> = {};
    for (const ref of refs) {
      const json = await runCli(["show", ref, "--format=json"]);
      expect(json.code).toBe(0);
      const parsed = JSON.parse(json.stdout) as Record<string, unknown>;
      const text = await runCli(["show", ref, "--format=text"]);
      expect(text.code).toBe(0);
      perType[ref] = { jsonKeys: Object.keys(parsed).sort(), textNonEmpty: text.stdout.length > 0 };
    }
    expectGolden("tests/fixtures/goldens/cli/a-show-per-type.json", { perType });
  });

  test("show command — formatShowPlain APPLY branches (skill, with/without active workflow)", async () => {
    // The APPLY-directive branches (helpers.ts formatShowPlain, ~:619-668) are
    // gated on assetType skill|knowledge, keyed off `activeRun` — which is
    // scope-based (current-working-directory scope key), not tied to the ref
    // being shown. No active run: the "no active workflow" APPLY directive.
    const withoutRun = await runCli(["show", skillRef(), "--format=text"]);
    expect(withoutRun.code).toBe(0);
    expect(withoutRun.stdout).toContain("APPLY (only if no workflow step is required for this task):");

    // With an active run in scope: start a workflow run scoped to a cwd, then
    // show the skill from that SAME cwd so getActiveWorkflowRun() resolves it
    // (src/workflows/runtime/runs.ts:908 — scope-based, any active/blocked run
    // in the scope counts, regardless of which asset is shown).
    // `workflow start` requires a configured default engine.
    writeSandboxConfig({
      engines: { "test-agent": { kind: "agent", platform: "opencode-sdk" } },
      defaults: { engine: "test-agent" },
    });
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-cli-goldens-workflow-"));
    const prevCwd = process.cwd();
    let withRun: { code: number; stdout: string; stderr: string };
    try {
      process.chdir(workDir);
      const created = await runCli(["workflow", "create", A_WORKFLOW_NAME]);
      expect(created.code).toBe(0);
      const started = await runCli(["workflow", "start", `workflows/${A_WORKFLOW_NAME}`]);
      expect(started.code).toBe(0);
      withRun = await runCli(["show", skillRef(), "--format=text"]);
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(workDir, { recursive: true, force: true });
    }
    expect(withRun.code).toBe(0);
    expect(withRun.stdout).toContain("WORKFLOW ACTIVE");
    expect(withRun.stdout).not.toContain("APPLY (only if no workflow step is required for this task):");

    expectGolden("tests/fixtures/goldens/cli/a-show-apply-branches.json", {
      withoutActiveRun: {
        containsApplyDirective: withoutRun.stdout.includes("APPLY (only if"),
        exitCode: withoutRun.code,
      },
      withActiveRun: {
        containsWorkflowActiveBanner: withRun.stdout.includes("WORKFLOW ACTIVE"),
        containsApplyDirective: withRun.stdout.includes("APPLY (only if"),
        exitCode: withRun.code,
      },
    });
  });

  test("show --shape=agent and --shape=summary", async () => {
    const agent = await runCli(["show", commandRef(), "--format=json", "--shape=agent"]);
    expect(agent.code).toBe(0);
    const summary = await runCli(["show", commandRef(), "--format=json", "--shape=summary"]);
    expect(summary.code).toBe(0);
    const agentJson = JSON.parse(agent.stdout) as Record<string, unknown>;
    const summaryJson = JSON.parse(summary.stdout) as Record<string, unknown>;
    // Summary is documented to omit the heavyweight template/content body.
    expect(summaryJson).not.toHaveProperty("template");
    expectGolden("tests/fixtures/goldens/cli/a-show-shapes.json", {
      agentKeys: Object.keys(agentJson).sort(),
      summaryKeys: Object.keys(summaryJson).sort(),
    });
  });

  test("list", async () => {
    const result = await runCli(["list", "--format=json"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expectGolden("tests/fixtures/goldens/cli/a-list.json", {
      exitCode: result.code,
      stdoutKeys: Object.keys(parsed).sort(),
    });
  });

  test("info", async () => {
    const result = await runCli(["info", "--format=json"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expectGolden("tests/fixtures/goldens/cli/a-info.json", {
      exitCode: result.code,
      stdoutKeys: Object.keys(parsed).sort(),
    });
  });

  test("curate <term>", async () => {
    await runCli(["index", "--full", "--format=json"]);
    const result = await runCli(["curate", "operations runbook"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expectGolden("tests/fixtures/goldens/cli/a-curate.json", {
      exitCode: result.code,
      stdoutKeys: Object.keys(parsed).sort(),
      shape: parsed.shape,
    });
  });

  test("history <ref> — seeded usage events", async () => {
    await runCli(["index", "--full", "--format=json"]);
    await runCli(["search", "history", "--format=json"]);
    const shown = await runCli(["show", memoryRef(), "--format=json"]);
    expect(shown.code).toBe(0);
    const result = await runCli(["history", "--ref", memoryRef(), "--format=json"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expectGolden("tests/fixtures/goldens/cli/a-history.json", {
      exitCode: result.code,
      stdoutKeys: Object.keys(parsed).sort(),
    });
  });

  test("proposal list/show/diff — seeded proposal", async () => {
    const created = createProposal(stashDir, {
      ref: lessonRef(),
      source: "reflect",
      force: true,
      payload: {
        content:
          "---\ndescription: Prefer ripgrep over grep for repository searches\nwhen_to_use: Searching large repos\n---\n\nPrefer rg.\n",
      },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip seeding the family-A proposal fixture");

    const list = await runCli(["proposal", "list", "--format=json"]);
    expect(list.code).toBe(0);
    const show = await runCli(["proposal", "show", created.id, "--format=json"]);
    expect(show.code).toBe(0);
    const diff = await runCli(["proposal", "diff", created.id, "--format=json"]);
    expect(diff.code).toBe(0);

    expectGolden("tests/fixtures/goldens/cli/a-proposal.json", {
      list: { exitCode: list.code, stdoutKeys: Object.keys(JSON.parse(list.stdout)).sort() },
      show: { exitCode: show.code, stdoutKeys: Object.keys(JSON.parse(show.stdout)).sort() },
      diff: { exitCode: diff.code, stdoutKeys: Object.keys(JSON.parse(diff.stdout)).sort() },
    });
  });

  test("env list + secret list — redacted shapes (baseline only, never add redaction)", async () => {
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "API_URL=https://example\nTOKEN=topsecret-value\n");
    fs.mkdirSync(path.join(stashDir, "secrets"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "secrets", "deploy-key"), "super-secret-token-value");

    const envList = await runCli(["env", "list", "--format=json"]);
    expect(envList.code).toBe(0);
    expect(envList.stdout).not.toContain("topsecret-value");
    const secretList = await runCli(["secret", "list", "--format=json"]);
    expect(secretList.code).toBe(0);
    expect(secretList.stdout).not.toContain("super-secret-token-value");

    const envJson = JSON.parse(envList.stdout) as { envs: Array<Record<string, unknown>> };
    const secretJson = JSON.parse(secretList.stdout) as { secrets: Array<Record<string, unknown>> };
    expectGolden("tests/fixtures/goldens/cli/a-env-secret-list.json", {
      env: {
        exitCode: envList.code,
        stdoutKeys: Object.keys(envJson).sort(),
        entryKeys: Object.keys(envJson.envs[0] ?? {}).sort(),
      },
      secret: {
        exitCode: secretList.code,
        stdoutKeys: Object.keys(secretJson).sort(),
        entryKeys: Object.keys(secretJson.secrets[0] ?? {}).sort(),
      },
    });
  });

  test("events (akm log) list + tail --max-events 1", async () => {
    // "events" is the output-shape family name (`events-list`/`events-tail`,
    // src/output/shapes/events.ts); the actual CLI command group is `akm log`
    // (see src/commands/observability-cli.ts). DEVIATION from the brief's
    // literal `events list` / `events tail --limit 1` spelling: there is no
    // top-level `events` command and no `--limit` flag — the real surface is
    // `akm log list` / `akm log tail --max-events <n>`.
    await runCli(["remember", "an events fixture note", "--name", "events-fixture", "--format=json"]);
    const list = await runCli(["log", "list", "--format=json"]);
    expect(list.code).toBe(0);
    const tail = await runCli([
      "log",
      "tail",
      "--format=json",
      "--max-events",
      "1",
      "--max-duration-ms",
      "1000",
      "--interval-ms",
      "20",
    ]);
    expect(tail.code).toBe(0);

    const listJson = JSON.parse(list.stdout) as Record<string, unknown>;
    const tailJson = JSON.parse(tail.stdout) as Record<string, unknown>;
    expectGolden("tests/fixtures/goldens/cli/a-events.json", {
      list: { exitCode: list.code, stdoutKeys: Object.keys(listJson).sort() },
      tail: { exitCode: tail.code, stdoutKeys: Object.keys(tailJson).sort() },
    });
  });

  test("config list", async () => {
    const result = await runCli(["config", "list", "--format=json"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expectGolden("tests/fixtures/goldens/cli/a-config-list.json", {
      exitCode: result.code,
      stdoutKeys: Object.keys(parsed).sort(),
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Family D — argv-handling surfaces
// ─────────────────────────────────────────────────────────────────────────

describe("family D — argv-handling surfaces", () => {
  test("help migrate <version>", async () => {
    const result = await runCli(["help", "migrate", "0.6.0"]);
    expect(result.code).toBe(0);
    expectGolden(
      "tests/fixtures/goldens/cli/d-help-migrate.json",
      { exitCode: result.code, stdoutScrubbed: result.stdout },
      { stash: stashDir },
    );
  });

  test("help migrate --format json <version> — the SPACE-form --format collision", async () => {
    // resolveHelpMigrateVersionArg / wasHelpMigrateFlagValueConsumedAsVersion
    // (cli.ts:138-185): captured AS-IS, not as intended behavior. The
    // SPACE-separated form `--format json 0.6.0` trips the collision guard
    // (citty resolves an empty `version` positional here) and surfaces the
    // SAME MISSING_REQUIRED_ARGUMENT as passing no version at all — even
    // though a version token WAS supplied. The EQUALS form (`--format=json`)
    // and version-before-flag ordering do NOT collide (see the two
    // characterization cases captured alongside this one).
    const collision = await runCli(["help", "migrate", "--format", "json", "0.6.0"]);
    expect(collision.code).toBe(2);
    const collisionEnv = JSON.parse(collision.stderr);
    expect(collisionEnv.code).toBe("MISSING_REQUIRED_ARGUMENT");

    const equalsForm = await runCli(["help", "migrate", "--format=json", "0.6.0"]);
    expect(equalsForm.code).toBe(0);

    const versionFirst = await runCli(["help", "migrate", "0.6.0", "--format", "json"]);
    expect(versionFirst.code).toBe(0);

    expectGolden("tests/fixtures/goldens/cli/d-help-migrate-format-collision.json", {
      spaceFormCollision: { exitCode: collision.code, code: collisionEnv.code },
      equalsFormNoCollision: { exitCode: equalsForm.code },
      versionBeforeFlagNoCollision: { exitCode: versionFirst.code },
    });
  });

  test("help migrate --format=json (no version) → MISSING_REQUIRED_ARGUMENT", async () => {
    // Passing --format=json with NO trailing version at all must surface the
    // same structured usage error as the collision case above.
    const result = await runCli(["help", "migrate", "--format=json"]);
    expect(result.code).toBe(2);
    const parsed = JSON.parse(result.stderr);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("MISSING_REQUIRED_ARGUMENT");
    expectGolden("tests/fixtures/goldens/cli/d-help-migrate-missing-version.json", {
      exitCode: result.code,
      stderrKeys: Object.keys(parsed).sort(),
      code: parsed.code,
    });
  });

  test("--version", async () => {
    const result = await runCli(["--version"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
    expectGolden("tests/fixtures/goldens/cli/d-version.json", {
      exitCode: result.code,
      looksLikeSemver: /^\d+\.\d+\.\d+/.test(result.stdout.trim()),
    });
  });

  test("--help", async () => {
    const result = await runCli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("akm");
    expectGolden("tests/fixtures/goldens/cli/d-help.json", {
      exitCode: result.code,
      containsUsage: /usage/i.test(result.stdout),
      containsAkm: result.stdout.includes("akm"),
    });
  });

  test("proposal list --shape=summary → fail-fast INVALID_SHAPE_VALUE", async () => {
    // shapeForCommand (src/output/shapes.ts:124-137): 'summary' is registered
    // for 'show' only; every other command rejects it. runCliCapture skips the
    // real startup-block pre-check (cli.ts:659-668) but the shape-registry
    // gate inside output() is defense-in-depth and fires regardless (module
    // docstring at cli.ts around the startup block says as much).
    const result = await runCli(["proposal", "list", "--shape=summary", "--format=json"]);
    expect(result.code).toBe(2);
    const parsed = JSON.parse(result.stderr);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_SHAPE_VALUE");
    expectGolden("tests/fixtures/goldens/cli/d-shape-summary-gate.json", {
      exitCode: result.code,
      code: parsed.code,
    });
  });

  test("show <ref> lines 1 2 --format=text — normalizeShowArgv view-mode", async () => {
    writeFile("knowledge/lines-fixture.md", "# Heading\nline2\nline3\nline4\n");
    const result = await runCli(["show", "knowledge/lines-fixture.md", "lines", "1", "2", "--format=text"]);
    expect(result.code).toBe(0);
    expectGolden(
      "tests/fixtures/goldens/cli/d-show-lines-view.json",
      { exitCode: result.code, stdoutScrubbed: result.stdout },
      { stash: stashDir },
    );
  });

  test("setup --yes --no-init --dir <tmp>", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-cli-goldens-setup-"));
    try {
      // A tmpdir --dir trips the SETUP_TMP_STASH_REFUSED sandbox guard unless
      // explicitly opted into — this is a genuine test fixture, not a mistake.
      const result = await withEnv({ AKM_FORCE_SETUP_TMP_STASH: "1" }, () =>
        runCli(["setup", "--yes", "--no-init", "--dir", dir, "--format=json"]),
      );
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      // --no-init: configuration is written, but the stash dir is not scaffolded.
      expect(fs.existsSync(path.join(dir, "skills"))).toBe(false);
      expectGolden("tests/fixtures/goldens/cli/d-setup-no-init.json", {
        exitCode: result.code,
        stdoutKeys: Object.keys(parsed).sort(),
        stashScaffolded: fs.existsSync(path.join(dir, "skills")),
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--quiet search <term> — stderr suppression", async () => {
    const result = await runCli(["--quiet", "search", A_SCRIPT_NAME.replace(/\.sh$/, ""), "--format=json"]);
    expect(result.code).toBe(0);
    expectGolden("tests/fixtures/goldens/cli/d-quiet-search.json", {
      exitCode: result.code,
      stderrEmpty: result.stderr.trim() === "",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Family F — error envelopes
// ─────────────────────────────────────────────────────────────────────────

describe("family F — error envelopes", () => {
  test("show nonexistent:x → NotFoundError, exit 1", async () => {
    // A well-formed ref (valid asset type) pointing at a name that does not
    // exist — an UNKNOWN type (e.g. "nonexistent:x") is a UsageError
    // (MISSING_REQUIRED_ARGUMENT, exit 2) at ref-parse time, a different
    // family-F case than the not-found path this scenario targets.
    const result = await runCli(["show", "scripts/does-not-exist.sh", "--format=json"]);
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stderr);
    expect(parsed.ok).toBe(false);
    expectGolden("tests/fixtures/goldens/cli/f-not-found.json", {
      exitCode: result.code,
      stderrKeys: Object.keys(parsed).sort(),
      code: parsed.code,
    });
  });

  test("--format bogus → UsageError, exit 2", async () => {
    const result = await runCli(["search", "x", "--format", "bogus"]);
    expect(result.code).toBe(2);
    const parsed = JSON.parse(result.stderr);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_FORMAT_VALUE");
    expectGolden("tests/fixtures/goldens/cli/f-usage-error.json", {
      exitCode: result.code,
      stderrKeys: Object.keys(parsed).sort(),
      code: parsed.code,
    });
  });

  test("broken config.json → ConfigError, exit 78", async () => {
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "{ not valid json");
    const result = await runCli(["list", "--format=json"]);
    expect(result.code).toBe(78);
    const parsed = JSON.parse(result.stderr);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_CONFIG_FILE");
    expectGolden("tests/fixtures/goldens/cli/f-config-error.json", {
      exitCode: result.code,
      stderrKeys: Object.keys(parsed).sort(),
      code: parsed.code,
    });
  });

  test("raw throw-new-Error sites surface as ok:false envelopes (no `code`, exit 70)", async () => {
    // `lessons coverage` opens the index database directly (openExistingDatabase)
    // with no index present: a bare `throw new Error(...)` deep in better-sqlite3
    // escapes runWithJsonErrors uncaught by any AkmError branch, so
    // classifyExitCode falls through to INTERNAL(70) and the envelope carries
    // no `code` field (src/cli/shared.ts:83-92 only adds `code` for AkmError).
    const coverage = await runCli(["lessons", "coverage", "--format=json"]);
    expect(coverage.code).toBe(70);
    const coverageEnv = JSON.parse(coverage.stderr);
    expect(coverageEnv.ok).toBe(false);
    expect(coverageEnv.code).toBeUndefined();

    // `akm clone script:<name>` with no --name/--dest, source stash == dest
    // stash: source-clone.ts:152-154's self-clone guard is a bare
    // `throw new Error(...)`, not an AkmError, so it also maps to INTERNAL(70).
    const selfClone = await runCli(["clone", scriptRef(), "--format=json"]);
    expect(selfClone.code).toBe(70);
    const selfCloneEnv = JSON.parse(selfClone.stderr);
    expect(selfCloneEnv.ok).toBe(false);
    expect(selfCloneEnv.code).toBeUndefined();
    expect(selfCloneEnv.error).toContain("Source and destination are the same path");

    expectGolden("tests/fixtures/goldens/cli/f-raw-error-sites.json", {
      lessonsCoverage: { exitCode: coverage.code, stderrKeys: Object.keys(coverageEnv).sort() },
      selfClone: { exitCode: selfClone.code, stderrKeys: Object.keys(selfCloneEnv).sort() },
    });
  });
});
