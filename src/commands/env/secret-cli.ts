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
 * are NEVER written to stdout or structured output. Values reach a command only
 * via `akm secret run` (injected into a child env var) or `akm secret path`
 * (the Docker /run/secrets + `_FILE` convention).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { defineCommand } from "citty";
import { getStringArg, hasSubcommand } from "../../cli/parse-args";
import { output, runWithJsonErrors } from "../../cli/shared";
import { deriveCanonicalAssetName } from "../../core/asset-spec";
import { loadConfig } from "../../core/config";
import { makeSecretRef, resolveSecretPath } from "../../core/env-secret-ref";
import { ConfigError, NotFoundError, UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { resolveSourceEntries } from "../../indexer/search/search-source";
import { getHyphenatedArg } from "../../output/context";

const SECRET_SUBCOMMAND_SET = new Set(["list", "path", "run", "set", "remove"]);

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
        if (fs.existsSync(`${full}.sensitive`)) continue;
        const canonical = deriveCanonicalAssetName("secret", secretsDir, full);
        if (!canonical) continue;
        result.push({ ref: makeSecretRef(canonical, source), path: full });
      }
    };
    walk(secretsDir);
  }
  return result;
}

const secretListCommand = defineCommand({
  meta: {
    name: "list",
    description: "List all secrets across all stashes by name (the file contents are never shown)",
  },
  run() {
    return runWithJsonErrors(async () => {
      output("secret-list", { secrets: listSecretsRecursive() });
    });
  },
});

const secretSetCommand = defineCommand({
  meta: {
    name: "set",
    description:
      "Create or overwrite a secret. The value is read from stdin by default (never via argv). Use --from-file <path> to import an existing file byte-exact, or --from-env <VAR> to read from an environment variable. Multi-line values are allowed.",
  },
  args: {
    ref: {
      type: "positional",
      description: "Secret ref (flat name, e.g. secret:deploy-key or just deploy-key; use --path for a subdirectory)",
      required: true,
    },
    path: {
      type: "string",
      description:
        "Relative subdirectory under secrets/ to place the secret in (e.g. 'team'). The filename comes from the name.",
    },
    "from-file": { type: "string", description: "Read the value from this file (stored byte-exact)" },
    "from-env": { type: "string", description: "Read the value from the named environment variable" },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      const { setSecret } = await import("./secret.js");
      const { name, absPath, source } = resolveSecretPath(args.ref, { subPath: getStringArg(args, "path") });

      const fromEnv = getHyphenatedArg<string>(args, "from-env");
      const fromFile = getHyphenatedArg<string>(args, "from-file");
      if (fromEnv !== undefined && fromFile !== undefined) {
        throw new UsageError("Pass only one of --from-file or --from-env (or use stdin).", "INVALID_FLAG_VALUE");
      }

      const MAX_SECRET_BYTES = 5 * 1024 * 1024; // 5 MB
      let value: Buffer;
      if (fromFile !== undefined) {
        if (!fs.existsSync(fromFile)) {
          throw new NotFoundError(`File not found: ${fromFile}`, "FILE_NOT_FOUND");
        }
        value = fs.readFileSync(fromFile);
        if (value.byteLength > MAX_SECRET_BYTES) {
          throw new UsageError("Secret exceeds the 5 MB limit.");
        }
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
        let totalBytes = 0;
        const chunks: Uint8Array[] = [];
        for await (const chunk of Bun.stdin.stream()) {
          totalBytes += chunk.byteLength;
          if (totalBytes > MAX_SECRET_BYTES) {
            throw new UsageError("Secret exceeds the 5 MB limit.");
          }
          chunks.push(chunk);
        }
        // Strip a single trailing newline so `echo "$TOKEN" | akm secret set`
        // stores the token without the shell-added newline. Use --from-file for
        // byte-exact storage of multi-line material (PEM keys, certs).
        value = Buffer.from(Buffer.concat(chunks).toString("utf8").replace(/\n$/, ""), "utf8");
      }

      setSecret(absPath, value);
      output("secret-set", { ref: makeSecretRef(name, source) });
    });
  },
});

const secretPathCommand = defineCommand({
  meta: {
    name: "path",
    description:
      "Print the absolute secret file path for the Docker `_FILE` convention, e.g. `MY_SECRET_FILE=$(akm secret path secret:deploy-key)`.",
  },
  args: {
    ref: { type: "positional", description: "Secret ref", required: true },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      const { name, absPath, source } = resolveSecretPath(args.ref);
      if (!fs.existsSync(absPath)) {
        throw new NotFoundError(`Secret not found: ${makeSecretRef(name, source)}`);
      }
      process.stdout.write(`${absPath}\n`);
    });
  },
});

const secretRunCommand = defineCommand({
  meta: {
    name: "run",
    description:
      "Run a command with a secret's value injected into an env var: `akm secret run <ref> <VAR> -- <command>`. The value is set as $VAR in the child process only.",
  },
  args: {
    ref: { type: "positional", description: "Secret ref", required: true },
    var: { type: "positional", description: "Environment variable name to inject the value into", required: true },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      // Validate the target env var name FIRST (before the command split) so a
      // dangerous/invalid name is rejected regardless of how the command is
      // supplied — and so the failure does not depend on argv parsing.
      const varName = args.var;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) {
        throw new UsageError(`"${varName}" is not a valid environment variable name.`, "INVALID_FLAG_VALUE");
      }
      const { isDangerousEnvKey } = await import("../lint/env-key-rules.js");
      if (isDangerousEnvKey(varName)) {
        throw new UsageError(
          `Refusing to inject a secret into "${varName}": it is a known process-hijacking variable (e.g. LD_PRELOAD, PATH).`,
          "INVALID_FLAG_VALUE",
        );
      }

      const dashIndex = process.argv.indexOf("--");
      if (dashIndex < 0 || dashIndex === process.argv.length - 1) {
        throw new UsageError("Missing command. Usage: akm secret run <ref> <VAR> -- <command>");
      }
      const command = process.argv.slice(dashIndex + 1);

      const { name, absPath, source } = resolveSecretPath(args.ref);
      if (!fs.existsSync(absPath)) {
        throw new NotFoundError(`Secret not found: ${makeSecretRef(name, source)}`);
      }
      const { readValue } = await import("./secret.js");

      const mergedEnv = { ...process.env };
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
      process.exit(result.status ?? 0);
    });
  },
});

const secretRemoveCommand = defineCommand({
  meta: { name: "remove", description: "Remove a secret (and its .sensitive marker, if any)" },
  args: {
    ref: { type: "positional", description: "Secret ref", required: true },
    yes: { type: "boolean", alias: "y", description: "Skip confirmation prompt", default: false },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      const { name, absPath, source } = resolveSecretPath(args.ref);
      const { confirmDestructive } = await import("../../cli/confirm.js");
      const confirmed = await confirmDestructive(`Remove secret "${args.ref}"? This cannot be undone.`, {
        yes: args.yes === true,
      });
      if (!confirmed) {
        process.stderr.write("Aborted.\n");
        return;
      }
      const { removeSecret } = await import("./secret.js");
      if (!fs.existsSync(absPath)) {
        throw new NotFoundError(`Secret not found: ${makeSecretRef(name, source)}`);
      }
      const removed = removeSecret(absPath);
      output("secret-remove", { ref: makeSecretRef(name, source), removed });
    });
  },
});

export const secretCommand = defineCommand({
  meta: {
    name: "secret",
    description:
      "Manage secrets — a single sensitive value used on its own for authentication (an API token, a PEM private key, a TLS cert), one value per file. Names are visible; the file contents are the value and never appear in structured output. For a group of related configuration loaded together, use `akm env`.",
  },
  subCommands: {
    list: secretListCommand,
    path: secretPathCommand,
    run: secretRunCommand,
    set: secretSetCommand,
    remove: secretRemoveCommand,
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      if (hasSubcommand(args, SECRET_SUBCOMMAND_SET)) return;
      output("secret-list", { secrets: listSecretsRecursive() });
    });
  },
});
