// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Workflow environments: env-asset VALUES are the one live input to a frozen
 * plan. Freeze records each ref's owner, exact key names, and secret-token
 * names — never a value or a value-derived hash; dispatch reads the current
 * values through those descriptors.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../../src/core/config/config";
import { materializeFrozenWorkflowEnvironment } from "../../src/workflows/exec/environment";
import { freezeEnvironment } from "../../src/workflows/freeze/environment";
import type { ResolutionContext } from "../../src/workflows/freeze/step-values";
import { canonicalJson } from "../../src/workflows/ir/plan-hash";
import type { FrozenWorkflowEnvironmentBinding } from "../../src/workflows/plan";
import { decodeWorkflowPlan } from "../../src/workflows/runtime/run-plan";
import type { WorkflowAsset } from "../../src/workflows/runtime/workflow-asset-loader";
import { makeSandboxDir, type SandboxedDir } from "../_helpers/sandbox";

const sandboxes: SandboxedDir[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0).reverse()) sandbox.cleanup();
});

function sandbox(prefix: string): string {
  const made = makeSandboxDir(prefix);
  sandboxes.push(made);
  return made.dir;
}

function write(root: string, relative: string, bytes: string): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return file;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function secretToken(name: string): string {
  return `\${secret:${name}}`;
}

/** Freeze `refs` as one step's `unit.env`, resolving each bundle to the given root. */
function freezeRefs(refs: string[], bundles: Record<string, string>): FrozenWorkflowEnvironmentBinding[] {
  const context: ResolutionContext = {
    asset: { ref: "alpha//workflows/env", path: "", sourcePath: "", title: "env" } as unknown as WorkflowAsset,
    config: {
      bundles: Object.fromEntries(Object.entries(bundles).map(([name, root]) => [name, { path: root }])),
    } as unknown as AkmConfig,
    plan: { irVersion: 6, title: "env", steps: [] },
    refPath: [],
    freezeChild: async () => {
      throw new Error("no child workflow in this fixture");
    },
  };
  return freezeEnvironment(
    { id: "run", unit: { env: refs }, source: { path: "workflows/env.md", start: 1, end: 1 } },
    undefined,
    context,
  );
}

function shellPlan(environment: unknown[]) {
  const root = "/workspace";
  const exec = { command: ["/bin/sh", "-lc", "printf safe"], timeoutMs: 30_000 };
  const directory = {
    requestedRoot: root,
    realRoot: root,
    rootDevice: "7",
    rootInode: "100",
    requestedCwd: root,
    realCwd: root,
    cwdDevice: "7",
    cwdInode: "100",
  };
  const contentHash = sha256(`akm.workflow.shell.v1\0${canonicalJson({ exec, environment, cwdIdentity: directory })}`);
  return {
    irVersion: 6,
    title: "symbolic environment",
    execution: { maxConcurrency: 1 },
    steps: [
      {
        stepId: "run",
        title: "run",
        sequenceIndex: 0,
        root: {
          kind: "unit",
          id: "run",
          instructions: "Run with the frozen symbolic environment.",
          frozenTarget: { kind: "shell", contentHash, exec, cwdIdentity: directory },
          environment,
          onError: "fail",
          isolation: "none",
        },
        gate: { kind: "gate", id: "run.gate", stepId: "run", criteria: [], maxLoops: 1, frozenJudge: null },
      },
    ],
  };
}

describe("stored plan environment bindings", () => {
  test("literal, pass-through, and env-ref entries decode unchanged", () => {
    const environment = [
      { kind: "literal", name: "REGION", value: "us-east-1" },
      { kind: "pass-through", name: "CARGO_HOME" },
      {
        kind: "env-ref",
        ref: "alpha//env/prod",
        owner: {
          bundle: "alpha",
          adapter: "akm",
          requestedRoot: "/root",
          requestedPath: "/root/env/prod.env",
          relativePath: "env/prod.env",
        },
        keys: ["API_TOKEN", "LOG_LEVEL"],
        secretNames: ["deploy-token"],
        precedence: 0,
      },
    ];
    const unit = decodeWorkflowPlan(shellPlan(environment)).steps[0]?.root;
    if (!unit || unit.kind !== "unit") throw new Error("expected a unit");
    expect(unit.environment as readonly unknown[]).toEqual(environment);
  });

  test("an unknown binding kind (the obsolete secret overload) is a plan this akm cannot run", () => {
    const oldOverload = [{ kind: "secret", name: "API_TOKEN", environmentVariable: "DEPLOY_TOKEN" }];
    expect(() => decodeWorkflowPlan(shellPlan(oldOverload))).toThrow(/unsupported kind/i);
  });
});

describe("freezing env refs", () => {
  test("records owner, exact sorted key names, token names, and precedence — never a value", () => {
    const root = sandbox("akm-env-freeze");
    const envValue = "db-password-must-never-enter-plan";
    const file = write(
      root,
      "env/prod.env",
      `LOG_LEVEL=info\nDATABASE_URL=postgres://user:${envValue}@db/prod\nAPI_TOKEN=Bearer ${secretToken("deploy-token")}\n`,
    );
    const descriptors = freezeRefs(["alpha//env/prod"], { alpha: root });
    const serialized = JSON.stringify(descriptors);

    expect(descriptors).toEqual([
      {
        kind: "env-ref",
        ref: "alpha//env/prod",
        owner: {
          bundle: "alpha",
          adapter: "akm",
          requestedRoot: path.resolve(root),
          requestedPath: path.resolve(file),
          relativePath: "env/prod.env",
        },
        keys: ["API_TOKEN", "DATABASE_URL", "LOG_LEVEL"],
        secretNames: ["deploy-token"],
        precedence: 0,
      },
    ]);
    expect(serialized).not.toContain(envValue);
    expect(serialized).not.toContain("postgres://");
    expect(serialized).not.toContain("Bearer ");
    expect(serialized).not.toContain(sha256(fs.readFileSync(file)));
  });

  test("refuses an env file that resolves outside its bundle, at freeze and at dispatch", () => {
    const outer = sandbox("akm-env-containment");
    const root = path.join(outer, "bundle");
    const outside = write(outer, "outside.env", "LEAK=yes\n");
    fs.mkdirSync(path.join(root, "env"), { recursive: true });
    fs.symlinkSync(outside, path.join(root, "env/escape.env"));
    expect(() => freezeRefs(["alpha//env/escape"], { alpha: root })).toThrow(/outside its owning root/);

    const file = write(root, "env/prod.env", "LEAK=no\n");
    const descriptors = freezeRefs(["alpha//env/prod"], { alpha: root });
    fs.rmSync(file);
    fs.symlinkSync(outside, file);
    expect(() => materializeFrozenWorkflowEnvironment(descriptors)).toThrow(/escapes its bundle/);
  });

  test("keeps authored ref order as precedence and drops a repeated ref", () => {
    const outer = sandbox("akm-env-precedence");
    const alpha = path.join(outer, "alpha");
    const omega = path.join(outer, "omega");
    write(alpha, "env/base.env", "SHARED=alpha\nALPHA_ONLY=yes\n");
    write(omega, "env/prod.env", "SHARED=omega\nOMEGA_ONLY=yes\n");
    const descriptors = freezeRefs(["omega//env/prod", "alpha//env/base", "omega//env/prod"], { alpha, omega });
    expect(
      descriptors.map((entry) =>
        entry.kind === "env-ref" ? { ref: entry.ref, precedence: entry.precedence, keys: entry.keys } : entry,
      ),
    ).toEqual([
      { ref: "omega//env/prod", precedence: 0, keys: ["OMEGA_ONLY", "SHARED"] },
      { ref: "alpha//env/base", precedence: 1, keys: ["ALPHA_ONLY", "SHARED"] },
    ]);
  });
});

describe("materializing a frozen environment", () => {
  test("reads current values only through frozen descriptors and returns value-free audits", () => {
    const root = sandbox("akm-env-materialize");
    const file = write(root, "env/prod.env", `LOG_LEVEL=old\nAPI_TOKEN=${secretToken("deploy-token")}\n`);
    const descriptors = freezeRefs(["alpha//env/prod"], { alpha: root });

    const currentToken = "github_pat_current_value_only_01234567890123456789";
    fs.writeFileSync(file, `API_TOKEN=Bearer ${secretToken("deploy-token")}\nLOG_LEVEL=current\n`, { mode: 0o600 });
    const materialized = materializeFrozenWorkflowEnvironment(descriptors, {
      readSecret: ({ name }) => (name === "deploy-token" ? currentToken : undefined),
    });
    const auditJson = JSON.stringify(materialized.audits);

    expect(materialized.values).toEqual({ API_TOKEN: `Bearer ${currentToken}`, LOG_LEVEL: "current" });
    expect(new Set(materialized.sensitiveValues)).toEqual(new Set([`Bearer ${currentToken}`, "current", currentToken]));
    expect(auditJson).toContain("alpha//env/prod");
    expect(auditJson).toContain("deploy-token");
    expect(auditJson).not.toContain(currentToken);
    expect(auditJson).not.toContain("current");
  });

  test("applies literal, pass-through, and env-ref precedence without ambient inheritance", () => {
    const descriptors: FrozenWorkflowEnvironmentBinding[] = [
      { kind: "literal", name: "SHARED", value: "literal" },
      { kind: "pass-through", name: "SHARED" },
      {
        kind: "env-ref",
        ref: "alpha//env/prod",
        owner: {
          bundle: "alpha",
          adapter: "akm",
          requestedRoot: "/frozen/root",
          requestedPath: "/frozen/root/env/prod.env",
          relativePath: "env/prod.env",
        },
        keys: ["ONLY_ENV", "SHARED"],
        secretNames: [],
        precedence: 2,
      },
    ];
    const reads: string[] = [];
    const materialized = materializeFrozenWorkflowEnvironment(descriptors, {
      readPassThrough: (name) => {
        reads.push(name);
        return "pass-through";
      },
      readEnvFile: () => "SHARED=env-ref\nONLY_ENV=present\n",
      readSecret: () => {
        throw new Error("no secret token was frozen");
      },
    });

    expect(reads).toEqual(["SHARED"]);
    expect(materialized.values).toEqual({ ONLY_ENV: "present", SHARED: "env-ref" });
    expect(materialized.values).not.toHaveProperty("HOME");
  });

  test("refuses an env file whose key set changed after freeze", () => {
    const root = sandbox("akm-env-keyset");
    const file = write(root, "env/prod.env", `LOG_LEVEL=old\nAPI_TOKEN=${secretToken("deploy-token")}\n`);
    const descriptors = freezeRefs(["alpha//env/prod"], { alpha: root });
    fs.writeFileSync(file, `LOG_LEVEL=new\nAPI_TOKEN=${secretToken("deploy-token")}\nEXTRA=injected\n`, {
      mode: 0o600,
    });
    expect(() => materializeFrozenWorkflowEnvironment(descriptors, { readSecret: () => "value" })).toThrow(
      /key set changed/,
    );
  });

  test("fails on a missing secret and never returns a partial value map", () => {
    const descriptors: FrozenWorkflowEnvironmentBinding[] = [
      { kind: "literal", name: "SAFE", value: "already-seen" },
      {
        kind: "env-ref",
        ref: "alpha//env/prod",
        owner: {
          bundle: "alpha",
          adapter: "akm",
          requestedRoot: "/missing/root",
          requestedPath: "/missing/root/env/prod.env",
          relativePath: "env/prod.env",
        },
        keys: ["TOKEN"],
        secretNames: ["missing-token"],
        precedence: 1,
      },
    ];
    let result: unknown;
    expect(() => {
      result = materializeFrozenWorkflowEnvironment(descriptors, {
        readEnvFile: () => `TOKEN=${secretToken("missing-token")}\n`,
        readSecret: () => undefined,
      });
    }).toThrow(/missing secret/);
    expect(result).toBeUndefined();
  });
});
