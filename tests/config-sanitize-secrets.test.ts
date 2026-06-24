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
import { loadConfig, saveConfig } from "../src/core/config/config";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

let storage: IsolatedAkmStorage;
let stashDir = "";
/** The akm/ subdir of the isolated XDG config home, where config.json persists. */
let configDir = "";

function makeConfig(partial: Partial<AkmConfig>): AkmConfig {
  return {
    stashDir,
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
  it("strips literal embedding.apiKey", () => {
    saveConfig(
      makeConfig({
        embedding: {
          endpoint: "https://example.com",
          model: "text-embedding-3-small",
          apiKey: "sk-LITERAL-SECRET",
        },
      }),
    );
    const reloaded = loadConfig();
    expect(reloaded.embedding?.endpoint).toBe("https://example.com");
    expect(reloaded.embedding?.model).toBe("text-embedding-3-small");
    expect(reloaded.embedding?.apiKey).toBeUndefined();
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
  it("preserves ${VAR:-default} reference", () => {
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
    const persisted = fs.readFileSync(path.join(configDir, "config.json"), "utf8");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal env-var reference under test
    expect(persisted).toContain("${OPENAI_API_KEY:-fallback}");
  });

  it("strips literal apiKey across multiple llm profiles", () => {
    saveConfig(
      makeConfig({
        profiles: {
          llm: {
            openai: {
              endpoint: "https://api.openai.com",
              model: "gpt-4",
              apiKey: "sk-openai-literal",
            },
            anthropic: {
              endpoint: "https://api.anthropic.com",
              model: "claude-opus-4-7",
              // biome-ignore lint/suspicious/noTemplateCurlyInString: literal env-var reference under test
              apiKey: "${ANTHROPIC_API_KEY}",
            },
          },
        },
      }),
    );
    const persisted = fs.readFileSync(path.join(configDir, "config.json"), "utf8");
    expect(persisted).not.toContain("sk-openai-literal");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal env-var reference under test
    expect(persisted).toContain("${ANTHROPIC_API_KEY}");
  });
});
