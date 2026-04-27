/**
 * Config-load contract for `llm.features.*` (v1 spec §14, #227).
 *
 * Locks:
 *   - All seven locked keys parse through into the runtime `LlmFeatureFlags`.
 *   - Defaults are absent (interpreted as `false` at every call site —
 *     `isLlmFeatureEnabled` is the seam, see tests/llm-feature-gate.test.ts).
 *   - Non-boolean values are warn-and-skipped (no throw, the rest of the
 *     features block continues to parse).
 *   - Unknown keys are warn-and-skipped (no throw, no schema mutation).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getConfigPath, loadConfig, resetConfigCache } from "../src/core/config";

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalHome = process.env.HOME;
let testConfigHome = "";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "akm-cfg-llm-features-"));
}

function writeConfig(content: object): void {
  const cfgPath = getConfigPath();
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(content));
}

beforeEach(() => {
  testConfigHome = makeTmpDir();
  process.env.XDG_CONFIG_HOME = testConfigHome;
  resetConfigCache();
});

afterEach(() => {
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  if (testConfigHome) {
    fs.rmSync(testConfigHome, { recursive: true, force: true });
    testConfigHome = "";
  }
  resetConfigCache();
});

describe("loadConfig — llm.features (v1 spec §14)", () => {
  test("parses all seven locked feature keys", () => {
    writeConfig({
      llm: {
        endpoint: "http://localhost:11434/v1/chat/completions",
        model: "llama3.2",
        features: {
          curate_rerank: true,
          tag_dedup: true,
          memory_consolidation: true,
          feedback_distillation: true,
          embedding_fallback_score: true,
          memory_inference: true,
          graph_extraction: true,
        },
      },
    });
    const cfg = loadConfig();
    expect(cfg.llm?.features).toEqual({
      curate_rerank: true,
      tag_dedup: true,
      memory_consolidation: true,
      feedback_distillation: true,
      embedding_fallback_score: true,
      memory_inference: true,
      graph_extraction: true,
    });
  });

  test("absent keys remain absent (default-false at call sites)", () => {
    writeConfig({
      llm: {
        endpoint: "http://localhost:11434/v1/chat/completions",
        model: "llama3.2",
        features: { curate_rerank: true },
      },
    });
    const cfg = loadConfig();
    expect(cfg.llm?.features?.curate_rerank).toBe(true);
    expect(cfg.llm?.features?.tag_dedup).toBeUndefined();
    expect(cfg.llm?.features?.memory_consolidation).toBeUndefined();
    expect(cfg.llm?.features?.feedback_distillation).toBeUndefined();
    expect(cfg.llm?.features?.embedding_fallback_score).toBeUndefined();
  });

  test("non-boolean values warn and are skipped without breaking siblings", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeConfig({
        llm: {
          endpoint: "http://localhost:11434/v1/chat/completions",
          model: "llama3.2",
          features: {
            curate_rerank: "yes" as unknown as boolean,
            tag_dedup: 1 as unknown as boolean,
            feedback_distillation: true,
          },
        },
      });
      const cfg = loadConfig();
      expect(cfg.llm?.features?.curate_rerank).toBeUndefined();
      expect(cfg.llm?.features?.tag_dedup).toBeUndefined();
      // The valid sibling continues to parse.
      expect(cfg.llm?.features?.feedback_distillation).toBe(true);
      const messages = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes("curate_rerank") && m.includes("expected boolean"))).toBe(true);
      expect(messages.some((m) => m.includes("tag_dedup") && m.includes("expected boolean"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("unknown keys warn and are dropped without affecting locked keys", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeConfig({
        llm: {
          endpoint: "http://localhost:11434/v1/chat/completions",
          model: "llama3.2",
          features: {
            curate_rerank: true,
            // Unknown keys must be warn-and-ignore (v1 spec §14.3).
            future_feature: true,
            another_one: false,
          } as Record<string, boolean>,
        },
      });
      const cfg = loadConfig();
      expect(cfg.llm?.features?.curate_rerank).toBe(true);
      expect((cfg.llm?.features as Record<string, unknown> | undefined)?.future_feature).toBeUndefined();
      expect((cfg.llm?.features as Record<string, unknown> | undefined)?.another_one).toBeUndefined();
      const messages = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes("future_feature") && m.includes("Ignoring"))).toBe(true);
      expect(messages.some((m) => m.includes("another_one") && m.includes("Ignoring"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
