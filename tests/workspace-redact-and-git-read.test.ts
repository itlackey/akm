// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Pure helpers behind the workspace operations: config redaction and commit origin. */

import { describe, expect, test } from "bun:test";
import { redactUrlCredentials } from "../src/core/redaction";
import { type ChangeOrigin, classifyCommitOrigin } from "../src/workspace/git-read";
import { isSecretEnvName, redactForUi, scrubUrlCredentials } from "../src/workspace/redact";

// biome-ignore lint/suspicious/noExplicitAny: redacted trees are asserted field by field below
type Json = Record<string, any>;

describe("redactForUi", () => {
  test("masks secret-like string values by key, keeps symbolic references and numbers", () => {
    const redacted = redactForUi({
      connections: {
        a: { apiKey: "sk-live-1", apiKeyFile: "/run/key", maxTokens: 4096, model: "m" },
        b: { apiKey: "$B_KEY", credential: "${secrets/deploy}" },
      },
      webhookToken: "tok",
      password: "pw",
      authorization: "Bearer x",
    }) as Json;
    expect(redacted.connections.a.apiKey).toBe("[redacted]");
    expect(redacted.connections.a.maxTokens).toBe(4096);
    expect(redacted.connections.a.model).toBe("m");
    expect(redacted.connections.b).toEqual({ apiKey: "$B_KEY", credential: "${secrets/deploy}" });
    expect(redacted.webhookToken).toBe("[redacted]");
    expect(redacted.password).toBe("[redacted]");
    expect(redacted.authorization).toBe("[redacted]");
  });

  test("masks every value under an env or secrets key", () => {
    const redacted = redactForUi({ run: { env: { FOO: "bar", N: 3, ok: true } }, secrets: ["a", "b"] }) as Json;
    expect(redacted.run.env).toEqual({ FOO: "[redacted]", N: "[redacted]", ok: "[redacted]" });
    expect(redacted.secrets).toEqual(["[redacted]", "[redacted]"]);
  });
});

describe("URL credentials", () => {
  test("userinfo and credential query parameters are masked; other URLs are untouched", () => {
    expect(redactUrlCredentials("https://user:pw@example.com/path")).toBe("https://example.com/path");
    expect(redactUrlCredentials("https://example.com/v1?token=abc&q=1")).toBe(
      "https://example.com/v1?token=%5Bredacted%5D&q=1",
    );
    expect(redactUrlCredentials("https://example.com/v1?q=1")).toBe("https://example.com/v1?q=1");
    expect(redactUrlCredentials("not a url")).toBe("not a url");
  });

  test("scrubUrlCredentials finds URLs inside longer strings, at any depth", () => {
    const scrubbed = scrubUrlCredentials({
      a: [{ b: "llm default: https://h.test/x?api_key=SECRET (see docs)" }],
      n: 1,
    });
    expect(JSON.stringify(scrubbed)).not.toContain("SECRET");
    expect(JSON.stringify(scrubbed)).toContain("llm default: https://h.test/x?api_key=");
  });

  test("environment variable names that hold credentials are recognised", () => {
    expect(isSecretEnvName("AKM_LLM_API_KEY")).toBe(true);
    expect(isSecretEnvName("AKM_BUNDLE_DIR")).toBe(false);
  });
});

describe("classifyCommitOrigin", () => {
  test.each<[string, ChangeOrigin]>([
    ["akm improve auto-sync", "improve-sync"],
    ["akm improve pre-run sync", "improve-sync"],
    ["akm accept: consolidate ee66bc2f akm//knowledge/x", "accept"],
    ["akm proposal drain: 37 accepted (consolidate-pair 30, consolidate 7)", "accept"],
    ["akm save 2026-10-16 14:54:50", "sync"],
    ["akm sync: merge origin upstream", "sync"],
    ["akm remember: vpn note", "remember"],
    ["retire 16 junk assets", "other"],
  ])("%s -> %s", (subject, origin) => {
    expect(classifyCommitOrigin(subject)).toBe(origin);
  });
});
