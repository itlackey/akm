// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The pure task-source migration planner (`src/tasks/source/task-to-v4.ts`),
 * v2 side: every v2 fixture and inline case, planned straight to v4 with no
 * intermediate v3 file ever written or reported. Mirrors
 * `tests/tasks/migrate-v3-to-v4.test.ts`'s style, driven off the same v2
 * fixture corpus (tests/fixtures/execution-contracts/tasks/v2/,
 * deterministic|blocked, manifest.json) the former two-generation chain
 * (task-to-v3.ts -> task-to-v4.ts) used.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { planTaskFilesMigration } from "../../scripts/akm-migrate/migrate/task-files";
import { parseTaskV3Yaml } from "../../src/tasks/source/task-source-v3-frozen";
import { parseTaskSourceV4 } from "../../src/tasks/source/task-source-v4";
import { planTaskToV4File, type TaskToV4FileInput } from "../../src/tasks/source/task-to-v4";
import {
  assertFixtureBytesUnchanged,
  captureFixtureBytes,
  EXECUTION_CONTRACT_FIXTURES,
} from "../_helpers/execution-contracts";

const ROOT = path.join(EXECUTION_CONTRACT_FIXTURES, "tasks/v2");

interface Manifest {
  deterministic: Array<{ id: string; file: string; preserves: string[] }>;
  blocked: Array<{ id: string; file: string; reasonCode: string }>;
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")) as Manifest;

/**
 * "workflow-ref-full" converts cleanly to a v3 shape (a `workflows/` target
 * with a `with:` block from its v2 `params:`) — but v4 accepts `with:` only
 * on a command target (`uses: commands/<ref>` or `uses: akm/command`); a
 * `with:` block on any other target has no v4 equivalent
 * ("with-on-non-command-target", the same rule a real v3 file with this
 * shape hits — see migrate-v3-to-v4.test.ts). It is the one manifest fixture
 * whose v2-to-v3 success does not carry through to v4.
 */
const V4_BLOCKED_DETERMINISTIC: Record<string, string> = {
  "workflow-ref-full": "with-on-non-command-target",
};

function input(file: string): TaskToV4FileInput {
  const filePath = path.join(ROOT, file);
  return { filePath, bytes: fs.readFileSync(filePath), mode: 0o640, writable: true };
}

function memoryInput(yaml: string, overrides: Partial<TaskToV4FileInput> = {}): TaskToV4FileInput {
  return {
    filePath: "/bundle/tasks/memory.yml",
    bytes: Buffer.from(yaml),
    mode: 0o640,
    writable: true,
    ...overrides,
  };
}

describe("pure task-source migration planner — v2 straight to v4", () => {
  test("converts every deterministic fixture straight to v4 and validates the emitted bytes through the production v4 parser, except the one fixture whose v3 shape has no v4 equivalent", () => {
    const before = captureFixtureBytes(ROOT);
    for (const entry of manifest.deterministic) {
      const outcome = planTaskToV4File(input(entry.file));
      expect(outcome.before.equals(fs.readFileSync(path.join(ROOT, entry.file))), entry.file).toBe(true);
      const v4BlockedReason = V4_BLOCKED_DETERMINISTIC[entry.id];
      if (v4BlockedReason) {
        expect(outcome.status, entry.file).toBe("blocked");
        expect(outcome.reason, entry.file).toBe(v4BlockedReason);
        continue;
      }
      expect(outcome.status, entry.file).toBe("changed");
      if (outcome.status !== "changed") throw new Error(`expected changed: ${entry.file}`);
      expect(outcome.reason).toBe("task-converted");
      const parsed = parseTaskSourceV4({ yaml: outcome.after.toString("utf8"), filePath: outcome.filePath });
      expect(parsed.version).toBe(4);
      expect(outcome.after.equals(outcome.before)).toBe(false);
    }
    assertFixtureBytesUnchanged(ROOT, before);
  });

  test("maps inline prompt, command ref, and safe command strings to the exact v4 spellings; a workflow target with with: blocks instead", () => {
    const inline = planTaskToV4File(input("deterministic/prompt-inline-full.yml"));
    const commandRef = planTaskToV4File(input("deterministic/prompt-command-ref.yml"));
    const workflow = planTaskToV4File(input("deterministic/workflow-ref-full.yml"));
    const run = planTaskToV4File(input("deterministic/command-string.yml"));
    for (const outcome of [inline, commandRef, run]) {
      if (outcome.status !== "changed") throw new Error(`expected changed ${outcome.filePath}`);
    }
    expect(workflow.status).toBe("blocked");
    expect(workflow.reason).toBe("with-on-non-command-target");

    expect(parseYaml((inline as { after: Buffer }).after.toString("utf8"))).toEqual({
      version: 4,
      name: "Contract review prompt",
      uses: "akm/command",
      with: {
        content: "Review the execution contract.\nReturn the literal marker contract-reviewed.",
      },
      schedule: "15 4 * * 1",
      description: "Exercises every exactly preservable v2 prompt override",
      when_to_use: "Run during the execution-contract conformance pass",
      tags: ["contract", "review"],
      engine: "fixture-llm",
      model: "fixture-exact-model",
      inference: {
        temperature: 0,
        maxTokens: 256,
        supportsJsonSchema: false,
        extraParams: { seed: 7 },
        contextLength: 4096,
        enableThinking: false,
      },
      timeout: 45000,
      redact: ["CONTRACT_FIXTURE_TOKEN"],
    });
    // v2 `enabled: false` never carries to v4 (no source-owned enablement, #987) —
    // confirmed absent, not merely unchecked, on the fixture that authored it.
    expect(Object.hasOwn(parseYaml((inline as { after: Buffer }).after.toString("utf8")), "enabled")).toBe(false);
    expect(parseYaml((commandRef as { after: Buffer }).after.toString("utf8"))).toEqual({
      version: 4,
      uses: "commands/contract-review",
      schedule: "@daily",
      engine: "fixture-agent",
      model: "fixture-exact-model",
      timeout: 45000,
    });
    expect(parseYaml((run as { after: Buffer }).after.toString("utf8"))).toEqual({
      version: 4,
      run: "akm index --full",
      schedule: "@hourly",
      timeout: 45000,
      redact: ["CONTRACT_FIXTURE_TOKEN"],
    });
  });

  test("blocks every ambiguous fixture with its stable catalog reason and leaves bytes untouched", () => {
    const before = captureFixtureBytes(ROOT);
    for (const entry of manifest.blocked) {
      const outcome = planTaskToV4File(input(entry.file));
      expect(outcome.status, entry.file).toBe("blocked");
      expect(outcome.reason, entry.file).toBe(entry.reasonCode);
      expect(outcome.before.equals(fs.readFileSync(path.join(ROOT, entry.file))), entry.file).toBe(true);
    }
    assertFixtureBytesUnchanged(ROOT, before);
  });

  // #902: the reason code alone ("argv-array-has-no-portable-shell-string")
  // names a cause, not a remedy — the blocked outcome must also carry an
  // actionable `detail` telling the operator manual conversion is required
  // and what to change (v2 array `command:` -> v4 `run:` string + `shell:`).
  test("names the argv-array block's remedy, not just its reason (#902)", () => {
    const outcome = planTaskToV4File(memoryInput("version: 2\nschedule: '@daily'\ncommand: [echo, hi]\n"));
    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toBe("argv-array-has-no-portable-shell-string");
    expect(outcome.detail).toMatch(/manual conversion/i);
    expect(outcome.detail).toContain("run:");
    expect(outcome.detail).toContain("shell:");
  });

  test.each([
    "FOO=bar echo ok",
    "if true",
    ". profile",
    "time echo ok",
    "x=y",
    "echo ok",
    "custom-tool arg",
  ])("blocks v2 command text whose literal argv would acquire shell semantics: %s", (command) => {
    const outcome = planTaskToV4File(
      memoryInput(`version: 2\nschedule: '@daily'\ncommand: ${JSON.stringify(command)}\n`),
    );
    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toMatch(/shell|argv|assignment|builtin|reserved/i);
  });

  // #867 (real-data regression): a `command:` string starting with `env
  // NAME=value... cmd args...` was blocked as
  // "shell-command-resolution-changes-v2-literal-argv-semantics" because
  // `env` itself, not the command env wraps, was checked against
  // `shellStableV2Executable`. env(1) does its own PATH-search exec of its
  // target regardless of whether env itself was launched by direct execve
  // (v2) or a host shell (v3 `run:`), so that check does not apply to
  // whatever follows a leading `env` + assignments. These are the exact
  // failing command shapes from a real 0.9.4 install (GH #867).
  test.each([
    "env AKM_BIN=/home/user/.nvm/versions/node/v24.18.0/bin/akm /home/user/.bun/bin/bun /home/user/akm/scripts/akm-dogfood-0.9.1.ts collect",
    "env AKM_BIN=/home/user/.nvm/versions/node/v24.18.0/bin/akm /home/user/.nvm/versions/node/v24.18.0/bin/akm env run env/fwdslsh -- bun /home/user/akm/scripts/akm-health-discord.ts",
    "env LLM_API_KEY=local /home/user/.nvm/versions/node/v24.18.0/bin/akm env run env/marketing-seo-social -- /home/user/.nvm/versions/node/v24.18.0/bin/akm env run env/dimm-city -- bash /home/user/akm/skills/social-media/social-complaint-listener/scripts/dc-leads-pipeline.sh",
    "env AKM_BIN=/home/user/.nvm/versions/node/v24.18.0/bin/akm bash /home/user/akm/scripts/discord/wiki-articles-ingest.sh",
  ])("converts a real-world env-prefixed v2 command like any other command string: %s", (command) => {
    const outcome = planTaskToV4File(
      memoryInput(`version: 2\nschedule: '@daily'\ncommand: ${JSON.stringify(command)}\n`),
    );
    expect(outcome.status).toBe("changed");
    if (outcome.status !== "changed") throw new Error(outcome.detail ?? outcome.reason);
    expect(parseYaml(outcome.after.toString("utf8"))).toMatchObject({ run: command });
  });

  test("blocks `env` with nothing left to exec after its assignments", () => {
    const outcome = planTaskToV4File(memoryInput("version: 2\nschedule: '@daily'\ncommand: env FOO=bar\n"));
    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toMatch(/shell|argv|assignment|builtin|reserved/i);
  });

  test("converts the command-env-prefix fixture to the exact expected v4 spelling", () => {
    const outcome = planTaskToV4File(input("deterministic/command-env-prefix.yml"));
    expect(outcome.status).toBe("changed");
    if (outcome.status !== "changed") throw new Error(outcome.detail ?? outcome.reason);
    expect(parseYaml(outcome.after.toString("utf8"))).toEqual({
      version: 4,
      run: "env AKM_BIN=/opt/akm/bin/akm bash /opt/akm/scripts/wiki-articles-ingest.sh",
      schedule: "@hourly",
      timeout: 45000,
      redact: ["CONTRACT_FIXTURE_TOKEN"],
    });
  });

  test("keeps explicit executable paths in the provable argv-compatible command subset", () => {
    const outcome = planTaskToV4File(memoryInput("version: 2\nschedule: '@daily'\ncommand: ./tools/check --exact\n"));
    expect(outcome.status).toBe("changed");
    if (outcome.status !== "changed") throw new Error(outcome.detail ?? outcome.reason);
    expect(parseYaml(outcome.after.toString("utf8"))).toMatchObject({ run: "./tools/check --exact" });
  });

  test("a v3 run: containing a GitHub-style ${{ }} expression is accepted verbatim by the frozen v3 reader — akm has no expander on this path", () => {
    const parsed = parseTaskV3Yaml({
      yaml: 'version: 3\nrun: "echo runs-on ${{ matrix.os }}"\nakm:\n  schedule: "@daily"\n',
      filePath: "/bundle/tasks/x.yml",
    });
    expect(parsed.target).toEqual({ kind: "run", run: "echo runs-on ${{ matrix.os }}" });
  });

  test("classifies each file as changed or blocked, whatever version it declares", () => {
    const alreadyV3 = Buffer.from("version: 3\nuses: commands/review\nakm:\n  schedule: '@daily'\n");
    const files = [
      input("deterministic/command-string.yml"),
      { filePath: "/z/already.yml", bytes: alreadyV3, mode: 0o600, writable: true },
      input("blocked/command-argv.yml"),
    ];
    expect(files.map((file) => planTaskToV4File(file)).map(({ status, reason }) => [status, reason])).toEqual([
      ["changed", "task-converted"],
      ["changed", "task-converted"],
      ["blocked", "argv-array-has-no-portable-shell-string"],
    ]);
  });

  test("the sole v2 migration reader rejects target-illegal fields instead of dropping them", () => {
    const outcome = planTaskToV4File(
      memoryInput("version: 2\nschedule: '@daily'\nworkflow: workflows/release\nengine: must-not-be-dropped\n"),
    );
    expect(outcome).toMatchObject({ status: "blocked", reason: "invalid-v2-task" });
    expect(outcome.detail).toMatch(/not valid|engine/i);
  });

  // The workflow target's `params:` becomes v4 `with:`, and any `with:` on a
  // non-command target blocks (see the "maps inline..." test above) — so
  // this exercises the same null/duplicate normalization on a workflow
  // target that never sets `params:` at all (no `with:` means no block).
  test("preserves v2 null/duplicate normalization exactly (no with: means no with-on-non-command-target block)", () => {
    const outcome = planTaskToV4File(
      memoryInput(
        [
          "version: 2",
          "schedule: '@daily'",
          "workflow: workflows/release",
          "timeoutMs: null",
          "maxSteps: null",
          "maxRetries: null",
          "redact: [TOKEN, TOKEN]",
          "",
        ].join("\n"),
      ),
    );
    expect(outcome.status).toBe("changed");
    if (outcome.status !== "changed") throw new Error(outcome.detail ?? outcome.reason);
    expect(parseYaml(outcome.after.toString("utf8"))).toEqual({
      version: 4,
      uses: "workflows/release",
      schedule: "@daily",
      timeout: null,
      redact: ["TOKEN"],
    });
  });

  // A workflow target's `params: {}` — authored, not merely absent — becomes
  // v4 `with: {}`, which still blocks: v4 accepts `with:` only on a command
  // target, the same rule a real v3 file hits (see "maps inline..." above).
  test("an authored empty params: {} on a workflow target still blocks — with: is with:, even when empty", () => {
    const outcome = planTaskToV4File(
      memoryInput("version: 2\nschedule: '@daily'\nworkflow: workflows/release\nparams: {}\n"),
    );
    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toBe("with-on-non-command-target");
  });

  test("rejects deeply nested v2 YAML at the source boundary before conversion", () => {
    let nested = "leaf: value\n";
    for (let index = 0; index < 70; index += 1) nested = `level${index}:\n${nested.replace(/^/gm, "  ")}`;
    const deep = planTaskToV4File(
      memoryInput(
        `version: 2\nschedule: '@daily'\nworkflow: workflows/release\nparams:\n${nested.replace(/^/gm, "  ")}`,
      ),
    );
    expect(deep).toMatchObject({ status: "blocked", reason: "invalid-task-yaml" });
    expect(deep.detail).toMatch(/depth|nesting/i);
  });

  test("validates an already-v3 working directory against its inspected component root", () => {
    if (process.platform === "win32") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-v3-contained-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "akm-v3-outside-"));
    fs.symlinkSync(outside, path.join(root, "escape"), "dir");
    try {
      const outcome = planTaskToV4File(
        memoryInput("version: 3\nrun: echo exact\nworking-directory: escape\nakm:\n  schedule: '@daily'\n", {
          filePath: path.join(root, "task.yml"),
          containmentRoot: root,
        }),
      );
      expect(outcome).toMatchObject({ status: "blocked", reason: "invalid-v3-task" });
      expect(outcome.detail).toMatch(/outside|contain|escape/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("migrate's plan generation commits to mode/configured and on-disk writability while duplicate paths fail closed", () => {
    const source = memoryInput("version: 2\nschedule: '@daily'\ncommand: akm index\n");
    const normal = planTaskFilesMigration([source]);
    const differentMode = planTaskFilesMigration([{ ...source, mode: 0o600 }]);
    const readOnly = planTaskFilesMigration([{ ...source, writable: false }]);
    const diskReadOnly = planTaskFilesMigration([{ ...source, onDiskWritable: false }]);
    expect(differentMode.generation).not.toBe(normal.generation);
    expect(readOnly.generation).not.toBe(normal.generation);
    expect(diskReadOnly.generation).not.toBe(normal.generation);
    expect(() => planTaskFilesMigration([source, { ...source }])).toThrow(/duplicate|file path/i);
  });
});
