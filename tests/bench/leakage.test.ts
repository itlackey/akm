/**
 * Leakage smoke test for the seeded bench corpus (spec §7.4).
 *
 * Gated behind `AKM_BENCH_FIXTURE_TESTS=1`. This is a corpus-content
 * validator (it inspects the seeded fixture stashes and verifier files,
 * not the bench framework code itself), so it ships skipped by default —
 * matching the `AKM_SEMANTIC_TESTS` / `AKM_DOCKER_TESTS` pattern. Run it
 * locally when you change a fixture stash or a verifier:
 *
 *   AKM_BENCH_FIXTURE_TESTS=1 bun test tests/bench/leakage.test.ts
 *
 * For every task that declares a `gold_ref` of the form `skill:<name>`,
 * locate the SKILL.md inside the named fixture stash and assert that the
 * verifier's *structural assertions* do not appear verbatim in the gold-ref
 * content. The gold ref is allowed (and expected) to discuss the topic in
 * general terms — what it must NOT do is hand the agent a copy-pasteable
 * fragment that satisfies the verifier directly.
 *
 * The check extracts:
 *   • for `regex` verifiers — the literal segments of `expected_match`
 *     between regex meta-characters (these are the substrings the agent
 *     must produce);
 *   • for `pytest` verifiers — Python-style structural assertion paths and
 *     dictionary lookups (e.g., `services.redis.healthcheck.test`,
 *     `redis["healthcheck"]["test"]`);
 *   • for `script` (shell) verifiers — single-quoted `grep` patterns and
 *     `jq -e` expressions, which encode the exact assertion shape.
 *
 * Each fragment is checked individually. Lone tokens that legitimately
 * appear in any reasonable description of the topic (e.g., `redis-cli`,
 * `akm`, `bridge`, `feedback`) are filtered out by a minimum-length and
 * minimum-token-count rule.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { effectiveSlice, getTasksRoot, listTasks, type TaskMetadata } from "./corpus";

const FIXTURE_TESTS = !!process.env.AKM_BENCH_FIXTURE_TESTS;
const STASHES_ROOT = path.resolve(getTasksRoot(), "..", "..", "stashes");

/** Resolve `skill:<name>` against the named stash; returns SKILL.md path or `undefined`. */
function resolveGoldRefPath(stashName: string, goldRef: string): string | undefined {
  const match = /^skill:([a-z0-9][a-z0-9-]*)$/.exec(goldRef);
  if (!match) return undefined;
  const skillDir = path.join(STASHES_ROOT, stashName, "skills", match[1]);
  const skillFile = path.join(skillDir, "SKILL.md");
  return fs.existsSync(skillFile) ? skillFile : undefined;
}

/**
 * Pull the literal segments out of a regex pattern. Splits on regex
 * meta-characters and discards short fragments. The remaining strings are
 * what the agent's stdout must contain — and therefore what the gold ref
 * must NOT spell out verbatim.
 */
function regexLiterals(pattern: string): string[] {
  return pattern
    .split(/[.*+?^${}()|[\]\\]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6 && s.includes(" "));
}

/** Pull structural assertion fragments out of a pytest verifier file. */
function pytestStructuralFragments(text: string): string[] {
  const out = new Set<string>();
  // Subscript chains like compose["services"]["redis"]["healthcheck"]["test"].
  const subscriptRe = /(?:\["[a-z0-9_]+"\]){2,}/g;
  for (const m of text.matchAll(subscriptRe)) out.add(m[0]);
  // Dotted attribute paths used in error messages, e.g. services.redis.healthcheck.test.
  const dottedRe = /[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){2,}/g;
  for (const m of text.matchAll(dottedRe)) out.add(m[0]);
  return [...out];
}

/** Pull shell-verifier assertions: single-quoted greps and jq -e expressions. */
function shellAssertionFragments(text: string): string[] {
  const out = new Set<string>();
  // grep -q '<pattern>' or grep -qi '<pattern>'.
  const grepRe = /grep\s+-[a-zA-Z]+\s+'([^']{4,})'/g;
  for (const m of text.matchAll(grepRe)) out.add(m[1]);
  // jq -e '<expr>'.
  const jqRe = /jq\s+-e\s+'([^']{4,})'/g;
  for (const m of text.matchAll(jqRe)) out.add(m[1]);
  return [...out];
}

function readVerifierFiles(task: TaskMetadata): string {
  let combined = "";
  if (task.verifier === "pytest") {
    const testsDir = path.join(task.taskDir, "tests");
    if (fs.existsSync(testsDir)) {
      for (const entry of fs.readdirSync(testsDir)) {
        if (entry.endsWith(".py")) combined += `${fs.readFileSync(path.join(testsDir, entry), "utf8")}\n`;
      }
    }
  } else if (task.verifier === "script") {
    const verify = path.join(task.taskDir, "verify.sh");
    if (fs.existsSync(verify)) combined += fs.readFileSync(verify, "utf8");
  }
  return combined;
}

/**
 * Return the verifier assertion fragments for a task, applying an additional
 * filter suitable for cross-task comparisons. Short two-word domain phrases
 * (e.g. `akm feedback`, `akm search`) naturally recur across tasks that share
 * a domain — they are NOT meaningful leakage signals. A fragment is considered
 * meaningful only when it either:
 *   • contains at least two spaces (three or more tokens), or
 *   • contains a structural character (`=`, `[`, `(`) that marks it as a
 *     complex expression unlikely to appear by coincidence.
 *
 * This is more precise than a raw length threshold because it captures the
 * difference between `akm feedback` (12 chars, 2 tokens, no structure) and
 * `.model == "anthropic/claude-opus-4-7"` (37 chars, structural `==`).
 */
function crossTaskFragments(task: TaskMetadata): string[] {
  const isMeaningful = (f: string) => {
    const spaceCount = (f.match(/ /g) ?? []).length;
    return spaceCount >= 2 || /[=[(]/.test(f);
  };
  const raw: string[] = [];
  if (task.verifier === "regex" && task.expectedMatch) {
    raw.push(...regexLiterals(task.expectedMatch));
  } else {
    const verifierText = readVerifierFiles(task);
    raw.push(...pytestStructuralFragments(verifierText));
    raw.push(...shellAssertionFragments(verifierText));
  }
  return raw.filter(isMeaningful);
}

describe.skipIf(!FIXTURE_TESTS)("cross-task eval/train verifier leakage check", () => {
  const allTasks = listTasks();

  // Group tasks by stash name.
  const byStash = new Map<string, TaskMetadata[]>();
  for (const task of allTasks) {
    const group = byStash.get(task.stash) ?? [];
    group.push(task);
    byStash.set(task.stash, group);
  }

  // Only stashes that have BOTH train and eval tasks are interesting.
  const mixedStashes = [...byStash.entries()].filter(([, tasks]) => {
    const hasTrain = tasks.some((t) => effectiveSlice(t) === "train");
    const hasEval = tasks.some((t) => effectiveSlice(t) === "eval");
    return hasTrain && hasEval;
  });

  test("at least one stash has both train and eval tasks", () => {
    expect(mixedStashes.length).toBeGreaterThan(0);
  });

  for (const [stashName, tasks] of mixedStashes) {
    const trainTasks = tasks.filter((t) => effectiveSlice(t) === "train");
    const evalTasks = tasks.filter((t) => effectiveSlice(t) === "eval");

    // Train → Eval: train verifier fragments must not appear in eval verifier text.
    // Skip pairs that are intentional train/eval variants of the same task family
    // (e.g. inkwell/add-healthcheck-train vs inkwell/add-healthcheck) — they share
    // field-access patterns by design, just with different expected values.
    const isVariantPair = (trainId: string, evalId: string) => {
      const trainBase = trainId.replace(/-train$/, "");
      return trainBase === evalId || evalId.startsWith(`${trainBase}-`);
    };
    for (const trainTask of trainTasks) {
      const trainFragments = crossTaskFragments(trainTask);
      if (trainFragments.length === 0) continue;

      for (const evalTask of evalTasks) {
        if (isVariantPair(trainTask.id, evalTask.id)) continue;
        const evalVerifierText = readVerifierFiles(evalTask);
        test(`stash:${stashName} — train:${trainTask.id} fragments not in eval:${evalTask.id} verifier`, () => {
          const leaked = trainFragments.filter((frag) => evalVerifierText.includes(frag));
          expect(leaked, `fragments leaked from train verifier to eval verifier: ${JSON.stringify(leaked)}`).toEqual(
            [],
          );
        });
      }
    }

    // Eval → Train: eval verifier fragments must not appear in train verifier text.
    for (const evalTask of evalTasks) {
      const evalFragments = crossTaskFragments(evalTask);
      if (evalFragments.length === 0) continue;

      for (const trainTask of trainTasks) {
        if (isVariantPair(trainTask.id, evalTask.id)) continue;
        const trainVerifierText = readVerifierFiles(trainTask);
        test(`stash:${stashName} — eval:${evalTask.id} fragments not in train:${trainTask.id} verifier`, () => {
          const leaked = evalFragments.filter((frag) => trainVerifierText.includes(frag));
          expect(leaked, `fragments leaked from eval verifier to train verifier: ${JSON.stringify(leaked)}`).toEqual(
            [],
          );
        });
      }
    }
  }
});

describe.skipIf(!FIXTURE_TESTS)("gold-ref leakage check", () => {
  const tasks = listTasks().filter((t) => t.goldRef);
  test("at least one task ships with a gold_ref", () => {
    expect(tasks.length).toBeGreaterThan(0);
  });

  for (const task of tasks) {
    test(`${task.id}: verifier text does not appear in gold-ref content`, () => {
      const goldRef = task.goldRef as string;
      const goldPath = resolveGoldRefPath(task.stash, goldRef);
      // A declared gold_ref MUST resolve to an existing fixture asset. Silent
      // skipping here previously masked typos and stash-name drift; we now
      // fail loudly so the corpus author is forced to fix the reference.
      if (!goldPath) {
        // Non-skill refs (workflow:, command:, etc.) are not leakage-checked —
        // only skill: refs map to a SKILL.md that could leak answers.
        if (!/^skill:/.test(goldRef)) return;
        throw new Error(
          `${task.id}: gold_ref "${goldRef}" against stash "${task.stash}" did not resolve to a SKILL.md under tests/fixtures/stashes/. Fix the gold_ref, fix the stash name, or remove the gold_ref.`,
        );
      }
      const goldContent = fs.readFileSync(goldPath, "utf8");

      const fragments: string[] = [];
      if (task.verifier === "regex" && task.expectedMatch) {
        fragments.push(...regexLiterals(task.expectedMatch));
      } else {
        const verifierText = readVerifierFiles(task);
        fragments.push(...pytestStructuralFragments(verifierText));
        fragments.push(...shellAssertionFragments(verifierText));
      }

      const leaked = fragments.filter((frag) => goldContent.includes(frag));
      expect(leaked).toEqual([]);
    });
  }
});
