// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What a model's reply must be to be accepted, apart from how it is asked for
 * again (`llm/structured.ts`): the instruction that carries a JSON Schema to a
 * transport with no native channel for one, and what a parser says about a reply.
 *
 * Lives in `core/` because the agent prompts and request lowering use it too, and
 * `agent/` does not import `llm/`.
 */

/** What a parser makes of a reply: the value, or why the reply is refused. */
export type Parsed<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      /** What is wrong with the reply, in the parser's own words. */
      errors: string[];
      /** `parse_error` (no structure found, the default) or `validation_error` (a structure that fails its rules). */
      reason?: "parse_error" | "validation_error";
    };

/**
 * Append the one structured-output instruction to a prompt. Agent lowering
 * appends it to every schema-bearing request, alongside a transport's native
 * channel where one exists (a chat's `response_format`); the workflow engine
 * appends it for a direct-LLM unit. Resumed workflow runs depend on these
 * exact bytes, so do not reword it.
 */
export function withSchemaInstruction(prompt: string, schema: unknown): string {
  return `${prompt}\n\nRespond with ONLY a JSON value matching this JSON Schema (no prose, no code fences):\n${JSON.stringify(schema)}`;
}
