/**
 * Regression guard — `src/integrations/agent/**` does not import LLM SDKs.
 *
 * Locks v1 spec §9.7 (LLM/agent boundary) and §12 (CLI shell-out only).
 * Issue #222.
 *
 * **This test is defence-in-depth, not the primary enforcement.**
 *
 * The primary enforcement of the agent shell-out invariant is:
 *   1. The seam test in `agent-spawn-seam.test.ts`, which locks the
 *      `runAgent` interface.
 *   2. The TypeScript module graph — vendor SDKs are not in
 *      `package.json`, so an accidental import would fail to resolve at
 *      build time.
 *   3. Code review and the architectural boundary documented in
 *      `docs/technical/architecture.md`.
 *
 * The guard below scans file contents under `src/integrations/agent/`
 * for known LLM SDK package names. It exists to surface accidental
 * regressions in PRs (e.g. someone copies an example that pulls in a
 * vendor SDK before the type-check would catch it). The list is
 * intentionally narrow — it names specific vendor packages, not broad
 * patterns — so it does not flag legitimate code.
 *
 * Adding a new SDK package to the list (when a new vendor ships) is a
 * one-line change. Removing the test entirely is a contract violation:
 * agents are reachable only via the spawn wrapper.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const AGENT_DIR = path.join(REPO_ROOT, "src", "integrations", "agent");

/**
 * Specific vendor SDK package names whose presence in the agent
 * integration tree would indicate the shell-out invariant has been
 * crossed. The names are matched as quoted-import strings, not as
 * arbitrary substrings, so unrelated mentions in comments do not
 * trip the guard.
 */
const FORBIDDEN_LLM_SDK_PACKAGES: readonly string[] = [
  "@anthropic-ai/sdk",
  "@anthropic-ai/bedrock-sdk",
  "@anthropic-ai/vertex-sdk",
  "openai",
  "@google/generative-ai",
  "@google/genai",
  "@google-ai/generativelanguage",
  "cohere-ai",
  "@mistralai/mistralai",
  "@huggingface/inference",
  "groq-sdk",
  "ollama",
  "langchain",
  "@langchain/core",
  "@langchain/openai",
  "@langchain/anthropic",
  "ai",
  "replicate",
];

function listAgentSourceFiles(): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(abs);
    }
  }
  walk(AGENT_DIR);
  return out.sort();
}

/**
 * Match `from "<pkg>"` and `from '<pkg>'` and the equivalent
 * `import("<pkg>")` / `require("<pkg>")` forms. This is deliberately
 * a quoted-import match, not a free-text substring match, so writing
 * about a vendor SDK in a comment ("never imports `openai`") does not
 * trip the guard.
 */
function buildImportRegex(pkg: string): RegExp {
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${String.raw`(?:from|import\(|require\()\s*['"]` + escaped}(?:/[^'"]*)?['"]`);
}

describe("regression guard: src/integrations/agent/** never imports LLM SDKs", () => {
  test("the agent integration tree exists", () => {
    expect(fs.existsSync(AGENT_DIR)).toBe(true);
    const files = listAgentSourceFiles();
    expect(files.length).toBeGreaterThan(0);
  });

  test.each([...FORBIDDEN_LLM_SDK_PACKAGES])("no file imports %s", (pkg: string) => {
    const re = buildImportRegex(pkg);
    const offenders: string[] = [];
    for (const file of listAgentSourceFiles()) {
      const text = fs.readFileSync(file, "utf8");
      if (re.test(text)) {
        offenders.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
