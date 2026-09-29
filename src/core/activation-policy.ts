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
 * The rules, and where each is applied:
 *
 *   1. **Dangerous env-key injection** (`env-binding.ts`). Injecting an env
 *      whose keys include a genuine RCE-class process-hijacking variable
 *      (LD_PRELOAD, PATH, GIT_SSH_COMMAND, BASH_FUNC_*, …) is BLOCKED when the
 *      env comes from a third-party stash (one installed from a registry, i.e.
 *      `source.registryId` is set) and only WARNED for the operator's own
 *      first-party stash, an explicit `--allow-dangerous-env-keys`, or a key from the
 *      interactive-tool group (EDITOR/VISUAL/PAGER — high-FP, and never
 *      actually invoked by akm's own env-injection path). → {@link decideDangerousEnvInjection}
 *
 *   2. **Freshly-installed stash dangerous-key scan** (`add-cli.ts`). When a
 *      just-installed stash carries env files with dangerous keys, the install
 *      is GATED (blocked unless the operator confirms interactively or passed
 *      `--allow-dangerous-env-keys`). → {@link decideDangerousKeyInstall}
 *
 *   3. **Write activation** (`search/search-source.ts`, `installations.ts`). A
 *      registry-cached (installed, read-only) source is never written in place —
 *      only the primary stash and sources explicitly marked `writable: true`
 *      are write-activated. → {@link isSourceWriteActivated}
 *
 * Scheduler activation is now a separate host-local allow-list
 * (`scheduler.enabled`) rather than a predicate in this module. Authored
 * task/workflow sources cannot grant it. Sync installs only allow-listed refs,
 * and scheduled task fire re-checks the same local grant so a stale native
 * entry cannot bypass a later disable.
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
 *   - `"warn"`  — first-party stash, or a third-party stash whose only
 *                 findings are the interactive-tool group, or an explicit
 *                 `--allow-dangerous-env-keys`; warn the operator but inject anyway.
 *   - `"block"` — a third-party stash injects a genuine RCE-class key with no
 *                 bypass given.
 */
export type DangerousEnvInjectionDecision = "allow" | "warn" | "block";

/**
 * `EDITOR`/`VISUAL`/`PAGER` are flagged by `isDangerousEnvKey` for a
 * documented RCE vector (many tools invoke them to launch an editor/pager),
 * but env-key-rules.ts's own module doc calls out their "high FP rate" in
 * the same breath — an installed bundle's env file can supply a value, but
 * nothing in akm's own env-injection path ever *invokes* EDITOR/VISUAL/PAGER
 * with that value, so the RCE vector these three describe cannot fire from
 * an injected env the way LD_PRELOAD or GIT_SSH_COMMAND can. Blocking a
 * third-party install over them protects nothing while making "the operator
 * legitimately wants to set their editor" the common case that eats the
 * refusal. Kept as a name-level literal set (not an import of
 * `commands/lint/env-key-rules.ts`) so this module stays the pure leaf its
 * own doc comment promises — no new import edges into the rest of the tree.
 */
const INTERACTIVE_TOOL_ENV_KEYS = new Set(["EDITOR", "VISUAL", "PAGER"]);

/**
 * Decide whether injecting an env with the given dangerous keys is allowed,
 * warned, or blocked. Third-party (registry-installed) stashes hard-block a
 * genuine RCE-class key; first-party stashes warn. The interactive-tool
 * group (see {@link INTERACTIVE_TOOL_ENV_KEYS}) only ever warns, since akm's
 * own env-injection path never invokes those keys as a command. An explicit
 * `--allow-dangerous-env-keys` (threaded through by the caller, same override
 * `decideDangerousKeyInstall`'s `"warn-allow"` already honors for rule 2)
 * downgrades a remaining block to a warning too — the operator is not racing
 * themselves. See rule 1 above.
 *
 * @param dangerousKeys The subset of injected keys flagged as process-hijacking
 *   (already filtered by the caller via `isDangerousEnvKey`).
 * @param thirdParty `true` when the env's source is a third-party stash — i.e.
 *   its origin carries a `registryId`.
 * @param allowDangerousEnvKeys `true` when the operator passed `--allow-dangerous-env-keys` (or
 *   its equivalent) for this injection. Defaults to `false`.
 */
export function decideDangerousEnvInjection(input: {
  dangerousKeys: readonly string[];
  thirdParty: boolean;
  allowDangerousEnvKeys?: boolean;
}): DangerousEnvInjectionDecision {
  if (input.dangerousKeys.length === 0) return "allow";
  if (!input.thirdParty) return "warn";
  if (input.allowDangerousEnvKeys) return "warn";
  const onlyInteractiveTool = input.dangerousKeys.every((key) => INTERACTIVE_TOOL_ENV_KEYS.has(key));
  return onlyInteractiveTool ? "warn" : "block";
}

// ── Rule 2: freshly-installed stash dangerous-key scan (add-cli.ts) ──────────

/**
 * The baseline stance on installing a stash whose env files contain dangerous
 * keys.
 *   - `"allow"`      — no findings; install proceeds silently.
 *   - `"warn-allow"` — findings present but the operator passed
 *                      `--allow-dangerous-env-keys`; warn and proceed.
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
  allowDangerousEnvKeys: boolean;
}): DangerousKeyInstallStance {
  if (!input.findingsPresent) return "allow";
  return input.allowDangerousEnvKeys ? "warn-allow" : "gate";
}

// ── Rule 3: write activation (search-source.ts, installations.ts) ────────────

/**
 * Whether a resolved source is write-activated. Only the primary stash and
 * sources explicitly marked `writable: true` are writable; registry-cached
 * (installed, read-only) sources are never written in place because
 * `akm update` overwrites them. See rule 3 above.
 */
export function isSourceWriteActivated(source: { writable?: boolean }): boolean {
  return source.writable === true;
}
