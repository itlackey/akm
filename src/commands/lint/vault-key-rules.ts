// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Vault security lint rules — flags known-dangerous environment variable names.
 *
 * These env var names, when present as vault keys, indicate the vault can be
 * used to hijack process execution via loader injection, path override, or
 * shell/runtime startup hooks.  The lint pass emits a warning-level finding;
 * it does NOT block vault load or `akm vault setKey`.
 *
 * Enforcement scope:
 *   - `akm lint` reports findings as `dangerous-vault-key` (non-blocking warn).
 *   - `akm add` BLOCKS install unless `--allow-insecure` is set (or, on TTY,
 *     the user explicitly confirms at the prompt).
 *   - `akm vault setKey` does NOT consult this list — by design, the operator
 *     owns their own vault and may legitimately store any key locally.  The
 *     gate exists only for third-party stash installation.
 *
 * False-positive tradeoff:
 *   A handful of keys (EDITOR, VISUAL, PAGER) are included because they are
 *   invoked by many interactive tools and are a documented RCE vector when
 *   sourced from untrusted vaults.  They will also flag on benign vaults
 *   where the operator legitimately wants to set their editor — accept the
 *   FP and bypass with `--allow-insecure` after review.
 */

import { listKeys } from "../vault";
import type { LintIssue } from "./types";

// ── Dangerous key set ─────────────────────────────────────────────────────────

export const DANGEROUS_VAULT_KEYS = new Set([
  // Dynamic linker hijacking (Linux glibc ld.so)
  "LD_PRELOAD", // forces shared library injection
  "LD_LIBRARY_PATH", // overrides library search path
  "LD_AUDIT", // loads auditing libs (CVE-class injection vector)
  "LD_DEBUG", // info disclosure / loader behaviour leak
  "LD_BIND_NOW", // eager symbol resolution — can trigger malicious libs
  "LD_PROFILE", // writes profile data — abusable for info disclosure
  "LD_ASSUME_KERNEL", // kernel-version spoofing affecting loader behaviour
  "LD_TRACE_LOADED_OBJECTS", // info disclosure (lists linked libs)
  // Dynamic linker hijacking (macOS dyld)
  "DYLD_INSERT_LIBRARIES", // macOS analogue of LD_PRELOAD
  "DYLD_LIBRARY_PATH", // overrides dyld library search path
  "DYLD_FRAMEWORK_PATH", // overrides framework search path
  // Shell and command resolution
  "PATH", // command lookup hijack
  "BASH_ENV", // sourced on non-interactive bash startup (RCE)
  "ENV", // sourced on POSIX sh startup (RCE)
  "PROMPT_COMMAND", // command run before each bash prompt (RCE)
  "PS1", // prompt — command substitution arbitrary code
  "PS2", // continuation prompt — command substitution
  "IFS", // Internal Field Separator — classic word-splitting attack
  // Shell startup hijack
  "ZDOTDIR", // zsh startup file lookup directory hijack
  // Language runtime hijacking — Node.js
  "NODE_OPTIONS", // injects flags incl. --require module-load RCE
  "NODE_PATH", // module resolution hijack
  "NODE_TLS_REJECT_UNAUTHORIZED", // silently disables TLS verification — MITM enabler
  // Language runtime hijacking — Python
  "PYTHONSTARTUP", // sourced by interactive python (RCE)
  "PYTHONPATH", // module resolution hijack
  "PYTHONINSPECT", // drops into REPL after script — sandbox escape vector
  "PYTHONHOME", // python install prefix hijack
  "PYTHONNOUSERSITE", // disables user-site isolation — sandbox weakening
  // Language runtime hijacking — Ruby
  "RUBYLIB", // ruby load path hijack
  "RUBYOPT", // injects ruby command-line opts
  // Language runtime hijacking — Perl
  "PERL5LIB", // perl @INC hijack
  "PERL5OPT", // injects perl command-line opts
  // Language runtime hijacking — Java
  "JAVA_TOOL_OPTIONS", // honoured by every JVM — flag injection / agent load
  "JDK_JAVA_OPTIONS", // JDK launcher options injection
  "_JAVA_OPTIONS", // legacy JVM options injection
  // Git (RCE via git invocations)
  "GIT_SSH_COMMAND", // replaces ssh with arbitrary command (RCE)
  "GIT_EXTERNAL_DIFF", // runs arbitrary command during diff (RCE)
  "GIT_PAGER", // runs arbitrary command for paging (RCE)
  "GIT_EDITOR", // runs arbitrary command for editor (RCE)
  // Interactive-tool invocation hijack — high FP rate but documented RCE vectors
  "EDITOR", // invoked by git, crontab, sudoedit, etc. (RCE)
  "VISUAL", // EDITOR fallback used by many tools (RCE)
  "PAGER", // invoked by git, man, systemctl, etc. (RCE)
]);

/**
 * Pattern-based dangerous key matchers.
 *
 * Some attack vectors target a family of variable names rather than a single
 * literal — most famously Shellshock (CVE-2014-6271), which exploits keys
 * prefixed with `BASH_FUNC_`.  Listing every concrete name is impossible; we
 * test against this pattern set in addition to the literal `Set`.
 */
export const DANGEROUS_VAULT_KEY_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    // CVE-2014-6271 (Shellshock) — bash imports exported functions named
    // `BASH_FUNC_<name>%%` and parses their bodies, enabling RCE.
    pattern: /^BASH_FUNC_/,
    reason: "Shellshock-class bash function injection (CVE-2014-6271)",
  },
];

/**
 * Returns `true` if the given key name is dangerous — either by literal match
 * against `DANGEROUS_VAULT_KEYS` or by matching any entry in
 * `DANGEROUS_VAULT_KEY_PATTERNS`.
 */
export function isDangerousVaultKey(key: string): boolean {
  if (DANGEROUS_VAULT_KEYS.has(key)) return true;
  for (const { pattern } of DANGEROUS_VAULT_KEY_PATTERNS) {
    if (pattern.test(key)) return true;
  }
  return false;
}

// ── Checker ───────────────────────────────────────────────────────────────────

/**
 * Inspect a vault `.env` file and return a lint finding for every key whose
 * name appears in `DANGEROUS_VAULT_KEYS` or matches a pattern in
 * `DANGEROUS_VAULT_KEY_PATTERNS`.
 *
 * @param vaultPath  Absolute path to the `.env` file.
 * @param relPath    Stash-relative path used as the `file` field in findings
 *                   (e.g. `"vaults/prod.env"`).
 * @param vaultRef   Human-readable vault ref (e.g. `"vault:prod"`) shown in
 *                   the finding message.
 */
export function checkVaultForDangerousKeys(vaultPath: string, relPath: string, vaultRef: string): LintIssue[] {
  const { keys } = listKeys(vaultPath);
  const issues: LintIssue[] = [];

  for (const key of keys) {
    if (!isDangerousVaultKey(key)) continue;
    issues.push({
      file: relPath,
      issue: "dangerous-vault-key",
      detail: `Vault key \`${key}\` can be used to hijack process execution when injected via \`akm vault run\`. Vault ref: ${vaultRef}. Review this vault file before running \`akm vault run\` commands against untrusted stashes.`,
      fixed: false,
    });
  }

  return issues;
}
