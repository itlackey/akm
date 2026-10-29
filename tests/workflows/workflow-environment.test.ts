// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Workflow environments: env-asset VALUES are the one live input to a frozen
 * plan. Freeze records each env ref, bundle-qualified, and its precedence —
 * never a value, a key name, a secret name or a path; dispatch reads the
 * current values through `resolveEnvBinding`
 * (tests/integration/workflows/workflow-environment-dispatch.test.ts).
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../../src/core/config/config";
import { freezeEnvironment } from "../../src/workflows/freeze/environment";
import type { ResolutionContext } from "../../src/workflows/freeze/step-values";
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

function secretToken(name: string): string {
  return `\${secrets/${name}}`;
}

/** Freeze `refs` as one step's `unit.env`, resolving each bundle to the given root. */
function freezeRefs(
  refs: string[],
  bundles: Record<string, string>,
  overrides: Record<string, Record<string, unknown>> = {},
): FrozenWorkflowEnvironmentBinding[] {
  const context: ResolutionContext = {
    asset: { ref: "alpha//workflows/env", path: "", sourcePath: "", title: "env" } as unknown as WorkflowAsset,
    config: {
      defaultBundle: Object.keys(bundles)[0],
      bundles: Object.fromEntries(
        Object.entries(bundles).map(([name, root]) => [name, { path: root, ...overrides[name] }]),
      ),
    } as unknown as AkmConfig,
    plan: { irVersion: 7, title: "env", steps: [] },
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
  const exec = { command: ["/bin/sh", "-lc", "printf safe"], timeoutMs: 30_000 };
  return {
    irVersion: 7,
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
          frozenTarget: { kind: "shell", contentHash: "0".repeat(64), exec },
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
      { kind: "env-ref", ref: "alpha//env/prod", precedence: 0 },
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
  test("an env ref does not resolve into a disabled bundle", () => {
    const alpha = sandbox("akm-env-enabled");
    const beta = sandbox("akm-env-disabled");
    write(alpha, "env/base.env", "A=1\n");
    write(beta, "env/prod.env", "B=2\n");
    expect(() => freezeRefs(["beta//env/prod"], { alpha, beta }, { beta: { enabled: false } })).toThrow(
      /was not found/,
    );
  });

  test("a unit that says env: [prod] fails at freeze naming env/prod", () => {
    const root = sandbox("akm-env-bare");
    write(root, "env/prod.env", "A=1\n");
    expect(() => freezeRefs(["prod"], { alpha: root })).toThrow(/Did you mean "env\/prod"\?/);
  });

  test("records the bundle-qualified ref and precedence — never a value, a key, a secret name or a path", () => {
    const root = sandbox("akm-env-freeze");
    const envValue = "db-password-must-never-enter-plan";
    write(
      root,
      "env/prod.env",
      `LOG_LEVEL=info\nDATABASE_URL=postgres://user:${envValue}@db/prod\nAPI_TOKEN=Bearer ${secretToken("deploy-token")}\n`,
    );
    const descriptors = freezeRefs(["env/prod"], { alpha: root });
    const serialized = JSON.stringify(descriptors);

    expect(descriptors).toEqual([{ kind: "env-ref", ref: "alpha//env/prod", precedence: 0 }]);
    for (const absent of [envValue, "postgres://", "Bearer ", "deploy-token", "API_TOKEN", root]) {
      expect(serialized).not.toContain(absent);
    }
  });

  test("keeps authored ref order as precedence and drops a repeated ref", () => {
    const outer = sandbox("akm-env-precedence");
    const alpha = path.join(outer, "alpha");
    const omega = path.join(outer, "omega");
    write(alpha, "env/base.env", "SHARED=alpha\nALPHA_ONLY=yes\n");
    write(omega, "env/prod.env", "SHARED=omega\nOMEGA_ONLY=yes\n");
    const descriptors = freezeRefs(["omega//env/prod", "alpha//env/base", "omega//env/prod"], { alpha, omega });
    expect(
      descriptors.map((entry) => (entry.kind === "env-ref" ? { ref: entry.ref, precedence: entry.precedence } : entry)),
    ).toEqual([
      { ref: "omega//env/prod", precedence: 0 },
      { ref: "alpha//env/base", precedence: 1 },
    ]);
  });
});
