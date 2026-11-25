// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { assertSnapshotKeys, snapshotStrictRecord } from "../execution/record";
import { UsageError } from "./errors";

export type ParsedBuiltinCommandAction =
  | Readonly<{ kind: "stored"; ref: string; arguments?: string }>
  | Readonly<{ kind: "inline"; content: string; arguments?: string }>;

/**
 * Parse the `with:` payload of AKM's built-in command action. The executable
 * selector is a strict XOR: exactly one of `ref` or `content`.
 */
export function parseBuiltinCommandAction(value: unknown): ParsedBuiltinCommandAction {
  const input = snapshotStrictRecord(value, "built-in command action with");
  assertSnapshotKeys(input, ["ref", "content", "arguments"], "built-in command action with");
  const hasRef = Object.hasOwn(input, "ref");
  const hasContent = Object.hasOwn(input, "content");
  if (hasRef === hasContent) {
    throw new UsageError("Built-in command action with requires exactly one of ref or content.", "INVALID_FLAG_VALUE");
  }
  if (Object.hasOwn(input, "arguments") && typeof input.arguments !== "string") {
    throw new UsageError("Built-in command action with.arguments must be a string.", "INVALID_FLAG_VALUE");
  }
  const exactArguments = Object.hasOwn(input, "arguments") ? { arguments: input.arguments as string } : {};
  if (hasRef) {
    if (typeof input.ref !== "string" || input.ref.length === 0) {
      throw new UsageError("Built-in command action with.ref must be a non-empty string.", "INVALID_FLAG_VALUE");
    }
    return Object.freeze({ kind: "stored" as const, ref: input.ref, ...exactArguments });
  }
  if (typeof input.content !== "string") {
    throw new UsageError("Built-in command action with.content must be a string.", "INVALID_FLAG_VALUE");
  }
  return Object.freeze({ kind: "inline" as const, content: input.content, ...exactArguments });
}
