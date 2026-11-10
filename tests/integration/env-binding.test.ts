import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resolveEnvBinding } from "../../src/commands/env/env-binding";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../src/core/warn";
import { materializeFrozenWorkflowEnvironment } from "../../src/workflows/exec/environment";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  makeStashDir,
  type SandboxedDir,
  withBundle,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../_helpers/sandbox";

describe("env-binding-symlinked-secret", () => {
  /**
   * Classification: opens a real database (`resolveEnvBinding` appends an
   * `env_access` event to state.db).
   *
   * A `${secrets/name}` token reads the secret even when that file is a symlink
   * to a file outside `secrets/` (installing a bundle is the trust decision).
   * A token whose body is not a well-formed ref (a `..` path) is plain text and
   * reads nothing.
   */

  const disposers: SandboxedDir[] = [];

  afterAll(() => {
    for (const d of disposers) d.cleanup();
    disposers.length = 0;
  });

  function stashWithEnv(envBody: string): { stash: string; outside: string } {
    const stash = makeStashDir();
    const outside = makeSandboxDir("akm-outside");
    disposers.push(stash, outside);
    fs.mkdirSync(path.join(stash.dir, "env"), { recursive: true });
    fs.mkdirSync(path.join(stash.dir, "secrets"), { recursive: true });
    fs.writeFileSync(path.join(stash.dir, "env", "prod.env"), envBody);
    return { stash: stash.dir, outside: outside.dir };
  }

  describe("resolveEnvBinding secret substitution", () => {
    test("substitutes a secret that is a symlink to a file outside secrets/", async () => {
      const { stash, outside } = stashWithEnv("TOKEN=${secrets/token}\n");
      fs.writeFileSync(path.join(outside, "real"), "s3cret");
      fs.symlinkSync(path.join(outside, "real"), path.join(stash, "secrets", "token"));

      const binding = await withBundle(stash, async () => resolveEnvBinding("env/prod"));
      expect(binding.values.TOKEN).toBe("s3cret");
      expect(binding.secretValues).toEqual(["s3cret"]);
    });

    test("a token with a '..' segment is not a ref, so nothing outside secrets/ is read", async () => {
      const { stash } = stashWithEnv("TOKEN=${secrets/../outside}\n");
      fs.writeFileSync(path.join(stash, "outside"), "leak");

      const binding = await withBundle(stash, async () => resolveEnvBinding("env/prod"));
      expect(binding.values.TOKEN).toBe("${secrets/../outside}");
      expect(binding.secretValues).toEqual([]);
    });
  });
});

describe("env-binding-legacy-secret", () => {
  /**
   * Classification: opens a real database (`resolveEnvBinding` appends an
   * `env_access` event to state.db).
   *
   * Env files written for 0.9 / early 0.10 spell a secret `${secret:NAME}`, which
   * meant "`secrets/NAME` in this env asset's own bundle". A reader tolerates it:
   * the token is read as `${<bundle>//secrets/NAME}` in memory, with one warning.
   */

  let storage: IsolatedAkmStorage;
  let team: string;
  let warnings: string[];

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    team = path.join(storage.root, "team");
    fs.mkdirSync(team, { recursive: true });
    writeSandboxConfig({ bundles: { team: { path: team } } });
    warnings = [];
    _resetWarnOnceForTests();
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args.join(" "));
    });
  });

  afterEach(() => {
    _setWarnSinkForTests(undefined);
    storage.cleanup();
  });

  function write(root: string, relative: string, bytes: string): void {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes, { mode: 0o600 });
  }

  describe("legacy ${secret:NAME} in an env value", () => {
    test("reads the secret in the env asset's own bundle, even when the default bundle has one of that name", () => {
      write(team, "env/bot.env", "TOKEN=${secret:x}\n");
      write(team, "secrets/x", "team-token\n");
      write(storage.stashDir, "secrets/x", "default-token\n");

      const binding = resolveEnvBinding("team//env/bot");

      expect(binding.values.TOKEN).toBe("team-token");
      expect(binding.secretValues).toEqual(["team-token"]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("team//env/bot");
      expect(warnings[0]).toContain("${team//secrets/x}");
    });

    test("warns once however many tokens and reads the env", () => {
      write(team, "env/bot.env", "A=${secret:x}\nB=${secret:x}-${secret:y}\n");
      write(team, "secrets/x", "1");
      write(team, "secrets/y", "2");

      resolveEnvBinding("team//env/bot");
      const second = resolveEnvBinding("team//env/bot");

      expect(second.values).toEqual({ A: "1", B: "1-2" });
      expect(warnings).toHaveLength(1);
    });

    test("a workflow env binding gets the same result", () => {
      write(team, "env/bot.env", "TOKEN=${secret:x}\n");
      write(team, "secrets/x", "team-token");
      write(storage.stashDir, "secrets/x", "default-token");

      const materialized = materializeFrozenWorkflowEnvironment([
        {
          kind: "env-ref",
          ref: "team//env/bot",
          precedence: 0,
        },
      ]);

      expect(materialized.values).toEqual({ TOKEN: "team-token" });
      expect(materialized.sensitiveValues).toEqual(["team-token"]);
    });
  });
});
