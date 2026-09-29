// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Environment security lint rules — flags known-dangerous variable names.
 *
 * These env var names, when present in an environment file, indicate the file can be
 * used to hijack process execution via loader injection, path override, or
 * shell/runtime startup hooks.  The lint pass emits a warning-level finding;
 * it does NOT block local environment edits.
 *
 * Enforcement scope:
 *   - `akm lint` reports findings as `dangerous-env-key` (non-blocking warn).
 *   - `akm bundle add` BLOCKS install unless `--allow-dangerous-env-keys` is set (or, on TTY,
 *     the user explicitly confirms at the prompt).
 *   - Local env writes do NOT consult this list — by design, the operator may
 *     legitimately store any key locally. The gate exists only for third-party
 *     stash installation.
 *
 * False-positive tradeoff:
 *   A handful of keys (EDITOR, VISUAL, PAGER) are included because they are
 *   invoked by many interactive tools and are a documented RCE vector when
 *   sourced from untrusted environments. They will also flag on benign files
 *   where the operator legitimately wants to set their editor — accept the
 *   FP and bypass with `--allow-dangerous-env-keys` after review.
 */

import fs from "node:fs";
import { listKeys } from "../env/env";
import type { LintIssue } from "./types";

// ── Dangerous key set ─────────────────────────────────────────────────────────

export const DANGEROUS_ENV_KEYS = new Set([
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
export const DANGEROUS_ENV_KEY_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    // CVE-2014-6271 (Shellshock) — bash imports exported functions named
    // `BASH_FUNC_<name>%%` and parses their bodies, enabling RCE.
    pattern: /^BASH_FUNC_/,
    reason: "Shellshock-class bash function injection (CVE-2014-6271)",
  },
  {
    pattern: /^GIT_CONFIG_/,
    reason: "Git config injection through environment override variables",
  },
];

/**
 * Returns `true` if the given key name is dangerous — either by literal match
 * against `DANGEROUS_ENV_KEYS` or by matching any entry in
 * `DANGEROUS_ENV_KEY_PATTERNS`.
 */
export function isDangerousEnvKey(key: string): boolean {
  if (DANGEROUS_ENV_KEYS.has(key)) return true;
  for (const { pattern } of DANGEROUS_ENV_KEY_PATTERNS) {
    if (pattern.test(key)) return true;
  }
  return false;
}

// ── Checker ───────────────────────────────────────────────────────────────────

/**
 * Inspect an `.env` file and return a lint finding for every key whose name
 * appears in `DANGEROUS_ENV_KEYS` or matches `DANGEROUS_ENV_KEY_PATTERNS`.
 *
 * @param envPath    Absolute path to the `.env` file.
 * @param relPath    Stash-relative path used as the `file` field in findings
 *                   (e.g. `"env/prod.env"`).
 * @param envRef     Human-readable env ref (e.g. `"env/prod"`) shown in
 *                   the finding message.
 */
/** Suppression comment token checked case-insensitively on the preceding non-empty line. */
const SUPPRESSION_COMMENT = "# akm-lint-ok: dangerous-env-key";

/**
 * Returns the set of keys suppressed by an inline `# akm-lint-ok: dangerous-env-key`
 * comment on the line immediately preceding the key assignment in the `.env` file.
 */
function collectSuppressedKeys(envPath: string): Set<string> {
  const suppressed = new Set<string>();
  let raw: string;
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch {
    return suppressed;
  }
  const lines = raw.split(/\r?\n/);
  let prevNonEmpty = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const keyMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (keyMatch && prevNonEmpty.toLowerCase() === SUPPRESSION_COMMENT) {
      suppressed.add(keyMatch[1]!);
    }
    prevNonEmpty = trimmed;
  }
  return suppressed;
}

export function checkEnvForDangerousKeys(envPath: string, relPath: string, envRef: string): LintIssue[] {
  const { keys } = listKeys(envPath);
  const suppressed = collectSuppressedKeys(envPath);
  const issues: LintIssue[] = [];

  for (const key of keys) {
    if (!isDangerousEnvKey(key)) continue;
    if (suppressed.has(key)) continue;
    issues.push({
      file: relPath,
      issue: "dangerous-env-key",
      detail: `Env key \`${key}\` can be used to hijack process execution when injected via \`akm env run\`. Ref: ${envRef}. Review this file before running \`akm env run\` commands against untrusted stashes. (suppress with: ${SUPPRESSION_COMMENT} on previous line)`,
      fixed: false,
    });
  }

  return issues;
}
