// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { getStringArg, parsePositiveIntFlag } from "../../cli/parse-args";
import { defineJsonCommand, output } from "../../cli/shared";
import { VALID_ADAPTER_IDS } from "../../core/adapter/adapter-ids";
import { UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { warn } from "../../core/warn";
import { auditStashForDangerousKeys, type DangerousKeyAuditDecision } from "./dangerous-env-audit";
import { akmRemove } from "./installed-stashes";
import { akmAdd } from "./source-add";
import { addStash } from "./source-manage";

// ── Shared website-options helper ──────────

export function buildWebsiteOptions(args: Record<string, unknown>): { maxPages?: number; maxDepth?: number } {
  // getStringArg maps absent/blank to undefined; parsePositiveIntFlag maps
  // undefined to undefined — so an unsupplied flag simply omits the key.
  const maxPages = parsePositiveIntFlag(getStringArg(args, "max-pages"), "--max-pages");
  const maxDepth = parsePositiveIntFlag(getStringArg(args, "max-depth"), "--max-depth");
  return { ...(maxPages !== undefined ? { maxPages } : {}), ...(maxDepth !== undefined ? { maxDepth } : {}) };
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

/**
 * Audit a freshly-installed stash for dangerous env keys and decide whether the
 * install must be blocked. The scanner and decision policy are shared with
 * `bundle update` in dangerous-env-audit.ts.
 */
export async function auditInstalledStashForDangerousKeys(opts: {
  installedStashRoot: string;
  ref: string;
  allowDangerousKeys: boolean;
  rollbackTarget: string;
  isTTY: boolean;
}): Promise<DangerousKeyAuditDecision> {
  const { installedStashRoot, ref, allowDangerousKeys, rollbackTarget, isTTY } = opts;
  return auditStashForDangerousKeys({
    stashRoot: installedStashRoot,
    ref,
    allowDangerousKeys,
    isTTY,
    operation: "install",
    rollback: async () => {
      try {
        await akmRemove({ target: rollbackTarget });
        return undefined;
      } catch {
        return (
          `Rollback failed — stash may still be installed at ${installedStashRoot}. ` +
          `Remove it manually with: akm bundle remove ${rollbackTarget}`
        );
      }
    },
  });
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
    adapter: {
      type: "string",
      description:
        "Override the auto-detected component adapter for a local directory (#909). One of: " +
        `${VALID_ADAPTER_IDS.join(", ")}.`,
    },
    writable: {
      type: "boolean",
      description: "Mark a git bundle as writable so changes can be pushed back",
      default: false,
    },
    before: { type: "string", description: "Insert the new bundle before this configured bundle" },
    after: { type: "string", description: "Insert the new bundle after this configured bundle" },
    "max-pages": { type: "string", description: "Maximum pages to crawl for website sources (default: 50)" },
    "max-depth": { type: "string", description: "Maximum crawl depth for website sources (default: 3)" },
    "allow-insecure": {
      type: "boolean",
      description:
        "Allow a plain HTTP source URL and skip confirmation for dangerous env keys (e.g. LD_PRELOAD, PATH). Use only after explicitly reviewing the bundle.",
      default: false,
    },
  },
  async run({ args }) {
    const ref = args.ref.trim();
    const allowInsecure = args["allow-insecure"];
    const allowDangerousKeys = allowInsecure;
    if (args.before && args.after) throw new UsageError("Only one of --before or --after may be used.");

    // --provider → declarative bundle source (URL for git/website; bare
    // package spec for npm — R-013). Config-only write; content is not
    // synced until a later `akm update`.
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
        before: args.before,
        after: args.after,
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

    const result = await akmAdd({
      ref,
      name: args.name,
      options: Object.keys(websiteOptions).length > 0 ? websiteOptions : undefined,
      writable: args.writable,
      adapter: args.adapter,
      before: args.before,
      after: args.after,
    });
    appendEvent({
      eventType: "add",
      metadata: {
        target: ref,
        name: args.name ?? null,
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
      // The audit RETURNS its decision; we decide the exit outcome here,
      // OUTSIDE any catch, so the abort cannot be lost to a swallowed
      // exception (C3). F4: `process.exitCode = …; return;` instead of
      // `process.exit(...)` — the DANGEROUS_ENV_KEY error envelope has
      // already been written to stderr by the audit itself (or is about to
      // be), so an explicit `return` here (skipping the success `output("add",
      // …)` below) is load-bearing, not merely cosmetic: it is what stops a
      // blocked install from ALSO printing a success envelope.
      const decision = await auditInstalledStashForDangerousKeys({
        installedStashRoot,
        ref,
        allowDangerousKeys,
        rollbackTarget,
        isTTY: process.stdin.isTTY === true,
      });
      if (decision.blocked) {
        process.exitCode = decision.exitCode;
        return;
      }
    }

    output("add", result);
  },
});
