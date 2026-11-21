// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The flags a start of a version 5 task takes, beside its input flags: `--env`,
 * `--secret`, `--cwd`, `--timeout`, `--max-retries`, `--inherit`, `--resume` and
 * `--skip-if-locked`. `akm run <task>` and `akm task run <task>` (the scheduler's
 * form) both read a start through `parseStartFlags`.
 */

import path from "node:path";
import { createParsedInvocation } from "../../cli/invocation";
import { parseNonNegativeIntFlag } from "../../cli/parse-args";
import { withoutFlags } from "../../commands/env/injection";
import type { InputFlag } from "../../execution/input-contract";
import type { TaskV5StartFlags } from "./check";

const VALUE_FLAGS = ["--env", "--secret", "--cwd", "--timeout", "--max-retries", "--inherit"];
const BOOLEAN_FLAGS = ["--resume", "--skip-if-locked"];

/** What a start gave, apart from the task's inputs. */
export interface TaskV5Start {
  readonly flags: StartedWith;
  readonly resume: boolean;
  readonly skipIfLocked: boolean;
  /** The input flags, as `parseTaskInputFlags` reads them. */
  readonly inputs: readonly InputFlag[];
}

/** The flags a run was first started with: its tasks and steps get them, and a resume uses them again. */
export interface StartedWith extends TaskV5StartFlags {
  readonly env?: readonly string[];
  readonly secret?: readonly string[];
  readonly inherit?: readonly string[];
}

/** The start flags in `rawArgs`, and the rest, which are the task id and its input flags. */
export function parseStartFlags(rawArgs: readonly string[]): {
  flags: StartedWith;
  resume: boolean;
  skipIfLocked: boolean;
  rest: string[];
} {
  const invocation = createParsedInvocation(["", "", ...rawArgs]);
  const env = invocation.getAllFlagValues("--env");
  const secret = invocation.getAllFlagValues("--secret");
  const inherit = invocation
    .getAllFlagValues("--inherit")
    .flatMap((list) => list.split(/[,\s]+/))
    .filter(Boolean);
  const cwd = invocation.getFlagValue("--cwd");
  const timeout = invocation.getFlagValue("--timeout");
  const maxRetries = parseNonNegativeIntFlag(invocation.getFlagValue("--max-retries"), "--max-retries");
  return {
    flags: {
      ...(env.length > 0 ? { env } : {}),
      ...(secret.length > 0 ? { secret } : {}),
      ...(inherit.length > 0 ? { inherit } : {}),
      ...(cwd !== undefined ? { cwd: path.resolve(cwd) } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
      ...(maxRetries !== undefined ? { maxRetries } : {}),
    },
    resume: invocation.hasFlag("--resume"),
    skipIfLocked: invocation.hasFlag("--skip-if-locked"),
    rest: withoutFlags(rawArgs, VALUE_FLAGS, BOOLEAN_FLAGS),
  };
}
