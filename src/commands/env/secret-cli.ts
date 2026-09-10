// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm secret` command family. Extracted verbatim from src/cli.ts (WS6) so the
 * God Module shrinks; the `main.subCommands.secret` key and every subcommand's
 * args/output shape are byte-identical. The ref-resolution helpers
 * (parseSecretRef / makeSecretRef / resolveSecretPath, plus the shared
 * findEnvSource) live in src/core/env-secret-ref.ts so env + secret share one
 * copy.
 *
 * `akm secret` manages whole-file secrets under each stash's secrets/ directory.
 * Unlike env files (.env key/value), the ENTIRE file is the secret value. The bytes
 * are NEVER written to stdout or structured output. The only value-use path is
 * `akm secret run` (injected into a child env var).
 *
 * `secret path` and `secret remove` were REMOVED in 0.9.0 (R-027 / D-49): an
 * audit found `path` resolved the ref through the read-side, all-sources
 * resolver while `remove` resolved it through the write-target resolver, so
 * `akm secret path <ref>` and `akm secret remove <ref>` could silently name
 * two DIFFERENT files when a ref existed in more than one stash — inspect one,
 * delete the other. The owner's ruling was to drop both subcommands rather
 * than reconcile the resolvers. A ref's file lives at `<bundle>/secrets/<name>`
 * (matching the ref exactly, e.g. `secrets/deploy-key` -> `secrets/deploy-key`
 * under a bundle root — `akm bundle list` prints each configured bundle's root
 * path); locate or delete it directly, or consume its value without touching
 * disk via `akm secret run <ref> <VAR> -- <command>`.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getParsedInvocation } from "../../cli/invocation";
import { getStringArg } from "../../cli/parse-args";
import { defineGroupCommand, defineJsonCommand, output } from "../../cli/shared";
import { decideDangerousEnvInjection } from "../../core/activation-policy";
import { deriveCanonicalAssetName } from "../../core/asset/asset-placement";
import { loadConfig } from "../../core/config/config";
import {
  makeSecretRef,
  resolveSecretPath,
  resolveSecretWriteTarget,
  sensitiveMarkerPath,
  withEnvSecretWrite,
} from "../../core/env-secret-ref";
import { ConfigError, NotFoundError, UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { warn } from "../../core/warn";
import { resolveSourceEntries } from "../../indexer/search/search-source";
import { readStdin } from "../../runtime";
import { buildChildEnv } from "./child-env";

function parseKeyListFlag(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const keys = raw
    .split(/[,\s]+/)
    .map((k) => k.trim())
    .filter(Boolean);
  return keys.length > 0 ? keys : undefined;
}

/** Walk `secrets/` across all stashes, returning one entry per secret file. */
function listSecretsRecursive(): Array<{ ref: string; path: string }> {
  const result: Array<{ ref: string; path: string }> = [];
  for (const source of resolveSourceEntries(undefined, loadConfig())) {
    const secretsDir = path.join(source.path, "secrets");
    if (!fs.existsSync(secretsDir)) continue;
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        if (entry.name.endsWith(".lock") || entry.name.endsWith(".sensitive")) continue;
        // A sibling `<name>.sensitive` marker suppresses listing.
        if (fs.existsSync(sensitiveMarkerPath(full, "secret"))) continue;
        const canonical = deriveCanonicalAssetName("secret", secretsDir, full);
        if (!canonical) continue;
        result.push({ ref: makeSecretRef(canonical, source), path: full });
      }
    };
    walk(secretsDir);
  }
  return result;
}

const secretListCommand = defineJsonCommand({
  meta: {
    name: "list",
    description: "List all secrets across all bundles by name (the file contents are never shown)",
  },
  async run() {
    output("secret-list", { secrets: listSecretsRecursive() });
  },
});

const secretSetCommand = defineJsonCommand({
  meta: {
    name: "set",
    description:
      "Create or overwrite a secret. The value is read from stdin by default (never via argv). Use --from-file <path> to import an existing file byte-exact, or --from-env <VAR> to read from an environment variable. Multi-line values are allowed.",
  },
  args: {
    ref: {
      type: "positional",
      description: "Secret ref (flat name, e.g. secrets/deploy-key or just deploy-key; use --path for a subdirectory)",
      required: true,
    },
    path: {
      type: "string",
      description:
        "Relative subdirectory under secrets/ to place the secret in (e.g. 'team'). The filename comes from the name.",
    },
    "from-file": { type: "string", description: "Read the value from this file (stored byte-exact)" },
    "from-env": { type: "string", description: "Read the value from the named environment variable" },
    target: {
      type: "string",
      description:
        "Override the write destination. Accepts a source name from your config; falls back to defaultWriteTarget then the working bundle.",
    },
  },
  async run({ args }) {
    const { setSecret } = await import("./secret.js");
    const { name, absPath, target, ref } = resolveSecretWriteTarget(args.ref, args.target, {
      subPath: getStringArg(args, "path"),
    });

    const fromEnv = args["from-env"];
    const fromFile = args["from-file"];
    if (fromEnv !== undefined && fromFile !== undefined) {
      throw new UsageError("Pass only one of --from-file or --from-env (or use stdin).", "INVALID_FLAG_VALUE");
    }

    let value: Buffer;
    if (fromFile !== undefined) {
      if (!fs.existsSync(fromFile)) {
        throw new NotFoundError(`File not found: ${fromFile}`, "FILE_NOT_FOUND");
      }
      value = fs.readFileSync(fromFile);
    } else if (fromEnv !== undefined) {
      const envVal = process.env[fromEnv];
      if (envVal === undefined) {
        throw new UsageError(`Environment variable "${fromEnv}" is not set.`, "INVALID_FLAG_VALUE");
      }
      value = Buffer.from(envVal, "utf8");
    } else {
      if (process.stdin.isTTY) {
        process.stderr.write(`Enter value for secret "${name}" (Ctrl-D when done):\n`);
      }
      const stdinBuf = await readStdin();
      // Strip a single trailing newline so `echo "$TOKEN" | akm secret set`
      // stores the token without the shell-added newline. Use --from-file for
      // byte-exact storage of multi-line material (PEM keys, certs).
      value = Buffer.from(stdinBuf.toString("utf8").replace(/\n$/, ""), "utf8");
    }

    withEnvSecretWrite(target, { type: "secret", name }, "Update", [absPath], () => setSecret(absPath, value));
    output("secret-set", { ref });
  },
});

const secretRunCommand = defineJsonCommand({
  meta: {
    name: "run",
    description:
      "Run a command with a secret's value injected into an env var: `akm secret run <ref> <VAR> -- <command>`. The value is set as $VAR in the child process only. Pass --clean to start the child with a minimal inherited environment instead of the full parent environment.",
  },
  args: {
    ref: { type: "positional", description: "Secret ref", required: true },
    var: { type: "positional", description: "Environment variable name to inject the value into", required: true },
    clean: {
      type: "boolean",
      description:
        "Start the child with a minimal inherited environment (PATH/HOME/locale/terminal basics) instead of the full parent environment.",
      default: false,
    },
    inherit: {
      type: "string",
      description:
        "When used with --clean, also inherit these parent env vars (comma-separated). Ignored without --clean.",
    },
  },
  async run({ args }) {
    // Validate the target env var name FIRST (before the command split) so a
    // dangerous/invalid name is rejected regardless of how the command is
    // supplied — and so the failure does not depend on argv parsing.
    const varName = args.var;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) {
      throw new UsageError(`"${varName}" is not a valid environment variable name.`, "INVALID_FLAG_VALUE");
    }

    const command = getParsedInvocation().passthroughArgs();
    if (command.length === 0) {
      throw new UsageError("Missing command. Usage: akm secret run <ref> <VAR> -- <command>");
    }

    const { name, absPath, source } = resolveSecretPath(args.ref);
    if (!fs.existsSync(absPath)) {
      throw new NotFoundError(`Secret not found: ${makeSecretRef(name, source)}`);
    }

    const { isDangerousEnvKey } = await import("../lint/env-key-rules.js");
    if (isDangerousEnvKey(varName)) {
      const detail = `"${varName}" is a known process-hijacking variable (e.g. LD_PRELOAD, PATH).`;
      const decision = decideDangerousEnvInjection({
        dangerousKeys: [varName],
        thirdParty: Boolean(source.registryId),
      });
      if (decision === "block") {
        throw new UsageError(
          `Refusing to inject a secret from a third-party stash into ${detail}\n` +
            "       Review the secret, then copy it into a first-party secret if you trust it.",
          "INVALID_FLAG_VALUE",
        );
      }
      warn(`Injecting a secret into ${detail} Injecting anyway (first-party stash).`);
    }

    const { readValue } = await import("./secret.js");

    const mergedEnv = buildChildEnv(process.env, {
      clean: args.clean === true,
      inherit: parseKeyListFlag(args.inherit) ?? [],
    });
    mergedEnv[varName] = readValue(absPath).toString("utf8");

    // Audit trail: record access by ref + var name only — never the value.
    appendEvent({
      eventType: "secret_access",
      ref: makeSecretRef(name, source),
      metadata: { var: varName },
    });

    const result = spawnSync(command[0] as string, command.slice(1), {
      stdio: "inherit",
      env: mergedEnv,
    });
    if (result.error) {
      const err = result.error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        throw new NotFoundError(
          `Command not found: ${command[0]}`,
          "FILE_NOT_FOUND",
          `Install '${command[0]}' or add its directory to PATH before invoking 'akm secret run'.`,
        );
      }
      if (err.code === "EACCES") {
        throw new ConfigError(
          `Command not executable: ${command[0]}`,
          "STASH_DIR_UNREADABLE",
          `Add execute permission ('chmod +x ${command[0]}') or invoke via an interpreter.`,
        );
      }
      throw err;
    }
    // R-067: was `process.exit(result.status ?? 0)`, unconditional even on
    // the success path — it skipped the `finally { await
    // disposeDispatchResources(); }` cleanup in src/cli.ts's `runCommand`.
    // Setting `process.exitCode` and returning still exits with the child's
    // exact status once the event loop drains, but lets cleanup run first —
    // same pattern `emitJsonError` (src/cli/shared.ts) already established.
    process.exitCode = result.status ?? 0;
    return;
  },
});

export const secretCommand = defineGroupCommand({
  meta: {
    name: "secret",
    description:
      "Manage secrets — one standalone sensitive value per file (an API token, a PEM private key, a TLS cert).\n\n" +
      "Names are visible; the file contents are the value and never appear in structured output. For a group of related configuration loaded together, use `akm env`. A secret's file lives at `<bundle>/secrets/<name>` (`akm bundle list` shows bundle roots) — read or delete it there directly, or consume its value without writing it anywhere via `akm secret run <ref> <VAR> -- <command>`.",
  },
  subCommands: {
    list: secretListCommand,
    run: secretRunCommand,
    set: secretSetCommand,
  },
  // No `defaultRun`: bare `akm secret` is a usage error (exit 2), the canonical
  // bare-group behavior — owner ruling 12. Run `akm secret list` for what the
  // bare form used to print.
});
