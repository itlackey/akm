/**
 * Vault security lint rules — flags known-dangerous environment variable names.
 *
 * These env var names, when present as vault keys, indicate the vault can be
 * used to hijack process execution via loader injection, path override, or
 * shell/runtime startup hooks.  The lint pass emits a warning-level finding;
 * it does NOT block vault load or `akm add` installation.
 */

import { listKeys } from "../vault";
import type { LintIssue } from "./types";

// ── Dangerous key set ─────────────────────────────────────────────────────────

export const DANGEROUS_VAULT_KEYS = new Set([
  // Dynamic linker hijacking (Linux)
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "LD_DEBUG",
  // Dynamic linker hijacking (macOS)
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  // Shell and command resolution
  "PATH",
  "BASH_ENV",
  "ENV",
  "PROMPT_COMMAND",
  "PS1",
  "PS2",
  // Language runtime hijacking
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "PYTHONINSPECT",
  "RUBYLIB",
  "RUBYOPT",
  "PERL5LIB",
  "PERL5OPT",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "_JAVA_OPTIONS",
]);

// ── Checker ───────────────────────────────────────────────────────────────────

/**
 * Inspect a vault `.env` file and return a lint finding for every key whose
 * name appears in `DANGEROUS_VAULT_KEYS`.
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
    if (!DANGEROUS_VAULT_KEYS.has(key)) continue;
    issues.push({
      file: relPath,
      issue: "dangerous-vault-key",
      detail: `Vault key \`${key}\` can be used to hijack process execution when injected via \`akm vault run\`. Vault ref: ${vaultRef}. Review this vault file before running \`akm vault run\` commands against untrusted stashes.`,
      fixed: false,
    });
  }

  return issues;
}
