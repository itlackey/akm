/**
 * Classification: opens a real database (`resolveEnvBinding` appends an
 * `env_access` event to state.db).
 *
 * A frozen env binding is materialized at dispatch through `resolveEnvBinding`,
 * the same machinery `akm env run` uses. Freeze records only the env ref; the
 * file, the `${ref}` tokens in it and the secrets they name are read live, so
 * an edit between freeze and dispatch is picked up and only the substituted
 * secret values are marked sensitive.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { readEvents } from "../../../src/core/events";
import { materializeFrozenWorkflowEnvironment } from "../../../src/workflows/exec/environment";
import type { FrozenWorkflowEnvironmentBinding } from "../../../src/workflows/plan";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let other: string;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  other = path.join(storage.root, "other");
  fs.mkdirSync(other, { recursive: true });
  writeSandboxConfig({ bundles: { other: { path: other } } });
});

afterEach(() => storage.cleanup());

function write(root: string, relative: string, bytes: string): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return file;
}

/** What freeze writes today. Dispatch reads only `ref`; the rest is left stale on purpose. */
function envRef(ref: string, precedence = 0): FrozenWorkflowEnvironmentBinding {
  return {
    kind: "env-ref",
    ref,
    owner: {
      bundle: "gone",
      adapter: "akm",
      requestedRoot: "/gone",
      requestedPath: "/gone/env/x.env",
      relativePath: "env/x.env",
    },
    keys: ["FROZEN_ONLY"],
    secretNames: ["frozen-only"],
    precedence,
  };
}

describe("materializing a frozen environment at dispatch", () => {
  test("configuration passes through unredacted; only a value substituted from a secret is sensitive", () => {
    write(storage.stashDir, "env/hook.env", "URL=https://hooks.example.test/1\nTOKEN=Bearer ${secrets/hook-token}\n");
    write(storage.stashDir, "secrets/hook-token", "tok-123\n");

    const materialized = materializeFrozenWorkflowEnvironment([envRef("env/hook")]);

    expect(materialized.values).toEqual({ URL: "https://hooks.example.test/1", TOKEN: "Bearer tok-123" });
    expect(materialized.sensitiveValues).toEqual(["tok-123"]);
  });

  test("a ${bundle//secrets/…} token resolves in another bundle, and a script ref yields its path", () => {
    const script = write(other, "scripts/fetch.sh", "#!/bin/sh\n");
    write(other, "secrets/t", "other-token");
    write(storage.stashDir, "env/hook.env", "TOKEN=${other//secrets/t}\nTOOL=${other//scripts/fetch.sh}\n");

    const materialized = materializeFrozenWorkflowEnvironment([envRef("env/hook")]);

    expect(materialized.values).toEqual({ TOKEN: "other-token", TOOL: script });
    expect(materialized.sensitiveValues).toEqual(["other-token"]);
  });

  test("a secret no bundle owns fails the whole materialization and returns nothing", () => {
    write(storage.stashDir, "env/ok.env", "SAFE=1\n");
    write(storage.stashDir, "env/hook.env", "TOKEN=${secrets/absent}\n");
    let result: unknown;
    expect(() => {
      result = materializeFrozenWorkflowEnvironment([envRef("env/ok", 0), envRef("env/hook", 1)]);
    }).toThrow(/secrets\/absent/);
    expect(result).toBeUndefined();
  });

  test("an edit to the env file after freeze is picked up: no key-set drift error", () => {
    const file = write(storage.stashDir, "env/prod.env", "LOG_LEVEL=old\n");
    const frozen = [envRef("env/prod")];
    fs.writeFileSync(file, "LOG_LEVEL=new\nEXTRA=added-after-freeze\n");

    expect(materializeFrozenWorkflowEnvironment(frozen).values).toEqual({
      LOG_LEVEL: "new",
      EXTRA: "added-after-freeze",
    });
  });

  test("later precedence wins; literals bind but are not sensitive; pass-through names are neither bound nor sensitive", () => {
    write(storage.stashDir, "env/base.env", "SHARED=base\nBASE_ONLY=1\n");
    write(other, "env/over.env", "SHARED=over\n");
    const materialized = materializeFrozenWorkflowEnvironment([
      { kind: "literal", name: "REGION", value: "us-east-1" },
      { kind: "pass-through", name: "PASSED" },
      envRef("env/base", 2),
      envRef("other//env/over", 3),
    ]);

    expect(materialized.values).toEqual({ REGION: "us-east-1", SHARED: "over", BASE_ONLY: "1" });
    expect(materialized.sensitiveValues).toEqual([]);
  });

  test("each read records an env_access event with key names only", () => {
    write(storage.stashDir, "env/prod.env", "API_TOKEN=${secrets/leaked-if-logged}\n");
    write(storage.stashDir, "secrets/leaked-if-logged", "value-that-must-not-be-audited");

    materializeFrozenWorkflowEnvironment([envRef("env/prod")]);

    const dump = JSON.stringify(readEvents({}).events);
    expect(dump).toContain("env_access");
    expect(dump).toContain("API_TOKEN");
    expect(dump).not.toContain("value-that-must-not-be-audited");
  });
});
