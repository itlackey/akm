// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Confirmation helper for destructive CLI commands.
 *
 * ## Usage
 *
 * ```ts
 * import { confirmDestructive } from "../cli/confirm";
 *
 * async function run({ args }) {
 *   const yes = await confirmDestructive(
 *     `Remove source "${args.target}"? This cannot be undone.`,
 *     { yes: args.yes === true }
 *   );
 *   if (!yes) { console.error("Aborted."); return; }
 *   // proceed...
 * }
 * ```
 *
 * ## Non-TTY policy
 *
 * In non-interactive contexts (stdin is not a TTY), destructive commands
 * **fail by default** and require explicit `--yes` to proceed. This prevents
 * accidental destruction in scripts that forget to pass `-y`.
 *
 * This is intentionally stricter than many CLIs that silently proceed in
 * non-TTY mode. The rationale: secrets, sources, and proposals cannot be
 * recovered after deletion, so the cost of requiring `--yes` in scripts is
 * low and the cost of accidental deletion is high.
 *
 * ## Safety exemptions
 *
 * `--quiet` NEVER suppresses the confirmation prompt — it is safety-critical
 * output. The auto-migration banner is similarly exempt from `--quiet`.
 */

import * as p from "@clack/prompts";
import { UsageError } from "../core/errors";

export interface ConfirmDestructiveOptions {
  /**
   * When true, skip the prompt and return true immediately.
   * Set this when the caller's --yes / -y flag is present.
   */
  yes: boolean;
}

/**
 * Prompt the user to confirm a destructive action.
 *
 * Returns `true` if the user confirmed (or `--yes` was passed).
 * Returns `false` if the user declined.
 * Throws `UsageError("NON_INTERACTIVE_REQUIRES_YES")` when stdin is not a
 * TTY and `--yes` was not passed — callers should propagate this error.
 *
 * The prompt defaults to NO so accidental Enter presses do not proceed.
 *
 * @param message  Human-readable description of what will be destroyed.
 * @param opts     Options controlling confirmation behaviour.
 */
export async function confirmDestructive(message: string, opts: ConfirmDestructiveOptions): Promise<boolean> {
  // --yes always skips the prompt
  if (opts.yes) return true;

  // Non-TTY: fail loudly — require explicit --yes in scripts
  const isInteractive = process.stdin.isTTY === true;
  if (!isInteractive) {
    throw new UsageError(
      `This command requires confirmation in non-interactive mode. Pass --yes / -y to proceed without prompting.\n\nAction: ${message}`,
      "NON_INTERACTIVE_REQUIRES_YES",
    );
  }

  // Interactive: prompt with default = NO (false)
  const confirmed = await p.confirm({
    message,
    initialValue: false,
  });

  // p.confirm returns a symbol when the user cancels (Ctrl+C)
  if (p.isCancel(confirmed)) {
    p.outro("Cancelled.");
    process.exit(0);
  }

  return confirmed === true;
}
