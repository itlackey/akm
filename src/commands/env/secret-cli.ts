// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm secret` command family. Extracted verbatim from src/cli.ts (WS6) so the
 * God Module shrinks; the `main.subCommands.secret` key and every subcommand's
 * args/output shape are byte-identical. The ref-resolution helpers
 * (parseSecretRef / makeSecretRef / resolveSecretPath) live in src/core/env-secret-ref.ts so env + secret share one
 * copy.
 *
 * `akm secret` manages whole-file secrets under each stash's secrets/ directory.
 * Unlike env files (.env key/value), the ENTIRE file is the secret value. The bytes
 * are NEVER written to stdout or structured output. The only value-use path is
 * `akm secret run` (injected into a child env var).
 *
 * `secret path` was REMOVED in 0.9.0 (R-027 / D-49) and `secret remove` with it: an
 * audit found `path` resolved the ref through the read-side, all-sources
 * resolver while `remove` resolved it through the write-target resolver, so the
 * two could silently name different files when a ref existed in more than one
 * bundle. `secret remove` is back (0.10) for Desktop and the browser UI, shaped
 * like `akm env remove`: it names its file through the write-target resolver
 * only, and `--bundle` picks the bundle.
 */

import fs from "node:fs";
import { getParsedInvocation } from "../../cli/invocation";
import { getStringArg } from "../../cli/parse-args";
import { defineGroupCommand, defineJsonCommand, output, reportChildExit } from "../../cli/shared";
import {
  findWriteTargetAsset,
  listSecrets,
  makeSecretRef,
  readSecret,
  resolveSecretWriteTarget,
  writeEnvSecret,
} from "../../core/env-secret-ref";
import { NotFoundError, UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { isTerminal, stderr } from "../../core/stdio";
import { readStdin } from "../../runtime";
import { buildChildEnv } from "./child-env";
import { runProgram } from "./injection";

function parseKeyListFlag(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const keys = raw
    .split(/[,\s]+/)
    .map((k) => k.trim())
    .filter(Boolean);
  return keys.length > 0 ? keys : undefined;
}

const secretListCommand = defineJsonCommand({
  meta: {
    name: "list",
    description: "List all secrets across all bundles by name (the file contents are never shown)",
  },
  async run() {
    output("secret-list", { secrets: listSecrets() });
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
      description: "Secret ref (flat name, e.g. secrets/deploy-key; use --path for a subdirectory)",
      required: true,
    },
    path: {
      type: "string",
      description: "Subdirectory under secrets/ (e.g. 'team')",
    },
    "from-file": { type: "string", description: "Read the value from this file (stored byte-exact)" },
    "from-env": { type: "string", description: "Read the value from the named environment variable" },
    bundle: {
      type: "string",
      description: "Write destination: a source name (default: defaultWriteTarget)",
    },
  },
  async run({ args }) {
    const resolution = resolveSecretWriteTarget(args.ref, args.bundle, { subPath: getStringArg(args, "path") });
    const { name, ref } = resolution;

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
      if (isTerminal(0)) {
        stderr().write(`Enter value for secret "${name}" (Ctrl-D when done):\n`);
      }
      const stdinBuf = await readStdin();
      // Strip a single trailing newline so `echo "$TOKEN" | akm secret set`
      // stores the token without the shell-added newline. Use --from-file for
      // byte-exact storage of multi-line material (PEM keys, certs).
      value = Buffer.from(stdinBuf.toString("utf8").replace(/\n$/, ""), "utf8");
    }

    writeEnvSecret(resolution, { op: "create", content: value });
    output("secret-set", { ref });
  },
});

const secretRunCommand = defineJsonCommand({
  meta: {
    name: "run",
    description:
      "Deprecated; put the command in a script asset under scripts/, run with `akm run --secret <ref>:<VAR> scripts/<file>`; removed in 0.11. Run a command with a secret's value injected into an env var: `akm secret run <ref> <VAR> -- <command>`. The value is set as $VAR in the child process only. Pass --clean to start the child with a minimal inherited environment instead of the full parent environment.",
  },
  args: {
    ref: { type: "positional", description: "Secret ref", required: true },
    var: { type: "positional", description: "Environment variable name to inject the value into", required: true },
    clean: {
      type: "boolean",
      description: "Start the child with a minimal inherited environment",
      default: false,
    },
    inherit: {
      type: "string",
      description: "With --clean, also inherit these parent env vars (comma-separated)",
    },
  },
  async run({ args }) {
    // Validate the target env var name FIRST (before the command split) so an
    // invalid name is rejected regardless of how the command is supplied — and
    // so the failure does not depend on argv parsing.
    const varName = args.var;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) {
      throw new UsageError(`"${varName}" is not a valid environment variable name.`, "INVALID_FLAG_VALUE");
    }

    const command = getParsedInvocation().passthroughArgs();
    if (command.length === 0) {
      throw new UsageError("Missing command. Usage: akm secret run <ref> <VAR> -- <command>");
    }

    const { conceptId, source, value } = readSecret(args.ref);

    const mergedEnv = buildChildEnv(process.env, {
      clean: args.clean === true,
      inherit: parseKeyListFlag(args.inherit) ?? [],
    });
    mergedEnv[varName] = value;

    // Audit trail: record access by ref + var name only — never the value.
    appendEvent({
      eventType: "secret_access",
      ref: makeSecretRef(conceptId, source),
      metadata: { var: varName },
    });

    const result = await runProgram({ argv: command, env: mergedEnv, capture: false });
    // R-067: was `process.exit(result.status ?? 0)`, unconditional even on
    // the success path — it skipped the `finally { disposeLlmUsageSink(); }`
    // cleanup in src/cli.ts's `runCommand`.
    // Setting `process.exitCode` and returning still exits with the child's
    // exact status once the event loop drains, but lets cleanup run first —
    // same pattern `emitJsonError` (src/cli/shared.ts) already established.
    reportChildExit(result.exitCode ?? 0);
    return;
  },
});

const secretRemoveCommand = defineJsonCommand({
  meta: { name: "remove", description: "Remove a secret file (and its .sensitive marker, if any)" },
  args: {
    ref: { type: "positional", description: "Secret ref", required: true },
    yes: { type: "boolean", alias: "y", description: "Skip confirmation prompt", default: false },
    bundle: {
      type: "string",
      description: "Write destination: a source name (default: defaultWriteTarget)",
    },
  },
  async run({ args }) {
    const resolution = resolveSecretWriteTarget(args.ref, args.bundle);
    const { ref } = resolution;
    const { confirmDestructive } = await import("../../cli/confirm.js");
    const confirmed = await confirmDestructive(`Remove secret "${args.ref}"? This cannot be undone.`, {
      yes: args.yes === true,
    });
    if (!confirmed) {
      stderr().write("Aborted.\n");
      return;
    }
    if (!findWriteTargetAsset(resolution)) throw new NotFoundError(`Secret not found: ${ref}`);
    writeEnvSecret(resolution, { op: "delete" });
    output("secret-remove", { ref, removed: true });
  },
});

export const secretCommand = defineGroupCommand({
  meta: {
    name: "secret",
    description:
      "Manage secrets — one standalone sensitive value per file (an API token, a PEM private key, a TLS cert).\n\n" +
      "Names are visible; the file contents are the value and never appear in structured output. For a group of related configuration loaded together, use `akm env`. A secret's file lives at `<bundle>/secrets/<name>` (`akm bundle list` shows bundle roots); consume its value without writing it anywhere by putting the command in a script asset and running it with `akm run --secret <ref>:<VAR> scripts/<file>`.",
  },
  subCommands: {
    list: secretListCommand,
    run: secretRunCommand,
    set: secretSetCommand,
    remove: secretRemoveCommand,
  },
  // Bare `akm secret` runs `akm secret list` (see insertBareListSubcommand in src/cli.ts).
});
