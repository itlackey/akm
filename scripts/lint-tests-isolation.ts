#!/usr/bin/env bun
/**
 * Lint job: enforce the test-isolation harness contract.
 *
 * The harness in `tests/_preload.ts` owns process state mutations that
 * cross tests — `HOME`, `process.cwd()`, and `globalThis.fetch`. New test
 * files should:
 *
 *   - Set `HOME` via the sandbox; the harness already isolates it.
 *     If a test legitimately needs a different HOME, it can still mutate
 *     `process.env.HOME` because the harness restores it — but new code
 *     should prefer the helper to keep the contract visible.
 *   - Avoid `process.chdir()` where possible. Tests that must chdir need
 *     to restore cwd in a `finally` block (the harness restores cwd
 *     automatically but the tripwire fires regardless).
 *   - Use `withMockedFetch` from `tests/_helpers/sandbox` rather than
 *     mutating `globalThis.fetch` directly.
 *
 * This script flags new occurrences of the raw patterns. Existing files
 * are allow-listed during the migration; any addition to the allow-list
 * is a deliberate signal that the file pre-dated the harness.
 */

import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const TESTS_ROOT = path.join(REPO_ROOT, "tests");

interface Rule {
  name: string;
  pattern: RegExp;
  // Files allowed to use this pattern (pre-harness offenders). New
  // additions to this list should be reviewed; new tests should not
  // appear here at all.
  allowList: ReadonlySet<string>;
  guidance: string;
}

const RULES: readonly Rule[] = [
  {
    name: "process.env.HOME =",
    pattern: /process\.env\.HOME\s*=/,
    allowList: new Set([
      "tests/agent/agent-config-loader.test.ts",
      "tests/common.test.ts",
      "tests/config.test.ts",
      "tests/e2e.test.ts",
      "tests/init.test.ts",
      "tests/paths.test.ts",
      "tests/ripgrep-install.test.ts",
      "tests/setup-tmp-stash-guard.test.ts",
      "tests/setup.test.ts",
      "tests/source.test.ts",
    ]),
    guidance: "Use the sandbox HOME provided by tests/_preload.ts; HOME is snapshotted and restored automatically.",
  },
  {
    name: "process.chdir(",
    pattern: /process\.chdir\(/,
    allowList: new Set(["tests/config.test.ts", "tests/registry-install.test.ts"]),
    guidance: "Avoid mutating cwd; if unavoidable, restore in a `finally` block.",
  },
  {
    name: "globalThis.fetch =",
    pattern: /globalThis\.fetch\s*=/,
    allowList: new Set([
      "tests/e2e.test.ts",
      "tests/indexer.test.ts",
      "tests/registry-install.test.ts",
      "tests/self-update.test.ts",
      "tests/source-providers/website.test.ts",
    ]),
    guidance: "Use `withMockedFetch` from tests/_helpers/sandbox — it restores fetch before the harness tripwire fires.",
  },
];

const HARNESS_FILES: ReadonlySet<string> = new Set(["tests/_preload.ts", "tests/_helpers/sandbox.ts"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx"))) out.push(full);
  }
  return out;
}

function relTo(file: string): string {
  return path.relative(REPO_ROOT, file).replaceAll(path.sep, "/");
}

let violations = 0;
const newOffenders: Record<string, string[]> = {};

for (const abs of walk(TESTS_ROOT)) {
  const rel = relTo(abs);
  if (HARNESS_FILES.has(rel)) continue;
  const text = fs.readFileSync(abs, "utf8");
  for (const rule of RULES) {
    if (!rule.pattern.test(text)) continue;
    if (rule.allowList.has(rel)) continue;
    (newOffenders[rule.name] ??= []).push(rel);
    violations++;
  }
}

if (violations > 0) {
  console.error("test-isolation-harness lint: new violations detected");
  console.error("");
  for (const [ruleName, files] of Object.entries(newOffenders)) {
    const rule = RULES.find((r) => r.name === ruleName);
    console.error(`  ${ruleName}`);
    if (rule) console.error(`    ${rule.guidance}`);
    for (const file of files) console.error(`    - ${file}`);
    console.error("");
  }
  console.error(
    "If this addition is intentional (i.e. a file that pre-dates the harness contract), append it to the rule's allow-list in scripts/lint-tests-isolation.ts.",
  );
  process.exit(1);
}

console.log(`test-isolation-harness lint: ${RULES.length} rules checked, no new violations.`);
