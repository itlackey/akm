// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests-first contract for WP7's immutable executable projection.
 *
 * These fixtures pin the single common target shape emitted by every start.
 * The `executable` identity the fixtures carry is what older releases froze;
 * the decoder accepts it and drops it (the executable is resolved at dispatch).
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalJson } from "../../src/workflows/ir/plan-hash";
import { decodeWorkflowPlanV4 } from "../../src/workflows/ir/schema-v4";

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

const WORKFLOW_BYTES = "immutable executable workflow\n";
const WORKFLOW_IDENTITY = {
  ref: "fixture//workflows/immutable",
  bundle: "fixture",
  adapter: "akm",
  file: "workflows/immutable.md",
  hash: sha256(WORKFLOW_BYTES),
};

const CWD_IDENTITY = Object.freeze({
  requestedRoot: "/workspace",
  realRoot: "/workspace",
  rootDevice: "7",
  rootInode: "100",
  requestedCwd: "/workspace/project",
  realCwd: "/workspace/project",
  cwdDevice: "7",
  cwdInode: "101",
});

function executableIdentity(requested = "/bin/true") {
  const absolutePath = path.resolve(requested);
  const realPath = fs.realpathSync.native(absolutePath);
  const stat = fs.lstatSync(realPath, { bigint: true });
  return {
    requested,
    absolutePath,
    realPath,
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    size: Number(stat.size),
    sha256: sha256(fs.readFileSync(realPath)),
  };
}

function sourceSnapshot(identity = WORKFLOW_IDENTITY, ordinal = 1) {
  return {
    identity: structuredClone(identity),
    containmentPhysicalIdentity: `root-device:7/root-inode:${100 + ordinal}`,
    physicalIdentity: `file-device:7/file-inode:${200 + ordinal}`,
    size: identity === WORKFLOW_IDENTITY ? Buffer.byteLength(WORKFLOW_BYTES) : 1,
  };
}

function cwdTarget(overrides: Record<string, unknown> = {}) {
  const content = "Run the immutable request.";
  return {
    kind: "command",
    ref: null,
    contentHash: sha256(content),
    request: {
      schemaVersion: 1,
      command: { template: content, content, source: null },
      engine: { name: "cli", kind: "agent", platform: "claude" },
      authorization: { status: "not-required" },
      runtime: { workspace: "/workspace/project" },
      notices: [],
    },
    runner: {
      kind: "agent",
      engine: "cli",
      profile: {
        name: "cli",
        platform: "claude",
        bin: "/bin/true",
        args: [],
        stdio: "captured",
        envPassthrough: [],
        parseOutput: "text",
      },
      timeoutMs: null,
    },
    cwdIdentity: structuredClone(CWD_IDENTITY),
    executable: executableIdentity(),
    ...overrides,
  };
}

function commandPlan(options: { isolation?: "none" | "worktree"; target?: Record<string, unknown> } = {}) {
  const isolation = options.isolation ?? "none";
  const target = options.target ?? cwdTarget(isolation === "worktree" ? { gitCommitOid: "a".repeat(40) } : {});
  // F-A9 (docs/plans/specs/p3a-plan-v5-child-freeze.md §6): mechanical value
  // bump only, no assertion below this fixture builder changes. This plan is
  // fed to decodeWorkflowPlanV4 as `unknown`, so the literal here carries no
  // type-level consequence — it is red today only because the decoder still
  // requires exactly irVersion 4 and goes green once WORKFLOW_IR_V5_VERSION
  // lands; every executable/cwd/gitCommitOid assertion in this file is
  // otherwise untouched.
  return {
    irVersion: 5,
    title: "immutable",
    sourceReadSet: [sourceSnapshot()],
    execution: {
      maxConcurrency: 1,
    },
    steps: [
      {
        stepId: "run",
        title: "run",
        sequenceIndex: 0,
        root: {
          kind: "unit",
          id: "run",
          instructions: "the common frozen target is the only dispatch authority",
          frozenTarget: target,
          environment: [],
          onError: "fail",
          isolation,
        },
        gate: { kind: "gate", id: "run.gate", stepId: "run", criteria: [], maxLoops: 1, frozenJudge: null },
      },
    ],
  };
}

function rootTarget(plan: ReturnType<typeof commandPlan>): Record<string, unknown> {
  return rootUnit(plan).frozenTarget;
}

function rootUnit(plan: ReturnType<typeof commandPlan>) {
  const root = plan.steps[0]?.root;
  if (!root) throw new Error("fixture requires a root");
  return root;
}

describe("durable workflow v4 immutable executable schema", () => {
  test("keeps the cwd identity and worktree commit; an older release's executable identity is accepted and dropped", () => {
    const decoded = decodeWorkflowPlanV4(commandPlan({ isolation: "worktree" }));
    const root = decoded.steps[0]?.root;
    expect(root?.kind).toBe("unit");
    if (!root || root.kind !== "unit" || root.frozenTarget.kind !== "command") return;
    expect(root.frozenTarget).toMatchObject({ cwdIdentity: CWD_IDENTITY, gitCommitOid: "a".repeat(40) });
    expect(Object.hasOwn(root.frozenTarget, "executable")).toBe(false);

    // Even an identity that no longer matches the host binary decodes.
    const stale = commandPlan();
    rootTarget(stale).executable = { ...executableIdentity(), sha256: "0".repeat(64) };
    expect(() => decodeWorkflowPlanV4(stale)).not.toThrow();
  });

  test("requires a canonical Git OID exactly for worktree-isolated targets", () => {
    const missing = commandPlan({ isolation: "worktree", target: cwdTarget() });
    expect(() => decodeWorkflowPlanV4(missing)).toThrow(/gitCommitOid|git.*oid|worktree/i);

    for (const oid of ["A".repeat(40), "a".repeat(39), "g".repeat(40)]) {
      const invalid = commandPlan({ isolation: "worktree", target: cwdTarget({ gitCommitOid: oid }) });
      expect(() => decodeWorkflowPlanV4(invalid)).toThrow(/gitCommitOid|git.*oid|hex|worktree/i);
    }

    const unnecessary = commandPlan({ target: cwdTarget({ gitCommitOid: "b".repeat(64) }) });
    expect(() => decodeWorkflowPlanV4(unnecessary)).toThrow(/gitCommitOid|git.*oid|isolation|worktree/i);
  });

  test("accepts shell and script executable identities while retaining exact script bytes", () => {
    const shellExec = { command: ["/bin/sh", "-c", "printf shell"], timeoutMs: 30_000 };
    const shellEnvironment: never[] = [];
    const shell = commandPlan();
    const shellRoot = rootUnit(shell);
    shellRoot.environment = shellEnvironment;
    shellRoot.frozenTarget = {
      kind: "shell",
      contentHash: sha256(
        `akm.workflow.shell.v1\0${JSON.stringify({ cwdIdentity: CWD_IDENTITY, environment: shellEnvironment, exec: shellExec })}`,
      ),
      exec: shellExec,
      cwdIdentity: structuredClone(CWD_IDENTITY),
      executable: executableIdentity("/bin/sh"),
    };

    // Use the production canonicalizer for the shell hash rather than relying
    // on object insertion order in the fixture above.
    shellRoot.frozenTarget.contentHash = sha256(
      `akm.workflow.shell.v1\0${canonicalJson({ exec: shellExec, environment: shellEnvironment, cwdIdentity: CWD_IDENTITY })}`,
    );
    expect(() => decodeWorkflowPlanV4(shell)).not.toThrow();

    const scriptBytes = Buffer.from("#!/bin/sh\nprintf script\n", "utf8");
    const scriptIdentity = {
      ref: "fixture//scripts/tool.sh",
      bundle: "fixture",
      adapter: "akm",
      file: "scripts/tool.sh",
      hash: sha256(scriptBytes),
    };
    const script = structuredClone(shell);
    script.sourceReadSet = [
      { ...sourceSnapshot(scriptIdentity, 1), size: scriptBytes.byteLength },
      sourceSnapshot(WORKFLOW_IDENTITY, 2),
    ];
    rootUnit(script).frozenTarget = {
      kind: "script",
      ref: scriptIdentity.ref,
      contentHash: sha256(scriptBytes),
      exec: { command: ["/bin/sh"], timeoutMs: 30_000 },
      interpreter: "sh",
      extension: ".sh",
      bytesBase64: scriptBytes.toString("base64"),
      byteLength: scriptBytes.byteLength,
      cwdIdentity: structuredClone(CWD_IDENTITY),
      materialization: "ephemeral-0700-delete",
      executable: executableIdentity("/bin/sh"),
    };
    expect(() => decodeWorkflowPlanV4(script)).not.toThrow();
  });

  test("keeps an in-process SDK target free of a host executable requirement", () => {
    const content = "Use the frozen SDK request.";
    const sdk = commandPlan({
      target: {
        kind: "command",
        ref: null,
        contentHash: sha256(content),
        request: {
          schemaVersion: 1,
          command: { template: content, content, source: null },
          engine: { name: "sdk", kind: "sdk", platform: "opencode-sdk" },
          authorization: { status: "not-required" },
          runtime: {},
          notices: [],
        },
        runner: {
          kind: "sdk",
          engine: "sdk",
          profile: {
            name: "sdk",
            platform: "opencode-sdk",
            personaChannel: "native",
            bin: "opencode",
            args: [],
            stdio: "captured",
            envPassthrough: [],
            parseOutput: "text",
          },
          timeoutMs: null,
        },
      },
    });
    expect(() => decodeWorkflowPlanV4(sdk)).not.toThrow();
  });

  test("keeps a direct LLM target free of a host executable requirement", () => {
    const content = "Use the frozen LLM request.";
    const llm = commandPlan({
      target: {
        kind: "command",
        ref: null,
        contentHash: sha256(content),
        request: {
          schemaVersion: 1,
          command: { template: content, content, source: null },
          engine: {
            name: "fast",
            kind: "llm",
            platform: "openai-compatible",
          },
          model: { input: "frozen-model", interpretation: "exact", resolved: "frozen-model" },
          authorization: { status: "not-required" },
          runtime: {},
          notices: [],
        },
        runner: {
          kind: "llm",
          engine: "fast",
          connection: {
            endpoint: "https://example.invalid/v1/chat/completions",
            apiKeyEnv: null,
            headers: {},
            model: "frozen-model",
          },
          timeoutMs: null,
        },
      },
    });
    expect(() => decodeWorkflowPlanV4(llm)).not.toThrow();
  });
});
