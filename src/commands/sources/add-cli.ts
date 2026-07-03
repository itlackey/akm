// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import * as p from "../../cli/clack";
import { defineJsonCommand, output } from "../../cli/shared";
import { UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { warn } from "../../core/warn";
import { akmRemove } from "./installed-stashes";
import { akmAdd } from "./source-add";
import { addStash } from "./source-manage";

// ── Shared website-options helper (also used by wikiRegisterCommand) ──────────

export function buildWebsiteOptions(args: Record<string, unknown>): Record<string, unknown> {
  const websiteOptions: Record<string, unknown> = {};
  if (typeof args["max-pages"] === "string" && args["max-pages"].length > 0)
    websiteOptions.maxPages = args["max-pages"];
  if (typeof args["max-depth"] === "string" && args["max-depth"].length > 0)
    websiteOptions.maxDepth = args["max-depth"];
  return websiteOptions;
}

// ── HTTP safety check ─────────────────────────────────────────────────────────

export function shouldWarnOnPlainHttp(ref: string): boolean {
  if (!ref.startsWith("http://")) return false;
  try {
    const hostname = new URL(ref).hostname.toLowerCase();
    return (
      hostname !== "localhost" &&
      hostname !== "127.0.0.1" &&
      hostname !== "0.0.0.0" &&
      hostname !== "::1" &&
      hostname !== "[::1]" &&
      !hostname.endsWith(".localhost")
    );
  } catch {
    return true;
  }
}

// ── Dangerous env-key install audit ───────────────────────────────────────────
//
// C3 (code-health round 2): the previous implementation wrapped the
// `process.exit(1)` abort in a broad try/catch and distinguished an intended
// exit from a real audit bug by string-matching `err.message === "process.exit
// called"` — a TEST mock sentinel. In production `process.exit` never throws, so
// that branch was test-only; worse, if the sentinel string ever drifted the
// DANGEROUS_VAULT_KEY abort would silently become fail-OPEN and an insecure
// stash would install, while the catch swallowed any genuine audit bug.
//
// This helper replaces that magic-string control flow with a typed decision.
// It performs the scan, the interactive confirmation, the rollback and the
// operator-facing error output internally, then RETURNS whether the install
// must be blocked. The caller decides `process.exit` OUTSIDE any catch, so a
// real audit bug can no longer be swallowed and the abort can no longer be
// silently bypassed. Only the best-effort *scan* is allowed to fail soft (no
// findings collected → nothing to block); once dangerous keys are found the
// gate is deterministic and fail-CLOSED.

export type DangerousKeyAuditDecision = { blocked: true; exitCode: number } | { blocked: false };

interface DangerousKeyFinding {
  vaultRef: string;
  keyName: string;
  relPath: string;
}

/** Scan every env file in the freshly-installed stash for dangerous env keys. */
function collectDangerousKeyFindings(
  installedStashRoot: string,
  checkEnvForDangerousKeys: (
    envPath: string,
    relPath: string,
    vaultRef: string,
  ) => Array<{ detail: string; file: string }>,
): DangerousKeyFinding[] {
  const allFindings: DangerousKeyFinding[] = [];
  const subdir = "env";
  const prefix = "env";
  const dir = path.join(installedStashRoot, subdir);
  const envFiles = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f: string) => f.endsWith(".env")) : [];
  for (const envFile of envFiles) {
    const envPath = path.join(dir, envFile);
    const baseName = path.basename(envFile, ".env");
    const vaultRef = baseName === "" ? `${prefix}:default` : `${prefix}:${baseName}`;
    const relPath = path.join(subdir, envFile);
    const findings = checkEnvForDangerousKeys(envPath, relPath, vaultRef);
    for (const finding of findings) {
      // Extract the key name from the detail string for the summary line.
      const keyMatch = finding.detail.match(/Env key `([^`]+)`/);
      const keyName = keyMatch ? keyMatch[1] : finding.file;
      allFindings.push({ vaultRef, keyName, relPath });
    }
  }
  return allFindings;
}

/**
 * Audit a freshly-installed stash for dangerous env keys and decide whether the
 * install must be blocked. Returns a typed decision instead of calling
 * `process.exit`, so the abort cannot be lost to a swallowed exception. See the
 * block comment above for the security rationale.
 */
export async function auditInstalledStashForDangerousKeys(opts: {
  installedStashRoot: string;
  ref: string;
  allowDangerousKeys: boolean;
  rollbackTarget: string;
  isTTY: boolean;
}): Promise<DangerousKeyAuditDecision> {
  const { installedStashRoot, ref, allowDangerousKeys, rollbackTarget, isTTY } = opts;

  // Best-effort scan: if collecting findings itself throws (corrupt env file,
  // fs error) there is nothing concrete to block on, so fail soft. Crucially,
  // this soft path runs BEFORE any findings exist — it can never re-open an
  // already-detected dangerous install.
  let allFindings: DangerousKeyFinding[];
  try {
    const { checkEnvForDangerousKeys } = await import("../lint/env-key-rules.js");
    allFindings = collectDangerousKeyFindings(installedStashRoot, checkEnvForDangerousKeys);
  } catch {
    return { blocked: false };
  }

  if (allFindings.length === 0) return { blocked: false };

  if (allowDangerousKeys) {
    // Operator has explicitly accepted the risk — warn and continue.
    for (const f of allFindings) {
      warn(
        `[dangerous-vault-key] ${f.relPath}: key \`${f.keyName}\` in ${f.vaultRef} can hijack process execution via \`akm env run\`. Proceeding because --allow-insecure was set.`,
      );
    }
    return { blocked: false };
  }

  // Helper: roll the install back before aborting. Rollback is best-effort; a
  // failed rollback never UN-blocks the install — we still abort, just with a
  // warning telling the operator to remove the stash manually.
  async function rollback(): Promise<string | undefined> {
    try {
      await akmRemove({ target: rollbackTarget });
      return undefined;
    } catch (_rollbackErr) {
      return (
        `Rollback failed — stash may still be installed at ${installedStashRoot}. ` +
        `Remove it manually with: akm remove ${rollbackTarget}`
      );
    }
  }

  if (isTTY) {
    // Interactive path: show findings and ask the user to confirm.
    // Guard on stdin (not stdout) because p.confirm() reads from stdin;
    // stdout may be a TTY while stdin is piped, which would cause a hang.
    const stashLabel = ref;
    const groupedByVault = new Map<string, string[]>();
    for (const f of allFindings) {
      const existing = groupedByVault.get(f.vaultRef) ?? [];
      existing.push(f.keyName);
      groupedByVault.set(f.vaultRef, existing);
    }
    for (const [vaultRef, keys] of groupedByVault) {
      warn(`[warn] Env "${vaultRef}" in stash "${stashLabel}" contains potentially dangerous keys:`);
      for (const key of keys) {
        warn(`  - ${key}: can hijack process execution via \`akm env run\``);
      }
    }
    const confirmed = await p.confirm({
      message: "Install anyway?",
      initialValue: false,
    });
    if (p.isCancel(confirmed) || confirmed !== true) {
      const rollbackWarning = await rollback();
      console.error(
        JSON.stringify(
          {
            ok: false,
            error:
              "Install aborted: stash contains dangerous env keys. Remove the keys or re-run with --allow-insecure to bypass.",
            code: "DANGEROUS_VAULT_KEY",
            ...(rollbackWarning ? { rollbackWarning } : {}),
          },
          null,
          2,
        ),
      );
      return { blocked: true, exitCode: 1 };
    }
    // Operator confirmed at the prompt — allow the install to proceed.
    return { blocked: false };
  }

  // Non-interactive path without bypass flag: fail hard.
  const rollbackWarning = await rollback();
  const keyList = allFindings.map((f) => `  - ${f.keyName} (${f.vaultRef})`).join("\n");
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: `Install blocked: stash "${ref}" contains dangerous env keys that can hijack process execution via \`akm env run\`:\n${keyList}\nRe-run with --allow-insecure to bypass this check after reviewing the env file.`,
        code: "DANGEROUS_VAULT_KEY",
        ...(rollbackWarning ? { rollbackWarning } : {}),
      },
      null,
      2,
    ),
  );
  return { blocked: true, exitCode: 1 };
}

// ── Command definition ────────────────────────────────────────────────────────

export const addCommand = defineJsonCommand({
  meta: {
    name: "add",
    description: "Add a source (local directory, website, npm package, GitHub repo, git URL, or remote provider)",
  },
  args: {
    ref: {
      type: "positional",
      description: "Path, URL, or registry ref (website URL, npm package, owner/repo, git URL, or local directory)",
      required: true,
    },
    provider: { type: "string", description: "Provider type (e.g. website, npm). Required for URL sources." },
    options: { type: "string", description: 'Provider options as JSON (e.g. \'{"apiKey":"key"}\').' },
    name: { type: "string", description: "Human-friendly name for the source" },
    writable: {
      type: "boolean",
      description: "Mark a git stash as writable so changes can be pushed back",
      default: false,
    },
    type: {
      type: "string",
      description: "Override asset type for all files in this stash (currently supports: wiki)",
    },
    "max-pages": { type: "string", description: "Maximum pages to crawl for website sources (default: 50)" },
    "max-depth": { type: "string", description: "Maximum crawl depth for website sources (default: 3)" },
    "allow-insecure": {
      type: "boolean",
      description:
        "Allow a plain HTTP source URL and skip confirmation for dangerous env keys (e.g. LD_PRELOAD, PATH). Use only after explicitly reviewing the stash.",
      default: false,
    },
  },
  async run({ args }) {
    const ref = args.ref.trim();
    const allowInsecure = args["allow-insecure"];
    const allowDangerousKeys = allowInsecure;

    // URL with --provider → stash source (remote or git provider)
    if (args.provider) {
      if (shouldWarnOnPlainHttp(ref)) {
        if (!allowInsecure) {
          throw new UsageError(
            "Source URL uses plain HTTP (not HTTPS). An on-path attacker could substitute a malicious payload. " +
              "Use https:// or pass --allow-insecure if you have explicitly accepted the risk.",
            "INVALID_FLAG_VALUE",
            "Re-run with `--allow-insecure` only after confirming the URL is trusted.",
          );
        }
        warn(
          "Warning: source URL uses plain HTTP (not HTTPS). --allow-insecure was set; an on-path attacker could substitute a malicious payload.",
        );
      }
      let parsedOptions: Record<string, unknown> | undefined;
      if (args.options) {
        try {
          const parsed = JSON.parse(args.options);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new UsageError("--options must be a JSON object");
          }
          parsedOptions = parsed;
        } catch (err) {
          if (err instanceof UsageError) throw err;
          throw new UsageError("--options must be valid JSON");
        }
      }
      const result = addStash({
        target: ref,
        name: args.name,
        providerType: args.provider,
        options: parsedOptions,
        writable: args.writable,
      });
      appendEvent({
        eventType: "add",
        metadata: { target: ref, provider: args.provider, name: args.name ?? null, writable: args.writable === true },
      });
      output("add", result);
      return;
    }

    if (shouldWarnOnPlainHttp(ref)) {
      if (!allowInsecure) {
        throw new UsageError(
          "Source URL uses plain HTTP (not HTTPS). An on-path attacker could substitute a malicious payload. " +
            "Use https:// or pass --allow-insecure if you have explicitly accepted the risk.",
          "INVALID_FLAG_VALUE",
          "Re-run with `--allow-insecure` only after confirming the URL is trusted.",
        );
      }
      warn(
        "Warning: source URL uses plain HTTP (not HTTPS). --allow-insecure was set; an on-path attacker could substitute a malicious payload.",
      );
    }
    const websiteOptions = buildWebsiteOptions(args);

    if (args.type === "wiki") {
      const { registerWikiSource } = await import("./source-add");
      const result = await registerWikiSource({
        ref,
        name: args.name,
        options: Object.keys(websiteOptions).length > 0 ? websiteOptions : undefined,
        writable: args.writable,
      });
      appendEvent({
        eventType: "add",
        metadata: { target: ref, type: "wiki", name: args.name ?? null, writable: args.writable === true },
      });
      output("add", result);
      return;
    }

    const result = await akmAdd({
      ref,
      name: args.name,
      overrideType: args.type,
      options: Object.keys(websiteOptions).length > 0 ? websiteOptions : undefined,
      writable: args.writable,
    });
    appendEvent({
      eventType: "add",
      metadata: {
        target: ref,
        name: args.name ?? null,
        overrideType: args.type ?? null,
        writable: args.writable === true,
      },
    });

    // ── Post-install env key audit ──────────────────────────────────────────
    // Resolve the stash root from the install result and scan any env files
    // for dangerous env var keys.  When findings are present the install is
    // gated: TTY → interactive confirmation prompt; non-TTY without
    // --allow-insecure → hard failure (exit 1).  Pass
    // --allow-insecure to skip the prompt non-interactively.
    const installedStashRoot =
      result.installed?.stashRoot ??
      (result.sourceAdded && "stashRoot" in result.sourceAdded ? result.sourceAdded.stashRoot : undefined);
    if (installedStashRoot) {
      // Use the canonical installed id (most reliably resolved by akmRemove) rather
      // than the raw user-supplied ref which may not match after URL normalisation.
      const rollbackTarget = result.installed?.id ?? result.sourceAdded?.stashRoot ?? ref;
      // The audit RETURNS its decision; we decide `process.exit` here, OUTSIDE
      // any catch, so the abort cannot be lost to a swallowed exception (C3).
      const decision = await auditInstalledStashForDangerousKeys({
        installedStashRoot,
        ref,
        allowDangerousKeys,
        rollbackTarget,
        isTTY: process.stdin.isTTY === true,
      });
      if (decision.blocked) {
        process.exit(decision.exitCode);
      }
    }

    output("add", result);
  },
});
