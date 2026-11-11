// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";
import { UsageError } from "./errors";
import { isKnownType, KNOWN_TYPES } from "./recognition-util";

const knownType = z.string().trim().min(1).refine(isKnownType, "unsupported asset type");

/** Selectors relax only the named default exclusions; they never select matching assets on their own. */
export const IncludeSchema = z
  .object({
    quality: z.union([z.literal("proposed"), z.array(z.literal("proposed")).min(1)]).optional(),
    type: z.union([knownType, z.array(knownType).min(1)]).optional(),
  })
  .strict();

export type IncludeSelectors = z.infer<typeof IncludeSchema>;

export function normalizeInclude(raw: IncludeSelectors | undefined): IncludeSelectors | undefined {
  if (raw === undefined) return undefined;
  const parsed = IncludeSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = String(issue?.path[0] ?? "");
    const given = (raw as Record<string, unknown>)[key];
    const detail =
      issue?.code === "unrecognized_keys"
        ? `Unsupported --include key: ${issue.keys.join(", ")}.`
        : key === "type" || key === "quality"
          ? `Unsupported --include ${key} value: ${JSON.stringify(given)}.`
          : "Invalid --include value.";
    throw new UsageError(
      `Invalid --include value. ${detail}`,
      "INVALID_FLAG_VALUE",
      `Valid selectors: quality=proposed, type=<${KNOWN_TYPES.join("|")}>. Repeat --include for more than one.`,
    );
  }
  return parsed.data;
}

export function includesProposed(include: IncludeSelectors | undefined): boolean {
  return include?.quality !== undefined;
}

export function includedTypes(include: IncludeSelectors | undefined): string[] {
  return include?.type === undefined ? [] : [include.type].flat();
}
