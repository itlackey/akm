// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";

const toolName = z.string().trim().min(1, "expected a non-empty tool name");

/** Host-owned ceiling for capabilities requested by executable assets. */
export const ExecutionPolicyConfigSchema = z
  .object({
    /** Exact tool names an asset may request. `*` is an explicit allow-all ceiling. */
    allowedTools: z
      .array(toolName)
      .default([])
      .superRefine((tools, ctx) => {
        const seen = new Set<string>();
        for (const [index, tool] of tools.entries()) {
          if (seen.has(tool)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: "duplicates an earlier tool name" });
          }
          seen.add(tool);
        }
      }),
  })
  .strict();
