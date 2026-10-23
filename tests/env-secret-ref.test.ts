import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/core/config/config";
import { isInstalledBundle, parseEnvRef, parseSecretRef } from "../src/core/env-secret-ref";
import { UsageError } from "../src/core/errors";
import { resolveSourceEntries } from "../src/indexer/search/search-source";
import { makeStashDir, withEnv, writeSandboxConfig } from "./_helpers/sandbox";

describe("env and secret refs are full akm refs", () => {
  test("a full ref parses, with or without a bundle", () => {
    expect(parseEnvRef("env/prod")).toEqual({ type: "env", name: "prod", origin: undefined });
    expect(parseEnvRef("team//env/staging/prod")).toEqual({ type: "env", name: "staging/prod", origin: "team" });
    expect(parseSecretRef("secrets/gitea_token")).toEqual({ type: "secret", name: "gitea_token", origin: undefined });
    expect(parseSecretRef("team//secrets/gitea_token")).toEqual({
      type: "secret",
      name: "gitea_token",
      origin: "team",
    });
  });

  test("a bare name is a usage error that names the full form", () => {
    expect(() => parseEnvRef("prod")).toThrow(UsageError);
    expect(() => parseEnvRef("prod")).toThrow(/env\/<name>/);
    expect(() => parseEnvRef("prod")).toThrow(/Did you mean "env\/prod"\?/);
    expect(() => parseSecretRef("gitea_token")).toThrow(UsageError);
    expect(() => parseSecretRef("gitea_token")).toThrow(/secrets\/<name>/);
    expect(() => parseSecretRef("gitea_token")).toThrow(/Did you mean "secrets\/gitea_token"\?/);
  });

  test("a qualified bare name and a ref of the other type are usage errors too", () => {
    expect(() => parseEnvRef("team//prod")).toThrow(UsageError);
    expect(() => parseEnvRef("team//prod")).toThrow(/Did you mean "team\/\/env\/prod"\?/);
    expect(() => parseEnvRef("secrets/x")).toThrow(UsageError);
    expect(() => parseSecretRef("env/x")).toThrow(UsageError);
  });
});

describe("isInstalledBundle", () => {
  test("an unreadable source set answers not installed instead of throwing", async () => {
    const stash = makeStashDir();
    try {
      writeSandboxConfig({ bundles: { mine: { path: stash.dir, enabled: false } } });
      await withEnv({ AKM_BUNDLE_DIR: stash.dir }, async () => {
        expect(() => resolveSourceEntries(undefined, loadConfig())).toThrow(/disabled/);
        expect(isInstalledBundle("mine")).toBe(false);
      });
    } finally {
      stash.cleanup();
    }
  });
});
