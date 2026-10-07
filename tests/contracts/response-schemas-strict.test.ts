// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Every response schema akm sends is valid for a strict structured-output
 * provider.
 *
 * The client sends a response schema `strict: true`, and OpenAI refuses one
 * whose objects do not list every property in `required` (and set
 * `additionalProperties: false`):
 *
 *   400 Invalid schema for response_format 'akm_response': In context=(),
 *   'required' is required to be supplied and to be an array including every
 *   key in properties. Missing 'tags'.
 *
 * A property that may be absent is therefore required and says "none" in its
 * own value (an empty string or array, or null), and the code that reads the
 * reply treats that value as absent. The client remembers a rejected schema per
 * connection, not per schema, so one schema that fails this rule turns schemas
 * off for every valid one that follows on the same connection (#1046, #1047).
 *
 * The list below is every schema `akm` itself sends as a `responseSchema` or an
 * `outputSchema`; the last test fails when a call site names one that is not on
 * it, so a new schema cannot skip the rule. A schema a task or workflow author
 * writes is theirs and not checked.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { CONSOLIDATE_PLAN_JSON_SCHEMA } from "../../src/commands/improve/consolidate";
import { PAIR_CHECK_JSON_SCHEMA, PAIR_JUDGE_JSON_SCHEMA } from "../../src/commands/improve/consolidate/pair-pass";
import { DISTILL_KNOWLEDGE_JSON_SCHEMA, DISTILL_LESSON_JSON_SCHEMA } from "../../src/commands/improve/distill";
import { EXTRACT_JSON_SCHEMA } from "../../src/commands/improve/extract-prompt";
import { REFLECT_JSON_SCHEMA, REFLECT_UNSCOPED_JSON_SCHEMA } from "../../src/commands/improve/reflect";
import { GRADE_SCHEMA } from "../../src/commands/improve/retrieval-gate";
import { SESSION_SUMMARY_JSON_SCHEMA } from "../../src/commands/improve/session-asset";
import { judgeResponseSchema } from "../../src/commands/improve/stage";
import { PROPOSAL_JSON_SCHEMA } from "../../src/integrations/agent/prompts";
import { DERIVED_MEMORY_JSON_SCHEMA } from "../../src/llm/memory-infer";

/** Every schema akm sends, by the name its call site uses. */
const RESPONSE_SCHEMAS: Record<string, unknown> = {
  CONSOLIDATE_PLAN_JSON_SCHEMA,
  DERIVED_MEMORY_JSON_SCHEMA,
  DISTILL_KNOWLEDGE_JSON_SCHEMA,
  DISTILL_LESSON_JSON_SCHEMA,
  EXTRACT_JSON_SCHEMA,
  GRADE_SCHEMA,
  PAIR_CHECK_JSON_SCHEMA,
  PAIR_JUDGE_JSON_SCHEMA,
  PROPOSAL_JSON_SCHEMA,
  REFLECT_JSON_SCHEMA,
  REFLECT_UNSCOPED_JSON_SCHEMA,
  SESSION_SUMMARY_JSON_SCHEMA,
  // Built from the criteria a judge scores; its shape does not depend on which.
  judgeResponseSchema: judgeResponseSchema(["need", "preservation", "quality"]),
};

/** What a strict provider refuses in `schema` and everything under it, as `path: why`. */
function strictViolations(schema: unknown, at = "(root)"): string[] {
  if (typeof schema !== "object" || schema === null) return [];
  const node = schema as {
    properties?: Record<string, unknown>;
    required?: readonly string[];
    additionalProperties?: unknown;
    items?: unknown;
    anyOf?: unknown[];
  };
  const out: string[] = [];
  if (node.properties) {
    const missing = Object.keys(node.properties).filter((key) => !node.required?.includes(key));
    if (missing.length > 0) out.push(`${at}: not in required: ${missing.join(", ")}`);
    if (node.additionalProperties !== false) out.push(`${at}: additionalProperties is not false`);
    for (const [key, child] of Object.entries(node.properties)) out.push(...strictViolations(child, `${at}.${key}`));
  }
  if (node.items) out.push(...strictViolations(node.items, `${at}[]`));
  for (const [index, branch] of (node.anyOf ?? []).entries()) out.push(...strictViolations(branch, `${at}|${index}`));
  return out;
}

describe("the rule", () => {
  test("flags a property outside `required` and an object that allows extra keys", () => {
    expect(
      strictViolations({
        type: "object",
        required: ["a"],
        properties: { a: { type: "string" }, b: { type: "array", items: { type: "object", properties: { c: {} } } } },
      }),
    ).toEqual([
      "(root): not in required: b",
      "(root): additionalProperties is not false",
      "(root).b[]: not in required: c",
      "(root).b[]: additionalProperties is not false",
    ]);
  });
});

describe("every response schema akm sends is valid for a strict structured-output provider", () => {
  test.each(Object.entries(RESPONSE_SCHEMAS))("%s", (_name, schema) => {
    expect(strictViolations(schema)).toEqual([]);
  });

  test("the list names every schema a call site sends", () => {
    const src = path.join(import.meta.dir, "..", "..", "src");
    const named = new Set<string>();
    for (const file of fs.readdirSync(src, { recursive: true, encoding: "utf8" })) {
      if (!file.endsWith(".ts")) continue;
      // What follows `responseSchema:` or `outputSchema:` up to the next comma, brace or semicolon, wrapped lines too.
      for (const site of fs
        .readFileSync(path.join(src, file), "utf8")
        .matchAll(/\b(?:response|output)Schema:\s*([^,};]*)/g)) {
        for (const name of (site[1] as string).matchAll(/\b([A-Z][A-Z0-9_]*SCHEMA|judgeResponseSchema)\b/g)) {
          named.add(name[1] as string);
        }
      }
    }
    // A schema sent without being on the list is one the rule has never been run against.
    expect([...named].filter((name) => !(name in RESPONSE_SCHEMAS)).sort()).toEqual([]);
  });
});
