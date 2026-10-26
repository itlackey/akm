// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Which values a task log scrubs, and — just as load-bearing — which it does
 * not (issue #755).
 *
 * The failure this guards against in BOTH directions: a configured secret
 * echoed by a scheduled command was persisted verbatim, and the obvious fix
 * (treat every env value as secret) would have turned ordinary
 * build output into `[REDACTED]` confetti. The over-redaction cases below are
 * not padding — they are the reason the collector is shaped the way it is.
 */

import { describe, expect, test } from "bun:test";
import { redactSensitiveText } from "../../src/core/redaction";
import {
  collectTaskLogSensitiveValues,
  isInferredSecretName,
  MIN_INFERRED_SECRET_LENGTH,
} from "../../src/tasks/log-redaction";
import { scrubDbLines } from "../../src/tasks/run/task-log";

describe("secret-name inference (#755)", () => {
  test("matches credential-ish names without swallowing ordinary configuration", () => {
    for (const name of [
      "GH_TOKEN",
      "NPM_AUTH_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "MY_API_KEY",
      "PGPASSWORD",
      "DB_PASS",
      "GOOGLE_CREDENTIALS",
      "api_key",
    ]) {
      expect(isInferredSecretName(name)).toBe(true);
    }
    // A heuristic that fires on these would redact the operator's own prose.
    // MONKEY and BYPASS are why the keyword must be a whole `_`-delimited word
    // rather than merely a suffix; KEYBOARD_LAYOUT is why it cannot be a prefix.
    for (const name of [
      "KEYBOARD_LAYOUT",
      "AUTHOR",
      "PASSAGE",
      "MONKEY",
      "BYPASS",
      "TOKENIZER",
      "PATH",
      "HOME",
      "SHLVL",
      "PWD",
    ]) {
      expect(isInferredSecretName(name)).toBe(false);
    }
  });

  test("glued credential names are enumerated, since no boundary rule can see them", () => {
    // Loosening the pattern enough to catch these would also catch MONKEY.
    expect(isInferredSecretName("PGPASSWORD")).toBe(true);
    expect(isInferredSecretName("MYSQL_PWD")).toBe(true);
  });
});

describe("collectTaskLogSensitiveValues (#755)", () => {
  test("collects a config-declared connection credential at any length", () => {
    const values = collectTaskLogSensitiveValues({
      env: { MAIN_KEY: "xy" },
      config: {
        connections: { main: { endpoint: "https://api.example.com", models: { fast: "m" }, apiKey: "$MAIN_KEY" } },
      },
    });
    // Two characters — a DECLARED secret has no length floor, because the
    // operator told us what it is rather than akm guessing.
    expect(values).toContain("xy");
  });

  test("collects the embedding key the connection collector does not cover", () => {
    const declared = collectTaskLogSensitiveValues({
      env: { CUSTOM_EMBED: "embed-secret-value" },
      config: { embedding: { apiKey: "${CUSTOM_EMBED}" } },
    });
    expect(declared).toContain("embed-secret-value");

    const implicit = collectTaskLogSensitiveValues({
      env: { AKM_EMBED_API_KEY: "implicit-embed-secret" },
      config: {},
    });
    expect(implicit).toContain("implicit-embed-secret");
  });

  test("collects a task-declared name at any length, and ignores one that is unset", () => {
    const values = collectTaskLogSensitiveValues({
      env: { ACME_DEPLOY: "s3cret" },
      declaredNames: ["ACME_DEPLOY", "NEVER_EXPORTED"],
    });
    expect(values).toContain("s3cret"); // 6 chars, under the inferred floor
    expect(values).not.toContain(undefined as unknown as string);
  });

  test("infers an ambient credential from its name once it clears the floor", () => {
    const values = collectTaskLogSensitiveValues({ env: { ACME_TOKEN: "abcdefghij" } });
    expect(values).toContain("abcdefghij");
  });

  test("does NOT infer a short value — the floor applies to guesses only", () => {
    const values = collectTaskLogSensitiveValues({ env: { ACME_TOKEN: "short" } });
    expect(values).not.toContain("short");
    expect("short".length).toBeLessThan(MIN_INFERRED_SECRET_LENGTH);
  });

  test("leaves ordinary environment values alone, however long", () => {
    // The regression the naive fix would cause. Every one of these is longer
    // than the floor; none is a credential, and redacting any of them mangles
    // the log the operator is reading.
    const env = {
      PWD: "/home/user/akm",
      SHELL: "/bin/bash",
      LANG: "en_US.UTF-8",
      SHLVL: "1",
      TERM: "xterm-256color",
      NODE_VERSION: "24.3.0",
      CI: "true",
      npm_config_registry: "https://registry.npmjs.org/",
    };
    expect(collectTaskLogSensitiveValues({ env })).toEqual([]);
  });

  test("end to end: the secret goes, the log survives", () => {
    const env = {
      ACME_DEPLOY_TOKEN: "quietly-ordinary-looking-value",
      PWD: "/home/user/akm",
      SHLVL: "1",
      TERM: "xterm-256color",
    };
    const values = collectTaskLogSensitiveValues({ env, declaredNames: ["ACME_DEPLOY_TOKEN"] });
    const output = redactSensitiveText(
      "Build finished in 12.4s\n3 tests passed, 0 failed\ndeploying with quietly-ordinary-looking-value\nwrote dist/index.js (48 KB)",
      values,
    );
    expect(output).not.toContain("quietly-ordinary-looking-value");
    expect(output).toContain("Build finished in 12.4s");
    expect(output).toContain("3 tests passed, 0 failed");
    expect(output).toContain("wrote dist/index.js (48 KB)");
  });
});

describe("multi-line secrets reach BOTH sinks", () => {
  // #755 scrubbed the flat .log (one contiguous string) and the logs.db rows,
  // but the rows were split on "\n" BEFORE redaction while the needles are whole
  // env values. A needle containing a newline can never match inside one line,
  // so a PEM key was scrubbed from the file and written verbatim into logs.db —
  // the primary record per #579, kept for the whole retention window, and past
  // the explicit `redact:` opt-in this release documents as the escape hatch.
  const PEM = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEowIBAAKCAQEA1exampleexamplekeymaterial",
    "Zq9xK2mQ7vLpTnExampleSecondLineOfKey",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");

  const scrubFor = (declaredNames: string[]) => {
    const values = collectTaskLogSensitiveValues({ env: { DEPLOY_KEY: PEM }, declaredNames });
    return (text: string) => redactSensitiveText(text, values);
  };

  test("a per-line scrub cannot match a needle that spans lines", () => {
    const scrub = scrubFor(["DEPLOY_KEY"]);
    const perLine = PEM.split("\n").map(scrub);
    expect(perLine.join("\n")).toContain("MIIEowIBAAKCAQEA1exampleexamplekeymaterial");
  });

  test("scrubDbLines redacts it by rejoining the rows first", () => {
    const scrub = scrubFor(["DEPLOY_KEY"]);
    const rows = PEM.split("\n").map((line) => ({ stream: "stdout" as const, level: "info" as const, line }));
    const out = scrubDbLines(rows, scrub);
    const text = out.map((row) => row.line).join("\n");
    expect(text).not.toContain("MIIEowIBAAKCAQEA1exampleexamplekeymaterial");
    expect(text).not.toContain("Zq9xK2mQ7vLpTnExampleSecondLineOfKey");
  });

  test("the inferred tier covers it too, not just an explicit redact:", () => {
    const scrub = scrubFor([]);
    const rows = PEM.split("\n").map((line) => ({ stream: "stdout" as const, level: "info" as const, line }));
    const text = scrubDbLines(rows, scrub)
      .map((row) => row.line)
      .join("\n");
    expect(text).not.toContain("MIIEowIBAAKCAQEA1exampleexamplekeymaterial");
  });

  test("surrounding output survives and stream/level are preserved", () => {
    const scrub = scrubFor(["DEPLOY_KEY"]);
    const rows = [
      { stream: "stdout" as const, level: "info" as const, line: "starting deploy" },
      ...PEM.split("\n").map((line) => ({ stream: "stdout" as const, level: "info" as const, line })),
      { stream: "stderr" as const, level: "error" as const, line: "deploy failed" },
    ];
    const out = scrubDbLines(rows, scrub);
    expect(out.map((row) => row.line)).toContain("starting deploy");
    expect(out.map((row) => row.line)).toContain("deploy failed");
    expect(out.find((row) => row.line === "deploy failed")?.stream).toBe("stderr");
    expect(out.find((row) => row.line === "deploy failed")?.level).toBe("error");
    expect(out.some((row) => row.line.includes("MIIEowIBAAKCAQEA1"))).toBe(false);
  });
});
