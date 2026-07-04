// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Clack prompt shims for the setup wizard: cancel-aware prompting so pressing
 * Escape offers a confirm-to-quit rather than crashing the wizard.
 */

import * as p from "../cli/clack";

export function bail(): never {
  p.cancel("Setup cancelled. No changes were saved.");
  process.exit(0);
}

/**
 * Check if a prompt result was cancelled (Escape). If so, ask the user
 * whether they really want to quit. Returns true if the user chose to
 * stay (i.e. the caller should re-prompt), or calls bail() to exit.
 *
 * @internal Exported for testing only.
 */
export async function onCancel(value: unknown): Promise<boolean> {
  if (!p.isCancel(value)) return false;

  const confirmExit = await p.confirm({
    message: "Exit the wizard? No changes will be saved.",
    initialValue: false,
  });

  // Only exit when the user explicitly confirms "Yes".
  // Pressing Escape on the confirmation (isCancel) or choosing "No"
  // both mean "stay in the wizard".
  if (confirmExit === true) {
    bail();
  }

  // User chose to stay
  return true;
}

/**
 * Run a prompt function in a loop, retrying if the user presses Escape
 * but decides to stay. Returns the non-cancelled result.
 */
export async function prompt<T>(fn: () => Promise<T | symbol>): Promise<T> {
  for (;;) {
    const result = await fn();
    if (await onCancel(result)) continue;
    return result as T;
  }
}

/**
 * Like `prompt`, but pressing Escape returns `null` instead of re-prompting.
 * Use inside sub-actions so the user can back out to the parent menu.
 */
export async function promptOrBack<T>(fn: () => Promise<T | symbol>): Promise<T | null> {
  const result = await fn();
  if (p.isCancel(result)) return null;
  return result as T;
}
