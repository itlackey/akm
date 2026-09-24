// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unit tests for standards PROMPT INJECTION.
 *
 * The resolvers/dispatch are tested in standards-resolvers.test.ts and
 * standards-dispatch.test.ts. THIS file proves that every LLM prompt that
 * authors or edits a stash asset actually renders the resolved
 * `standardsContext` into its output — and omits the section when there are no
 * standards (so a stash without convention/meta facts pays zero prompt cost).
 *
 * Covered authoring prompts:
 *   - buildReflectPrompt        (improve reflect — edit an asset)
 *   - buildProposePrompt        (propose — author a new asset)
 *   - buildSchemaRepairPrompt   (schema-repair — fix frontmatter)
 *   - buildDistillPrompt        (distill — lesson/knowledge)
 *   - buildExtractPrompt        (extract — lessons/memories from a session)
 *
 * consolidate's buildChunkPrompt does not take a standardsContext (CONS2,
 * tier3-0917): the chunk prompt is a promote-only op list that never used it.
 *
 * Plus one tie-through test: the REAL `resolveStashStandards` output (from an
 * on-disk convention fact) reaches a builder's rendered prompt.
 *
 * Pure string assertions + a temp stash for the tie-through. No real DB,
 * network, or spawned process, so this file lives under tests/ (unit
 * target), not tests/integration/ (ORG-05, 0.9.8 stabilization; see
 * AGENTS.md's tests/integration/ classification rule).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDistillPrompt } from "../src/commands/improve/distill";
import { buildExtractPrompt } from "../src/commands/improve/extract-prompt";
import { resolveStandardsContext } from "../src/core/standards/resolve-standards-context";
import { resolveStashStandards } from "../src/core/standards/resolve-stash-standards";
import { buildProposePrompt, buildReflectPrompt, buildSchemaRepairPrompt } from "../src/integrations/agent/prompts";

/** The lead-in line shared by every authoring prompt's standards section. */
const LEAD_IN = "Standards to follow (the rulebook for this target)";
/** A distinctive sentinel that only appears via standards injection. */
const SENTINEL = "ZZZ_STANDARD_RULE_use_kebab_case";

const sessionData = () =>
  ({
    ref: {
      harness: "claude",
      sessionId: "ses_test",
      filePath: "/tmp/test.jsonl",
      startedAt: Date.parse("2026-06-21T10:00:00.000Z"),
      endedAt: Date.parse("2026-06-21T11:00:00.000Z"),
      projectHint: "test-project",
      title: "Test session",
    },
    events: [],
    inlineRefs: [],
    // biome-ignore lint/suspicious/noExplicitAny: minimal SessionData fixture
  }) as any;

/**
 * Each builder: a thunk producing the rendered prompt string, given an optional
 * standardsContext. Keeps the present/absent assertions uniform across all 6.
 */
const BUILDERS: Array<{ name: string; render: (standardsContext?: string) => string }> = [
  {
    name: "buildReflectPrompt",
    render: (s) =>
      buildReflectPrompt({ ref: "skills/foo", type: "skill", name: "foo", assetContent: "body", standardsContext: s })
        .prompt,
  },
  {
    name: "buildProposePrompt",
    render: (s) => buildProposePrompt({ type: "skill", name: "foo", task: "do a thing", standardsContext: s }),
  },
  {
    name: "buildSchemaRepairPrompt",
    render: (s) =>
      buildSchemaRepairPrompt({
        ref: "skills/foo",
        type: "skill",
        name: "foo",
        reason: "missing description",
        assetContent: "body",
        standardsContext: s,
      }),
  },
  {
    name: "buildDistillPrompt",
    render: (s) =>
      buildDistillPrompt({ inputRef: "skills/foo", assetContent: "body", feedback: [], standardsContext: s }),
  },
  {
    name: "buildExtractPrompt",
    render: (s) => buildExtractPrompt({ data: sessionData(), events: [], inlineRefs: [], standardsContext: s }),
  },
];

describe("standards prompt injection", () => {
  for (const b of BUILDERS) {
    describe(b.name, () => {
      test("injects the standards section + body when standardsContext is provided", () => {
        const out = b.render(SENTINEL);
        expect(out).toContain(LEAD_IN);
        expect(out).toContain(SENTINEL);
      });

      test("omits the standards section when standardsContext is absent", () => {
        expect(b.render(undefined)).not.toContain(LEAD_IN);
      });

      test("omits the standards section when standardsContext is empty/whitespace", () => {
        expect(b.render("   \n  ")).not.toContain(LEAD_IN);
      });
    });
  }

  test("tie-through: real resolveStashStandards output reaches a rendered prompt", () => {
    const factBody = "ALWAYS_NAME_SKILLS_KEBAB_CASE";
    const facts = path.join(stashDir, "facts", "conventions");
    fs.mkdirSync(facts, { recursive: true });
    fs.writeFileSync(
      path.join(facts, "naming.md"),
      `---\ndescription: naming rules\ncategory: convention\n---\n\n${factBody}\n`,
    );

    const standardsContext = resolveStashStandards(stashDir);
    expect(standardsContext).toContain(factBody);
    // Slash conceptId (guardrail: colon `type:name` refs are retired — never
    // re-emitted, see E-1). Was `# fact:conventions/naming` before the fix.
    expect(standardsContext).toContain("# facts/conventions/naming");

    const prompt = buildDistillPrompt({ inputRef: "skills/foo", assetContent: "body", feedback: [], standardsContext });
    expect(prompt).toContain(LEAD_IN);
    expect(prompt).toContain(factBody);
  });

  test("E-1 regression: rendered standards sections never contain a colon-form ref", () => {
    const factBody = "ALWAYS_NAME_SKILLS_KEBAB_CASE";
    const facts = path.join(stashDir, "facts", "conventions");
    fs.mkdirSync(facts, { recursive: true });
    fs.writeFileSync(
      path.join(facts, "naming.md"),
      `---\ndescription: naming rules\ncategory: convention\n---\n\n${factBody}\n`,
    );
    const typeConventions = path.join(stashDir, "facts", "conventions", "assets");
    fs.mkdirSync(typeConventions, { recursive: true });
    fs.writeFileSync(
      path.join(typeConventions, "skill.md"),
      "---\ndescription: skill conventions\n---\n\nSkills should be concise.\n",
    );

    const standardsContext = resolveStandardsContext("skills/foo", stashDir);
    expect(standardsContext).not.toMatch(/(^|[^a-zA-Z0-9_-])fact:/);
    expect(standardsContext).toContain("facts/conventions/naming");
    expect(standardsContext).toContain("facts/conventions/assets/skill");

    const prompt = buildDistillPrompt({ inputRef: "skills/foo", assetContent: "body", feedback: [], standardsContext });
    expect(prompt).not.toMatch(/(^|[^a-zA-Z0-9_-])fact:/);
  });
});

let stashDir: string;
beforeEach(() => {
  stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-standards-inject-"));
});
afterEach(() => {
  fs.rmSync(stashDir, { recursive: true, force: true });
});
