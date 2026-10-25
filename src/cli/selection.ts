// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The three flags that say where one invocation runs and on which model:
 * `--connection NAME`, `--harness NAME` and `--model ALIAS|NAME`. Omitted
 * means the default; `--strategy` chooses which processes run, never where.
 *
 * `--engine NAME`, their predecessor, is still accepted (hidden from `--help`,
 * with one warning) on the commands that had it, so a scheduled command written
 * for 0.9 keeps running: it names a connection by that name, else a harness.
 */

import type { ArgsDef } from "citty";
import { UsageError } from "../core/errors";
import { warnOnce } from "../core/warn";
import type { ConfiguredExecutionSettings } from "../execution/source";
import { getStringArg } from "./parse-args";

export const SELECTION_ARGS = {
  connection: { type: "string", description: "Run on this connection, by name (default: the default connection)" },
  harness: { type: "string", description: "Run on this harness, by name (default: the default harness)" },
  model: { type: "string", description: "Model to run, by alias (fast, balanced, reasoning) or exact name" },
} as const satisfies ArgsDef;

/** The retired `--engine`: parsed, left out of `--help` (`withoutHiddenArgs`). Spread it where the flag existed. */
export const RETIRED_ENGINE_ARG = {
  engine: { type: "string", hidden: true, description: "Retired: use --connection or --harness." },
} as const;

/** What those flags name; a flag that was not passed says nothing. */
export type SelectionFlags = Pick<ConfiguredExecutionSettings, "connection" | "harness" | "model" | "engine">;

export function selectionFromArgs(args: unknown): SelectionFlags {
  const connection = getStringArg(args, "connection");
  const harness = getStringArg(args, "harness");
  if (connection !== undefined && harness !== undefined) {
    throw new UsageError("--connection and --harness are mutually exclusive. Pick one.", "INVALID_FLAG_VALUE");
  }
  const engine = getStringArg(args, "engine");
  if (engine !== undefined) {
    warnOnce(
      "retired-flag:--engine",
      "--engine is retired: use --connection or --harness. For now it names a connection by that name, else a harness.",
    );
  }
  const model = getStringArg(args, "model");
  return {
    ...(connection !== undefined ? { connection } : {}),
    ...(harness !== undefined ? { harness } : {}),
    ...(engine !== undefined ? { engine } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}
