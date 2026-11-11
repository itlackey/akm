// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";
import { UsageError } from "./errors";

/** Selectors relax only the named default exclusions; they never select matching assets on their own. */
export const IncludeSchema = z
  .object({
    quality: z.union([z.literal("proposed"), z.array(z.literal("proposed")).min(1)]).optional(),
    type: z.union([z.string().trim().min(1), z.array(z.string().trim().min(1)).min(1)]).optional(),
  })
  .strict();

export type IncludeSelectors = z.infer<typeof IncludeSchema>;

export function normalizeInclude(raw: IncludeSelectors | undefined): IncludeSelectors | undefined {
  if (raw === undefined) return undefined;
  const parsed = IncludeSchema.safeParse(raw);
  if (!parsed.success)
    throw new UsageError(
      "Invalid --include value. Expected quality=proposed or type=<asset-type>.",
      "INVALID_FLAG_VALUE",
    );
  return parsed.data;
}

export function includesProposed(include: IncludeSelectors | undefined): boolean {
  return include?.quality !== undefined;
}

export function includedTypes(include: IncludeSelectors | undefined): string[] {
  return include?.type === undefined ? [] : [include.type].flat();
}
