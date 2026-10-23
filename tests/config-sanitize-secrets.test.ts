// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Regression suite for #474 — `akm setup --from --yes` silently strips
// API keys. The pre-fix sanitizeConfigForWrite dropped every apiKey
// (literal AND $\{VAR} reference) on every save without warning. The fix:
//   1. Preserve $\{VAR} / $VAR references — not secrets.
//   2. Strip literal values, but warn() so the user knows.

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

describe("sanitizeConfigForWrite — secret handling (#474)", () => {
  it("strips a literal embedding.apiKey at the write-time sanitizer, warning instead of rejecting the whole save", () => {
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
    expect(warnings.some((w) => w.includes("embedding.apiKey"))).toBe(true);
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

  it("preserves a secrets ref store reference", () => {
    saveConfig(
      makeConfig({
        embedding: {
          endpoint: "https://example.com",
          model: "x",
          apiKey: "${secrets/embed-key}",
        },
      }),
    );
    const persisted = fs.readFileSync(path.join(configDir, "config.json"), "utf8");
    expect(persisted).toContain("${secrets/embed-key}");
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
  it("treats unsupported ${VAR:-default} syntax as a literal and strips it at the sanitizer", () => {
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
    expect(persisted).not.toContain("${OPENAI_API_KEY:-fallback}");
    expect(warnings.some((w) => w.includes("embedding.apiKey"))).toBe(true);
  });

  it("strips a literal engine apiKey at the sanitizer and preserves references across llm engines", () => {
    const warnings = captureWarnings(() => {
      saveConfig(
        makeConfig({
          engines: {
            openai: {
              kind: "llm",
              endpoint: "https://api.openai.com/v1/chat/completions",
              model: "gpt-4",
              apiKey: "sk-openai-literal",
            },
          },
        }),
      );
    });
    let persisted = fs.readFileSync(path.join(configDir, "config.json"), "utf8");
    expect(persisted).not.toContain("sk-openai-literal");
    expect(warnings.some((w) => w.includes("engines.openai.apiKey"))).toBe(true);

    saveConfig(
      makeConfig({
        engines: {
          openai: {
            kind: "llm",
            endpoint: "https://api.openai.com/v1/chat/completions",
            model: "gpt-4",
            apiKey: "$OPENAI_API_KEY",
          },
          anthropic: {
            kind: "llm",
            endpoint: "https://api.anthropic.com/v1/chat/completions",
            model: "claude-opus-4-7",
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
