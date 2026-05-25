// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import { defineCommand } from "citty";
import { output, runWithJsonErrors } from "../cli/shared";
import { UsageError } from "../core/errors";
import { appendEvent } from "../core/events";
import { warn } from "../core/warn";
import { getHyphenatedBoolean } from "../output/context";
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

// ── Command definition ────────────────────────────────────────────────────────

export const addCommand = defineCommand({
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
        "Allow a plain HTTP source URL and skip confirmation for dangerous vault keys (e.g. LD_PRELOAD, PATH). Use only after explicitly reviewing the stash.",
      default: false,
    },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const ref = args.ref.trim();
      const allowInsecure = getHyphenatedBoolean(args, "allow-insecure");
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

      // ── Post-install vault key audit ────────────────────────────────────────
      // Resolve the stash root from the install result and scan any vault files
      // for dangerous env var keys.  When findings are present the install is
      // gated: TTY → interactive confirmation prompt; non-TTY without
      // --allow-insecure → hard failure (exit 1).  Pass
      // --allow-insecure to skip the prompt non-interactively.
      try {
        const installedStashRoot =
          result.installed?.stashRoot ??
          (result.sourceAdded && "stashRoot" in result.sourceAdded ? result.sourceAdded.stashRoot : undefined);
        if (installedStashRoot) {
          const { checkVaultForDangerousKeys } = await import("./lint/vault-key-rules.js");
          const vaultsDir = path.join(installedStashRoot, "vaults");
          if (fs.existsSync(vaultsDir)) {
            const envFiles = fs.readdirSync(vaultsDir).filter((f: string) => f.endsWith(".env"));

            // Collect all dangerous-key findings across every vault file.
            const allFindings: Array<{ vaultRef: string; keyName: string; relPath: string }> = [];
            for (const envFile of envFiles) {
              const vaultPath = path.join(vaultsDir, envFile);
              const baseName = path.basename(envFile, ".env");
              const vaultRef = baseName === "" ? "vault:default" : `vault:${baseName}`;
              const relPath = path.join("vaults", envFile);
              const findings = checkVaultForDangerousKeys(vaultPath, relPath, vaultRef);
              for (const finding of findings) {
                // Extract the key name from the detail string for the summary line.
                const keyMatch = finding.detail.match(/Vault key `([^`]+)`/);
                const keyName = keyMatch ? keyMatch[1] : finding.file;
                allFindings.push({ vaultRef, keyName, relPath });
              }
            }

            if (allFindings.length > 0) {
              if (allowDangerousKeys) {
                // Operator has explicitly accepted the risk — warn and continue.
                for (const f of allFindings) {
                  warn(
                    `[dangerous-vault-key] ${f.relPath}: key \`${f.keyName}\` in ${f.vaultRef} can hijack process execution via \`akm vault run\`. Proceeding because --allow-insecure was set.`,
                  );
                }
              } else if (process.stdin.isTTY) {
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
                  warn(`[warn] Vault "${vaultRef}" in stash "${stashLabel}" contains potentially dangerous keys:`);
                  for (const key of keys) {
                    warn(`  - ${key}: can hijack process execution via \`akm vault run\``);
                  }
                }
                const confirmed = await p.confirm({
                  message: "Install anyway?",
                  initialValue: false,
                });
                if (p.isCancel(confirmed) || confirmed !== true) {
                  // Roll back the install before aborting.
                  // Use the canonical installed id (most reliably resolved by akmRemove) rather
                  // than the raw user-supplied ref which may not match after URL normalisation.
                  const rollbackTarget = result.installed?.id ?? result.sourceAdded?.stashRoot ?? ref;
                  let rollbackWarning: string | undefined;
                  try {
                    await akmRemove({ target: rollbackTarget });
                  } catch (_rollbackErr) {
                    rollbackWarning =
                      `Rollback failed — stash may still be installed at ${installedStashRoot}. ` +
                      `Remove it manually with: akm remove ${rollbackTarget}`;
                  }
                  console.error(
                    JSON.stringify(
                      {
                        ok: false,
                        error:
                          "Install aborted: stash contains dangerous vault keys. Remove the keys or re-run with --allow-insecure to bypass.",
                        code: "DANGEROUS_VAULT_KEY",
                        ...(rollbackWarning ? { rollbackWarning } : {}),
                      },
                      null,
                      2,
                    ),
                  );
                  process.exit(1);
                }
              } else {
                // Non-interactive path without bypass flag: fail hard.
                // Roll back the install before exiting.
                // Use the canonical installed id (most reliably resolved by akmRemove) rather
                // than the raw user-supplied ref which may not match after URL normalisation.
                const rollbackTarget = result.installed?.id ?? result.sourceAdded?.stashRoot ?? ref;
                let rollbackWarning: string | undefined;
                try {
                  await akmRemove({ target: rollbackTarget });
                } catch (_rollbackErr) {
                  rollbackWarning =
                    `Rollback failed — stash may still be installed at ${installedStashRoot}. ` +
                    `Remove it manually with: akm remove ${rollbackTarget}`;
                }
                const keyList = allFindings.map((f) => `  - ${f.keyName} (${f.vaultRef})`).join("\n");
                console.error(
                  JSON.stringify(
                    {
                      ok: false,
                      error: `Install blocked: stash "${ref}" contains dangerous vault keys that can hijack process execution via \`akm vault run\`:\n${keyList}\nRe-run with --allow-insecure to bypass this check after reviewing the vault.`,
                      code: "DANGEROUS_VAULT_KEY",
                      ...(rollbackWarning ? { rollbackWarning } : {}),
                    },
                    null,
                    2,
                  ),
                );
                process.exit(1);
              }
            }
          }
        }
      } catch (auditErr) {
        // Only swallow errors that are NOT our intentional process.exit calls.
        if (auditErr instanceof Error && auditErr.message === "process.exit called") throw auditErr;
        // Vault key audit is best-effort; never fail the install on unexpected audit errors.
      }

      output("add", result);
    });
  },
});
