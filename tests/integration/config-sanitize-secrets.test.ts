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
import os from "node:os";
import path from "node:path";
import type { AkmConfig } from "../../src/core/config/config";
import { saveConfig } from "../../src/core/config/config";

const tempDirs: string[] = [];
let stashDir = "";
let configDir = "";

function makeConfig(partial: Partial<AkmConfig>): AkmConfig {
  return {
    stashDir,
    semanticSearchMode: "off",
    ...partial,
  } as AkmConfig;
}

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "akm-sanitize-"));
  tempDirs.push(tmp);
  configDir = path.join(tmp, "config");
  stashDir = path.join(tmp, "stash");
  process.env.AKM_CONFIG_DIR = configDir;
  process.env.AKM_CACHE_DIR = path.join(tmp, "cache");
  process.env.AKM_DATA_DIR = path.join(tmp, "data");
  process.env.AKM_STATE_DIR = path.join(tmp, "state");
  process.env.AKM_STASH_DIR = stashDir;
  for (const d of [
    configDir,
    process.env.AKM_CACHE_DIR,
    process.env.AKM_DATA_DIR,
    process.env.AKM_STATE_DIR,
    stashDir,
  ]) {
    fs.mkdirSync(d, { recursive: true });
  }
});

afterEach(() => {
  for (const k of ["AKM_CONFIG_DIR", "AKM_CACHE_DIR", "AKM_DATA_DIR", "AKM_STATE_DIR", "AKM_STASH_DIR"]) {
    delete process.env[k];
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("sanitizeConfigForWrite — secret handling (#474)", () => {
  it("rejects literal embedding.apiKey before defensive sanitization", () => {
    expect(() =>
      saveConfig(
        makeConfig({
          embedding: {
            endpoint: "https://example.com",
            model: "text-embedding-3-small",
            apiKey: "sk-LITERAL-SECRET",
          },
        }),
      ),
    ).toThrow(/apiKey must be \$VAR/);
    expect(fs.existsSync(path.join(configDir, "config.json"))).toBe(false);
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
  it("rejects unsupported ${VAR:-default} syntax", () => {
    expect(() =>
      saveConfig(
        makeConfig({
          embedding: {
            endpoint: "https://example.com",
            model: "x",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: literal env-var reference under test
            apiKey: "${OPENAI_API_KEY:-fallback}",
          },
        }),
      ),
    ).toThrow(/apiKey must be \$VAR/);
  });

  it("rejects literal apiKey and preserves references across llm engines", () => {
    expect(() =>
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
      ),
    ).toThrow(/apiKey must be/);

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
    const persisted = fs.readFileSync(path.join(configDir, "config.json"), "utf8");
    expect(persisted).toContain("$OPENAI_API_KEY");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal env-var reference under test
    expect(persisted).toContain("${ANTHROPIC_API_KEY}");
  });
});
