// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `bestEffort` — a single chokepoint for the project's many intentionally
 * silent error swallows (`} catch { /* nothing *\/ }`).
 *
 * Historically these were scattered as bare `try/catch {}` blocks with no
 * binding and no handling, hiding errors with no way to opt into visibility.
 * This helper centralizes that pattern WITHOUT changing default behaviour:
 *
 *   - It runs `fn`. On success it returns the result.
 *   - On throw it SWALLOWS the error and returns `undefined` — byte-identical
 *     to the previous bare swallow at the default verbosity level.
 *   - ONLY when verbose/debug output is enabled (`isVerbose()`) does it route a
 *     one-line diagnostic to the existing verbose stderr seam (`warnVerbose`).
 *     At the default (non-verbose) verbosity this emits nothing — no new
 *     stdout, no new stderr, no changed control flow.
 *
 * It deliberately does NOT add a test-isolation rethrow or any other handling:
 * the contract is "centralize the existing silent swallow + add opt-in verbose
 * visibility", nothing more. Sites that need `rethrowIfTestIsolationError` or
 * any real handling already bind the error and are out of scope for this
 * helper.
 */

import { isVerbose, warnVerbose } from "./warn";

/**
 * Run `fn` for its side effect/value, swallowing any thrown error and
 * returning `undefined` on failure — exactly as a bare `try { … } catch {}`
 * would. When verbose output is enabled, the swallowed error is surfaced on the
 * existing verbose stderr seam (prefixed with `context` when provided).
 *
 * @param fn      the operation to attempt
 * @param context short human-readable reason for the swallow (for verbose logs)
 * @returns the result of `fn`, or `undefined` if it threw
 */
export function bestEffort<T>(fn: () => T, context?: string): T | undefined {
  try {
    return fn();
  } catch (err) {
    if (isVerbose()) {
      warnVerbose(`[akm:best-effort] ${context ? `${context}: ` : ""}swallowed error`, err);
    }
    return undefined;
  }
}

/**
 * Async variant of {@link bestEffort}. Awaits `fn()`, swallowing any rejection
 * and resolving to `undefined` on failure — byte-identical to a bare
 * `try { await … } catch {}` at the default verbosity level. Surfaces the
 * swallowed error on the verbose seam only when verbose output is enabled.
 */
export async function bestEffortAsync<T>(fn: () => Promise<T>, context?: string): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    if (isVerbose()) {
      warnVerbose(`[akm:best-effort] ${context ? `${context}: ` : ""}swallowed error`, err);
    }
    return undefined;
  }
}
