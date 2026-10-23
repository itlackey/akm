import { describe, expect, test } from "bun:test";
import { parseEnvRef, parseSecretRef } from "../src/core/env-secret-ref";
import { UsageError } from "../src/core/errors";

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
    expect(() => parseSecretRef("gitea_token")).toThrow(UsageError);
    expect(() => parseSecretRef("gitea_token")).toThrow(/secrets\/<name>/);
  });

  test("a qualified bare name and a ref of the other type are usage errors too", () => {
    expect(() => parseEnvRef("team//prod")).toThrow(UsageError);
    expect(() => parseEnvRef("secrets/x")).toThrow(UsageError);
    expect(() => parseSecretRef("env/x")).toThrow(UsageError);
  });
});
