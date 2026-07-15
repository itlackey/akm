// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unit tests for standards PROMPT INJECTION (standards plan,
 * docs/archive/standards-wiki-schema-PLAN.md).
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
 *   - buildChunkPrompt          (consolidate — merge memories)
 *
 * Plus one tie-through test: the REAL `resolveStashStandards` output (from an
 * on-disk convention fact) reaches a builder's rendered prompt.
 *
 * Pure string assertions + a temp stash for the tie-through. No spawn/serve.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildChunkPrompt } from "../src/commands/improve/consolidate";
import { buildDistillPrompt } from "../src/commands/improve/distill";
import { buildExtractPrompt } from "../src/commands/improve/extract-prompt";
import { resolveStashStandards } from "../src/core/standards/resolve-stash-standards";
import { buildProposePrompt, buildReflectPrompt, buildSchemaRepairPrompt } from "../src/integrations/agent/prompts";

/** The lead-in line shared by every authoring prompt's standards section. */
const LEAD_IN = "Standards to follow (the rulebook for this target)";
/** A distinctive sentinel that only appears via standards injection. */
const SENTINEL = "ZZZ_STANDARD_RULE_use_kebab_case";

// Minimal cast fixtures: builders that read member `filePath` degrade safely
// (try/catch) when the path does not exist, so bogus paths are fine here.
// biome-ignore lint/suspicious/noExplicitAny: minimal test fixtures for pure prompt builders
const memoryEntry = (name: string): any => ({
  name,
  description: `desc ${name}`,
  tags: [],
  filePath: `/nonexistent/${name}.md`,
});
const sessionData = () =>
  ({
    ref: {
      harness: "claude-code",
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
      buildReflectPrompt({ ref: "skill:foo", type: "skill", name: "foo", assetContent: "body", standardsContext: s })
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
        ref: "skill:foo",
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
      buildDistillPrompt({ inputRef: "skill:foo", assetContent: "body", feedback: [], standardsContext: s }),
  },
  {
    name: "buildExtractPrompt",
    render: (s) => buildExtractPrompt({ data: sessionData(), events: [], inlineRefs: [], standardsContext: s }),
  },
  {
    name: "buildChunkPrompt",
    render: (s) => buildChunkPrompt("source", [memoryEntry("m1"), memoryEntry("m2")], 0, 1, 3000, new Set(), s),
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
    expect(standardsContext).toContain("# fact:conventions/naming");

    const prompt = buildDistillPrompt({ inputRef: "skill:foo", assetContent: "body", feedback: [], standardsContext });
    expect(prompt).toContain(LEAD_IN);
    expect(prompt).toContain(factBody);
  });
});

let stashDir: string;
beforeEach(() => {
  stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-standards-inject-"));
});
afterEach(() => {
  fs.rmSync(stashDir, { recursive: true, force: true });
});
