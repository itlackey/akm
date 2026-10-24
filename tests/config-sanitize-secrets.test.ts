// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Regression suite for #474 — `akm setup --from --yes` silently stripped API
// keys. A `$VAR` / `${VAR}` reference is not a secret and is kept; a literal key
// is read as absent (warned about once) and so never reaches the file.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../src/core/config/config";
import { saveConfig } from "../src/core/config/config";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

function captureWarnings(fn: () => void): string[] {
  const warnings: string[] = [];
  _resetWarnOnceForTests();
  _setWarnSinkForTests((level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
  try {
    fn();
    return warnings;
  } finally {
    _setWarnSinkForTests(undefined);
  }
}

let storage: IsolatedAkmStorage;
let stashDir = "";
let configDir = "";

function makeConfig(partial: Partial<AkmConfig>): AkmConfig {
  return {
    bundles: { stash: { path: stashDir, writable: true } } as AkmConfig["bundles"],
    defaultBundle: "stash",
    semanticSearchMode: "off",
    ...partial,
  } as AkmConfig;
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  stashDir = storage.stashDir;
  configDir = path.join(storage.configDir, "akm");
});

afterEach(() => {
  storage.cleanup();
});

describe("config writes — secret handling (#474)", () => {
  it("never writes a literal embedding.apiKey, warning instead of rejecting the whole save", () => {
    const warnings = captureWarnings(() => {
      saveConfig(
        makeConfig({
          embedding: {
            endpoint: "https://example.com",
            model: "text-embedding-3-small",
            apiKey: "sk-LITERAL-SECRET",
          },
        }),
      );
    });
    const persisted = fs.readFileSync(path.join(configDir, "config.json"), "utf8");
    expect(persisted).not.toContain("sk-LITERAL-SECRET");
    expect(warnings.some((w) => w.includes("literal apiKey"))).toBe(true);
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal env-var reference syntax under test
  it("preserves ${VAR} embedding.apiKey reference", () => {
    saveConfig(
      makeConfig({
        embedding: {
          endpoint: "https://example.com",
          model: "text-embedding-3-small",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal env-var reference under test
          apiKey: "${OPENAI_API_KEY}",
        },
      }),
    );
    const persisted = fs.readFileSync(path.join(configDir, "config.json"), "utf8");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal env-var reference under test
    expect(persisted).toContain("${OPENAI_API_KEY}");
  });

  it("does not keep a secrets ref as a key: akm reads keys from $VAR or credentials.json only", () => {
    const warnings = captureWarnings(() => {
      saveConfig(
        makeConfig({
          embedding: {
            endpoint: "https://example.com",
            model: "x",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: literal secret reference under test
            apiKey: "${secrets/embed-key}",
          },
        }),
      );
    });
    const persisted = fs.readFileSync(path.join(configDir, "config.json"), "utf8");
    expect(persisted).not.toContain("embed-key");
    expect(warnings.some((w) => w.includes("apiKey"))).toBe(true);
  });

  it("preserves $VAR (no braces) reference", () => {
    saveConfig(
      makeConfig({
        embedding: {
          endpoint: "https://example.com",
          model: "x",
          apiKey: "$OPENAI_API_KEY",
        },
      }),
    );
    const persisted = fs.readFileSync(path.join(configDir, "config.json"), "utf8");
    expect(persisted).toContain("$OPENAI_API_KEY");
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal env-var reference syntax under test
  it("treats unsupported ${VAR:-default} syntax as a literal and drops it", () => {
    const warnings = captureWarnings(() => {
      saveConfig(
        makeConfig({
          embedding: {
            endpoint: "https://example.com",
            model: "x",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: literal env-var reference under test
            apiKey: "${OPENAI_API_KEY:-fallback}",
          },
        }),
      );
    });
    const persisted = fs.readFileSync(path.join(configDir, "config.json"), "utf8");
    expect(persisted).not.toContain("OPENAI_API_KEY:-fallback");
    expect(warnings.some((w) => w.includes("apiKey"))).toBe(true);
  });

  it("drops a literal connection apiKey and preserves references across connections", () => {
    const warnings = captureWarnings(() => {
      saveConfig(
        makeConfig({
          connections: {
            openai: {
              endpoint: "https://api.openai.com/v1",
              models: { fast: "gpt-4" },
              apiKey: "sk-openai-literal",
            },
          },
        }),
      );
    });
    let persisted = fs.readFileSync(path.join(configDir, "config.json"), "utf8");
    expect(persisted).not.toContain("sk-openai-literal");
    expect(warnings.some((w) => w.includes("literal apiKey"))).toBe(true);

    saveConfig(
      makeConfig({
        connections: {
          openai: { endpoint: "https://api.openai.com/v1", models: { fast: "gpt-4" }, apiKey: "$OPENAI_API_KEY" },
          anthropic: {
            endpoint: "https://api.anthropic.com/v1",
            models: { fast: "claude-opus-4-7" },
            // biome-ignore lint/suspicious/noTemplateCurlyInString: literal env-var reference under test
            apiKey: "${ANTHROPIC_API_KEY}",
          },
        },
      }),
    );
    persisted = fs.readFileSync(path.join(configDir, "config.json"), "utf8");
    expect(persisted).toContain("$OPENAI_API_KEY");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal env-var reference under test
    expect(persisted).toContain("${ANTHROPIC_API_KEY}");
  });
});
