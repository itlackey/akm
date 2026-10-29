// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `harnesses`: agent programs the user already has (Claude Code, Codex,
 * OpenCode, ...). An entry's key is its platform unless `platform` says
 * otherwise, so `{ "claude": {} }` enables Claude Code and a second install is
 * `{ "claude-work": { "platform": "claude", "bin": "/opt/claude-work/bin/claude" } }`.
 */
import { z } from "zod";
import { HARNESS_CONFIG_PLATFORMS } from "../../../integrations/harnesses";
import { ModelAliasesSchema, timeoutMsField } from "./connections";
import { engineName, nonEmptyString } from "./primitives";

export const HarnessSchema = z
  .object({
    // Zod 4's message for a value outside an enum no longer quotes the value; the warning for a dropped harness should.
    platform: z
      .enum(HARNESS_CONFIG_PLATFORMS, {
        error: (issue) =>
          issue.code === "invalid_value"
            ? `${JSON.stringify(issue.input)} is not one of ${HARNESS_CONFIG_PLATFORMS.join(", ")}`
            : undefined,
      })
      .optional(),
    bin: nonEmptyString.optional(),
    args: z.array(z.string()).optional(),
    workspace: nonEmptyString.optional(),
    /** The harness's native agent to run when a request names none (platforms with native agents only). */
    agent: nonEmptyString.optional(),
    timeoutMs: timeoutMsField,
    /** Alias to model for this harness, over the map akm ships for its platform. A harness is given the name only. */
    models: ModelAliasesSchema.optional(),
    /** `false`: akm's own model calls are never sent here by default; a call that names this harness still runs on it. */
    modelWork: z.boolean().optional(),
  })
  .passthrough();

/** Why a harness parsed from this entry cannot be run: it names no platform and its name is not one. */
export function harnessNameProblem(name: string, harness: { platform?: string | undefined }): string | undefined {
  if (harness.platform !== undefined || (HARNESS_CONFIG_PLATFORMS as readonly string[]).includes(name))
    return undefined;
  return `harness "${name}" is not a platform name; set platform to one of ${HARNESS_CONFIG_PLATFORMS.join(", ")}`;
}

export const HarnessesSchema = z.record(engineName, HarnessSchema).superRefine((harnesses, ctx) => {
  for (const [name, harness] of Object.entries(harnesses)) {
    const message = harnessNameProblem(name, harness);
    if (message !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name, "platform"], message });
  }
});
