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

const HarnessSchema = z
  .object({
    platform: z.enum(HARNESS_CONFIG_PLATFORMS).optional(),
    bin: nonEmptyString.optional(),
    args: z.array(z.string()).optional(),
    workspace: nonEmptyString.optional(),
    /** The harness's native agent to run when a request names none (platforms with native agents only). */
    agent: nonEmptyString.optional(),
    timeoutMs: timeoutMsField,
    /** Alias to model for this harness, over the map akm ships for its platform. */
    models: ModelAliasesSchema.optional(),
  })
  .passthrough();

export const HarnessesSchema = z.record(engineName, HarnessSchema).superRefine((harnesses, ctx) => {
  for (const [name, harness] of Object.entries(harnesses)) {
    if (harness.platform === undefined && !(HARNESS_CONFIG_PLATFORMS as readonly string[]).includes(name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [name, "platform"],
        message: `harness "${name}" is not a platform name; set platform to one of ${HARNESS_CONFIG_PLATFORMS.join(", ")}`,
      });
    }
  }
});
