// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What an agent run may do, in harness-neutral terms (#1244).
 *
 * An asset or workflow grants capabilities in its `permissions:` field. With no
 * field the harness runs with its own defaults; with the field, everything not
 * granted is denied. Each harness folder maps capabilities to its own tools and
 * enforces what it can; akm core never sees a harness tool name.
 */
export const CAPABILITIES = ["read", "edit", "shell", "web", "subagents", "akm"] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** Model work may read files and use akm's read-only tools, nothing else. */
export const MODEL_WORK_CAPABILITIES: readonly Capability[] = ["read", "akm"];

export function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && (CAPABILITIES as readonly string[]).includes(value);
}
