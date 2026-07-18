// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Workspace activation policy — the single point that encodes akm's
 * "**installation is not activation**" rule (History D8; plan §11 Chunk 6.5,
 * §1.3).
 *
 * Installing a bundle / stash / source grants NOTHING on its own: a bundle can
 * carry tasks, env files, and workflows and none of them fire, inject, or gain
 * write access until the operator explicitly activates them. Before this module
 * the enforcement lived in four scattered spots that re-derived the same policy
 * independently; they are consolidated here as pure decision predicates while
 * the I/O, operator-facing messages, and the interactive add-time confirm /
 * rollback UX stay at their original call sites.
 *
 * The four rules, and where each is applied:
 *
 *   1. **Dangerous env-key injection** (`env-binding.ts`). Injecting an env
 *      whose keys include a process-hijacking variable (LD_PRELOAD, PATH, …) is
 *      BLOCKED when the env comes from a third-party stash (one installed from a
 *      registry, i.e. `source.registryId` is set) and only WARNED for the
 *      operator's own first-party stash. → {@link decideDangerousEnvInjection}
 *
 *   2. **Freshly-installed stash dangerous-key scan** (`add-cli.ts`). When a
 *      just-installed stash carries env files with dangerous keys, the install
 *      is GATED (blocked unless the operator confirms interactively or passed
 *      `--allow-insecure`). → {@link decideDangerousKeyInstall}
 *
 *   3. **Task activation** (`tasks/runner.ts`). Installing a task registers it
 *      DISABLED; the scheduler must skip it at fire time until the operator runs
 *      `akm tasks enable`. Manual runs are exempt (catch-up / testing).
 *      → {@link shouldSkipUnactivatedTask}
 *
 *   4. **Write activation** (`search/search-source.ts`, `installations.ts`). A
 *      registry-cached (installed, read-only) source is never written in place —
 *      only the primary stash and sources explicitly marked `writable: true`
 *      are write-activated. → {@link isSourceWriteActivated}
 *
 * These are behavior-preserving PORTS of the pre-0.9.0 rules. This module ships
 * **no new trust / approval / security machinery** (2026-07-14 decision, §1.3):
 * no labeling, action clamps, confirm prompts, digests, trust records, or
 * persisted `workspace_bindings`. It is a pure leaf — it imports nothing from
 * the rest of the tree — so routing the four call sites through it adds no new
 * import edges. env/secret handling is unchanged.
 */

// ── Rule 1: dangerous env-key injection (env-binding.ts) ─────────────────────

/**
 * How to treat an env injection that carries process-hijacking key(s).
 *   - `"allow"` — no dangerous keys present; inject normally.
 *   - `"warn"`  — first-party stash; warn the operator but inject anyway.
 *   - `"block"` — third-party stash; refuse to inject.
 */
export type DangerousEnvInjectionDecision = "allow" | "warn" | "block";

/**
 * Decide whether injecting an env with the given dangerous keys is allowed,
 * warned, or blocked. Third-party (registry-installed) stashes hard-block;
 * first-party stashes warn. See rule 1 above.
 *
 * @param dangerousKeys The subset of injected keys flagged as process-hijacking
 *   (already filtered by the caller via `isDangerousEnvKey`).
 * @param thirdParty `true` when the env's source is a third-party stash — i.e.
 *   its origin carries a `registryId`.
 */
export function decideDangerousEnvInjection(input: {
  dangerousKeys: readonly string[];
  thirdParty: boolean;
}): DangerousEnvInjectionDecision {
  if (input.dangerousKeys.length === 0) return "allow";
  return input.thirdParty ? "block" : "warn";
}

// ── Rule 2: freshly-installed stash dangerous-key scan (add-cli.ts) ──────────

/**
 * The baseline stance on installing a stash whose env files contain dangerous
 * keys.
 *   - `"allow"`      — no findings; install proceeds silently.
 *   - `"warn-allow"` — findings present but the operator passed
 *                      `--allow-insecure`; warn and proceed.
 *   - `"gate"`       — findings present and no bypass; block the install unless
 *                      the interactive TTY confirmation (which stays in
 *                      `add-cli.ts`) explicitly overrides it.
 */
export type DangerousKeyInstallStance = "allow" | "warn-allow" | "gate";

/**
 * Decide the baseline install stance for a freshly-installed stash's
 * dangerous-key scan. The interactive confirm / rollback UX is applied by the
 * caller on top of the `"gate"` stance — this predicate only fixes the policy.
 * See rule 2 above.
 */
export function decideDangerousKeyInstall(input: {
  findingsPresent: boolean;
  allowInsecure: boolean;
}): DangerousKeyInstallStance {
  if (!input.findingsPresent) return "allow";
  return input.allowInsecure ? "warn-allow" : "gate";
}

// ── Rule 3: task activation (tasks/runner.ts) ────────────────────────────────

/**
 * Whether a scheduler-generated task invocation must be skipped because the
 * task is not activated (its `enabled:` is false). Manual (non-scheduled) runs
 * are always dispatched — installing a task grants nothing until enabled, but
 * the operator may still run it by hand for catch-up / testing. See rule 3.
 */
export function shouldSkipUnactivatedTask(input: { enabled: boolean; scheduled: boolean }): boolean {
  return !input.enabled && input.scheduled;
}

// ── Rule 4: write activation (search-source.ts, installations.ts) ────────────

/**
 * Whether a resolved source is write-activated. Only the primary stash and
 * sources explicitly marked `writable: true` are writable; registry-cached
 * (installed, read-only) sources are never written in place because
 * `akm update` overwrites them. See rule 4 above.
 */
export function isSourceWriteActivated(source: { writable?: boolean }): boolean {
  return source.writable === true;
}
