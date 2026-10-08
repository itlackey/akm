// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Regression gate for #824.
 *
 * `classifyBySmartMd`'s command-placeholder heuristic used
 * `/\$ARGUMENTS|\$[123]\b/`, which matches the `$2` inside `$2,000` — `\b`
 * sits between the `2` and the comma. That fact carries specificity 18 and so
 * OUTRANKED the parent-directory declaration (15), meaning any `memories/*.md`
 * quoting a price was indexed as a `command`, with its ref moving to
 * `commands/memories/<slug>` and the asset vanishing from the `memories/`
 * namespace entirely.
 *
 * Measured on a real corpus before the fix: 3 of 51 LongMemEval session
 * documents were retyped, and those 3 were exactly the 3 whose bodies matched
 * the regex.
 *
 * Two independent defects, so two independent groups of assertions:
 *
 *   1. the regex must not treat currency as a placeholder;
 *   2. a body-sniffed GUESS must not outrank a directory's DECLARATION.
 *
 * Both halves matter. (1) alone still mistypes `$1 invested in treatment`,
 * which is prose the corpus actually contained; (2) alone leaves the regex
 * mistyping loose files that sit under no typed directory at all.
 */

import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recognizeMatch } from "../../src/core/adapter/adapters/akm-adapter";
import { buildFileContext } from "../../src/indexer/walk/file-context";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** Write `body` to `relPath` under a fresh stash root and classify it. */
function classify(relPath: string, body: string): string | undefined {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-824-"));
  roots.push(root);
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, "utf8");
  return recognizeMatch(buildFileContext(root, abs))?.type;
}

const MEMORY_FRONTMATTER = '---\ndescription: "A note."\n---\n\n# note\n\n';

describe("#824: currency in prose must not retype an asset as a command", () => {
  // The exact strings from the corpus that triggered the misclassification.
  const CURRENCY_IN_PROSE = [
    "My budget is around $2,000 per person for the trip.",
    "I've already paid $1,200 upfront for a flight.",
    "Our estimated budget per person is around $2,500, excluding flights.",
    "For every $1 invested in treatment the return is higher.",
    "The upgrade costs $2.50 a month.",
  ];

  for (const sentence of CURRENCY_IN_PROSE) {
    test(`memories/ note stays a memory: ${JSON.stringify(sentence)}`, () => {
      expect(classify("memories/note.md", MEMORY_FRONTMATTER + sentence)).toBe("memory");
    });
  }

  test("the same prose under knowledge/ stays knowledge", () => {
    expect(classify("knowledge/note.md", `${MEMORY_FRONTMATTER}Budget: $2,000 per person.`)).toBe("knowledge");
  });

  test("a loose file with currency is knowledge, not a command", () => {
    // No typed ancestor dir, so defect (2) cannot help here — this is the
    // assertion that the regex itself stopped matching currency.
    expect(classify("loose/note.md", `${MEMORY_FRONTMATTER}Budget: $2,000 per person.`)).toBe("knowledge");
  });

  test("$12 is a figure, not the $1 placeholder", () => {
    expect(classify("loose/note.md", `${MEMORY_FRONTMATTER}It costs $12 total.`)).toBe("knowledge");
  });
});

describe("#824: real command placeholders still classify as commands", () => {
  test("a command living outside commands/ is still recognized by its placeholders", () => {
    // This is the case the heuristic exists for; narrowing it must not
    // silently disable it.
    expect(classify("loose/deploy.md", `${MEMORY_FRONTMATTER}Deploy to $1 using tag $2.`)).toBe("command");
  });

  test("$ARGUMENTS outside commands/ is still recognized", () => {
    expect(classify("loose/ship.md", `${MEMORY_FRONTMATTER}Ship version $ARGUMENTS.`)).toBe("command");
  });

  test("a placeholder ending a sentence still matches", () => {
    // `$1.` is a placeholder followed by a period; only a period followed by a
    // DIGIT indicates a decimal.
    expect(classify("loose/run.md", `${MEMORY_FRONTMATTER}Run it against $1.`)).toBe("command");
  });

  test("a file under commands/ is a command regardless of body", () => {
    expect(classify("commands/ship.md", `${MEMORY_FRONTMATTER}Ship version $ARGUMENTS.`)).toBe("command");
    expect(classify("commands/plain.md", `${MEMORY_FRONTMATTER}No placeholders here at all.`)).toBe("command");
  });
});

describe("#824: only the AMBIGUOUS placeholder defers", () => {
  // The fix draws its line at ambiguity, not at directories. `$ARGUMENTS` is
  // written by nothing but a command, so it keeps its long-standing precedence
  // over a directory hint — a contract `tests/integration/commands/show.test.ts`
  // asserts directly. `$1`/`$2`/`$3` collide with how prose writes money, so
  // only those defer.
  test("$ARGUMENTS still outranks a knowledge/ directory hint", () => {
    expect(
      classify("knowledge/deploy-cmd.md", "---\ndescription: Deploy helper\n---\nDeploy $ARGUMENTS to staging."),
    ).toBe("command");
  });

  test("agent frontmatter still outranks an agents/ directory hint", () => {
    expect(
      classify("agents/build-cmd.md", "---\nagent: build\ndescription: Build dispatch\n---\nBuild the project."),
    ).toBe("command");
  });
});

describe("#824: a declared directory type outranks a numeric placeholder", () => {
  // Even a genuine placeholder must not retype an asset out of the directory
  // that declares what it is. This is defect (2) on its own, isolated from the
  // regex change: `$1 ` still matches COMMAND_PLACEHOLDER_RE.
  for (const dir of ["memories", "knowledge", "lessons", "facts"]) {
    test(`${dir}/ wins over a genuine $1 placeholder in the body`, () => {
      const type = classify(`${dir}/note.md`, `${MEMORY_FRONTMATTER}Substitute $1 here.`);
      expect(type).not.toBe("command");
    });
  }
});

describe("#1063: a skill's folder is a declared context for the numeric guess", () => {
  const SHELL = `${MEMORY_FRONTMATTER}\`\`\`bash\nrequire_var() {\n  local var="$1"\n}\n\`\`\`\n`;

  test("a skill reference with a shell $1 is not a command", () => {
    expect(classify("skills/demo/references/setup.md", SHELL)).not.toBe("command");
    expect(classify("skills/demo/references/setup.md", SHELL)).toBe("knowledge");
  });

  test("SKILL.md stays a skill", () => {
    expect(classify("skills/demo/SKILL.md", SHELL)).toBe("skill");
  });

  test("$ARGUMENTS in a skill resource still reads as a command", () => {
    expect(classify("skills/demo/references/run.md", `${MEMORY_FRONTMATTER}Run $ARGUMENTS.`)).toBe("command");
  });

  test("a file under commands/ with $1 is still a command", () => {
    expect(classify("commands/setup.md", SHELL)).toBe("command");
  });
});
