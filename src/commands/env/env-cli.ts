// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm env` command family. Extracted verbatim from src/cli.ts (WS6) so the God
 * Module shrinks; the `main.subCommands.env` key and every subcommand's
 * args/output shape are byte-identical. The ref-resolution helpers
 * (parseEnvRef / findEnvSource / makeEnvRef / resolveEnvPath + the env-path
 * traversal guard) live in src/core/env-secret-ref.ts so env + secret share one
 * copy.
 *
 * `akm env` manages whole `.env` files under each stash's env/ directory.
 * Values and comment text are NEVER written to stdout or structured output —
 * only key NAMES are surfaced (comments routinely contain commented-out
 * credentials). akm does not manage individual entries;
 * you edit the `.env` file yourself and akm loads it. Replaced the deprecated
 * `vault` type (removed in 0.9.0).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getParsedInvocation } from "../../cli/invocation";
import { getStringArg } from "../../cli/parse-args";
import { defineGroupCommand, defineJsonCommand, output } from "../../cli/shared";
import { writeFileAtomic } from "../../core/common";
import {
  listEnvsRecursive,
  makeEnvRef,
  resolveEnvPath,
  resolveEnvWriteTarget,
  sensitiveMarkerPath,
  withEnvSecretWrite,
} from "../../core/env-secret-ref";
import { ConfigError, NotFoundError, UsageError } from "../../core/errors";
import { readStdin } from "../../runtime";
import { buildChildEnv } from "./child-env";

const envListCommand = defineJsonCommand({
  meta: { name: "list", description: "List all env files across all bundles with their key names (no values)" },
  async run() {
    const { listKeys } = await import("./env.js");
    output("env-list", { envs: listEnvsRecursive(listKeys) });
  },
});

const envCreateCommand = defineJsonCommand({
  meta: {
    name: "create",
    description:
      "Create an env file (empty by default; seed an existing `.env` with --from-file or --from-stdin). No-op if it already exists and no source is given.",
  },
  args: {
    name: {
      type: "positional",
      description: "Env name (flat, e.g. prod → prod.env; use --path for a subdirectory)",
      required: true,
    },
    path: {
      type: "string",
      description:
        "Relative subdirectory under env/ to place the env file in (e.g. 'staging'). The filename comes from the name.",
    },
    "from-file": { type: "string", description: "Seed the env file from an existing .env at this path" },
    "from-stdin": { type: "boolean", description: "Seed the env file from stdin", default: false },
    sensitive: {
      type: "boolean",
      description: "Exclude this env file from env list output and the search index",
      default: false,
    },
    target: {
      type: "string",
      description:
        "Override the write destination. Accepts a source name from your config; falls back to defaultWriteTarget then the working bundle.",
    },
  },
  async run({ args }) {
    const { createEnv, writeEnv } = await import("./env.js");
    // `create` always targets env/, never the frozen vaults/ copy. `--path` is
    // the subdirectory; `--target` selects the writable destination source.
    const { name, absPath, target, ref } = resolveEnvWriteTarget(args.name, args.target, {
      subPath: getStringArg(args, "path"),
    });

    const fromFile = args["from-file"];
    const fromStdin = args["from-stdin"] === true;
    if (fromFile !== undefined && fromStdin) {
      throw new UsageError("Pass only one of --from-file or --from-stdin.", "INVALID_FLAG_VALUE");
    }

    let content: string | undefined;
    if (fromFile !== undefined || fromStdin) {
      // Ingest path: never silently clobber an existing env file.
      if (fs.existsSync(absPath)) {
        throw new UsageError(
          `Env "${ref}" already exists. Remove it first (\`akm env remove\`) or edit the file directly.`,
          "RESOURCE_ALREADY_EXISTS",
        );
      }
      if (fromFile !== undefined) {
        if (!fs.existsSync(fromFile)) {
          throw new NotFoundError(`Source file not found: ${fromFile}`, "FILE_NOT_FOUND");
        }
        content = fs.readFileSync(fromFile, "utf8");
      } else {
        const buf = await readStdin();
        content = buf.toString("utf8");
      }
    }

    const written = [absPath];
    const markerPath = sensitiveMarkerPath(absPath, "env");
    if (args.sensitive) {
      written.push(markerPath);
    }
    withEnvSecretWrite(target, { type: "env", name }, "Update", written, () => {
      if (content !== undefined) writeEnv(absPath, content);
      else createEnv(absPath);
      if (args.sensitive) {
        if (!fs.existsSync(markerPath)) {
          writeFileAtomic(markerPath, "", 0o600);
        }
      }
    });
    output("env-create", { ref });
  },
});

const envPathCommand = defineJsonCommand({
  meta: {
    name: "path",
    description:
      "Print the absolute env file path (Docker `_FILE` convention / `--env-file`). To inject values, use `akm env run <ref> -- <cmd>` — do NOT `source` the raw file.",
  },
  args: {
    ref: { type: "positional", description: "Env ref", required: true },
    quiet: { type: "boolean", alias: "q", description: "Suppress the unsafe-source warning", default: false },
  },
  async run({ args }) {
    const { name, absPath, source } = resolveEnvPath(args.ref);
    if (!fs.existsSync(absPath)) {
      throw new NotFoundError(`Env not found: ${makeEnvRef(name, source)}`);
    }
    // The raw `.env` may contain `X=$(cmd)`, which executes if `source`d.
    // Warning goes to stderr (never contaminates the path on stdout) and is
    // suppressed with --quiet for the legitimate `_FILE` / `--env-file` use.
    if (args.quiet !== true) {
      process.stderr.write(
        `warning: this is the raw file path. Do NOT \`source\` it (shell substitutions in the file would execute).\n` +
          `         To inject values run: akm env run ${args.ref} -- <command>\n`,
      );
    }
    // F3/B3: this stdout write IS the payload — a bare absolute path for
    // shell substitution (`$(akm env path <ref>)`, Docker `_FILE` /
    // `--env-file`) — not a field inside a result envelope. `env path` is
    // now declared format-exempt (src/output/format-exempt.ts, same
    // classification as `env run`/`secret run`/`help`), so `--format`
    // WARNS rather than doing anything to this write (src/cli.ts's startup
    // `isFormatExemptCommand` check). An earlier version of this fix routed
    // this through `output()` with a `{ path }` envelope so `--format`
    // "worked" — but the CLI's process-wide default format is `json`, so a
    // bare `akm env path <ref>` (exactly how `$(akm env path foo)` is
    // written, with no explicit `--format`) started emitting
    // `{"path":"..."}` instead of the raw path, breaking every existing
    // shell substitution silently. Declaring the exemption is the correct
    // fix: it keeps this byte-identical to history and makes the
    // already-broken combination (`--format` + this command) loud instead
    // of silent, per STABILITY.md's promise for exempt commands.
    process.stdout.write(`${absPath}\n`);
  },
});

const envExportCommand = defineJsonCommand({
  meta: {
    name: "export",
    description:
      "Write safe `export KEY='value'` lines to a file (mode 0600) for `source`-ing — requires --out <path>. Values are re-serialised single-quoted so a raw `.env` cannot execute on load, and are NEVER printed to stdout. To use values directly, prefer `akm env run <ref> -- <command>`.",
  },
  args: {
    ref: { type: "positional", description: "Env ref", required: true },
    out: { type: "string", alias: "o", description: "Destination file (required). Written at mode 0600." },
  },
  async run({ args }) {
    const outPath = args.out;
    if (!outPath) {
      throw new UsageError(
        "`akm env export` writes to a file — pass --out <path>.\n" +
          "       To use values directly, run `akm env run <ref> -- <command>` (or `-- $SHELL` for an interactive\n" +
          "       session). export never prints values to stdout, to avoid leaking them into a captured context.",
        "MISSING_REQUIRED_ARGUMENT",
      );
    }
    const { name, absPath, source } = resolveEnvPath(args.ref);
    if (!fs.existsSync(absPath)) {
      throw new NotFoundError(`Env not found: ${makeEnvRef(name, source)}`);
    }
    const { buildShellExportScript } = await import("./env.js");
    const resolvedOut = path.resolve(outPath);
    writeFileAtomic(resolvedOut, buildShellExportScript(absPath), 0o600);
    output("env-export", { ref: makeEnvRef(name, source), out: resolvedOut });
  },
});

/**
 * Shared implementation for `env run`. Injects an entire env file's values into
 * the child process env — never via a shell — after scanning the injected keys
 * for process-hijacking variables.
 */
async function runEnvInjected(
  target: string,
  opts: { only?: string[]; except?: string[]; clean?: boolean; inherit?: string[]; allowInsecure?: boolean },
): Promise<void> {
  const command = getParsedInvocation().passthroughArgs();
  if (command.length === 0) {
    throw new UsageError("Missing command. Usage: akm env run <ref> -- <command>");
  }

  const { name, absPath, source } = resolveEnvPath(target);
  if (!fs.existsSync(absPath)) {
    // Help users who reach for the removed single-key `ref/KEY` form.
    const slash = target.lastIndexOf("/");
    if (slash > 0) {
      const maybeKey = target.slice(slash + 1);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(maybeKey)) {
        let baseExists = false;
        try {
          baseExists = fs.existsSync(resolveEnvPath(target.slice(0, slash)).absPath);
        } catch {
          baseExists = false;
        }
        if (baseExists) {
          throw new UsageError(
            `'akm env run' injects the whole file; the single-key '<ref>/${maybeKey}' form was removed.\n` +
              `       For one value use a secret: \`akm secret run secrets/${maybeKey} ${maybeKey} -- <command>\`.`,
            "INVALID_FLAG_VALUE",
          );
        }
      }
    }
    throw new NotFoundError(`Env not found: ${makeEnvRef(name, source)}`);
  }

  // Load → filter → secret-substitute → dangerous-key policy → keys-only
  // audit event. Shared with the workflow engine's per-unit env bindings —
  // see env-binding.ts for the extracted core and its safety invariants.
  const { resolveEnvBinding } = await import("./env-binding.js");
  const { values: envValues } = resolveEnvBinding(target, {
    only: opts.only,
    except: opts.except,
    allowInsecure: opts.allowInsecure,
  });

  const mergedEnv = buildChildEnv(process.env, {
    clean: opts.clean === true,
    inherit: opts.inherit ?? [],
  });
  for (const [envKey, envValue] of Object.entries(envValues)) {
    mergedEnv[envKey] = envValue;
  }

  const result = spawnSync(command[0] as string, command.slice(1), {
    stdio: "inherit",
    env: mergedEnv,
  });
  if (result.error) {
    // Classify spawn failures (#483). Raw ErrnoException leaks a bare
    // "spawn ENOENT" with no hint — wrap it so consumers get a usable
    // code + hint in the standard JSON envelope.
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new NotFoundError(
        `Command not found: ${command[0]}`,
        "FILE_NOT_FOUND",
        `Install '${command[0]}' or add its directory to PATH before invoking 'akm env run'.`,
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
  // R-067: was `process.exit(result.status ?? 0)`, which terminates the
  // process synchronously and skips the `finally { await
  // disposeDispatchResources(); }` block in src/cli.ts's `runCommand` — even
  // on the success path, since this call was unconditional. Setting
  // `process.exitCode` and returning lets cleanup run while still exiting
  // with the child's exact status once the event loop drains, matching the
  // pattern `emitJsonError` (src/cli/shared.ts) already established.
  process.exitCode = result.status ?? 0;
  return;
}

/** Parse a comma/space-separated key list flag into a trimmed, non-empty array. */
function parseKeyListFlag(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const keys = raw
    .split(/[,\s]+/)
    .map((k) => k.trim())
    .filter(Boolean);
  return keys.length > 0 ? keys : undefined;
}

const envRunCommand = defineJsonCommand({
  meta: {
    name: "run",
    description:
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal `${secret:NAME}` token syntax documented for users, not interpolation
      "Run a command with the env file injected into its environment: `akm env run <ref> -- <command>`. Use `-- $SHELL` for an interactive session. Restrict which variables are injected with --only / --except. Values may embed `${secret:NAME}` tokens, replaced at run time with the sibling `${secret:NAME}` value from the same bundle. Pass --clean to start the child with a minimal inherited environment instead of the full parent environment.",
  },
  args: {
    target: { type: "positional", description: "Env ref", required: true },
    only: {
      type: "string",
      description: "Inject ONLY these keys (comma-separated). Mutually exclusive with --except.",
    },
    except: { type: "string", description: "Inject all keys EXCEPT these (comma-separated)." },
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
    "allow-insecure": {
      type: "boolean",
      description:
        "Allow injecting a process-hijacking variable (e.g. LD_PRELOAD, GIT_SSH_COMMAND) from a third-party stash, which otherwise blocks. Use only after explicitly reviewing the env file.",
      default: false,
    },
  },
  async run({ args }) {
    await runEnvInjected(args.target, {
      only: parseKeyListFlag(args.only),
      except: parseKeyListFlag(args.except),
      clean: args.clean === true,
      inherit: parseKeyListFlag(args.inherit) ?? [],
      allowInsecure: args["allow-insecure"] === true,
    });
  },
});

const envRemoveCommand = defineJsonCommand({
  meta: { name: "remove", description: "Remove an env file (and its .sensitive marker, if any)" },
  args: {
    ref: { type: "positional", description: "Env ref", required: true },
    yes: { type: "boolean", alias: "y", description: "Skip confirmation prompt", default: false },
    target: {
      type: "string",
      description:
        "Override the write destination. Accepts a source name from your config; falls back to defaultWriteTarget then the working bundle.",
    },
  },
  async run({ args }) {
    const { name, absPath, target, ref } = resolveEnvWriteTarget(args.ref, args.target);
    const { confirmDestructive } = await import("../../cli/confirm.js");
    const confirmed = await confirmDestructive(`Remove env "${args.ref}"? This cannot be undone.`, {
      yes: args.yes === true,
    });
    if (!confirmed) {
      process.stderr.write("Aborted.\n");
      return;
    }
    if (!fs.existsSync(absPath)) {
      throw new NotFoundError(`Env not found: ${ref}`);
    }
    const { removeEnv } = await import("./env.js");
    const removed = withEnvSecretWrite(
      target,
      { type: "env", name },
      "Remove",
      [absPath, sensitiveMarkerPath(absPath, "env")],
      () => removeEnv(absPath),
    );
    output("env-remove", { ref, removed });
  },
});

export const envCommand = defineGroupCommand({
  meta: {
    name: "env",
    description:
      "Manage `.env` files — configuration values an app loads together (URLs, flags, and any credentials it needs).\n\n" +
      "Values may or may not be sensitive; akm protects them all the same way — key names are visible, values never appear in structured output. For a single sensitive value used on its own (an auth token, key, or cert), use `akm secret`.",
  },
  subCommands: {
    list: envListCommand,
    path: envPathCommand,
    export: envExportCommand,
    run: envRunCommand,
    create: envCreateCommand,
    remove: envRemoveCommand,
  },
  // No `defaultRun`: bare `akm env` is a usage error (exit 2), the canonical
  // bare-group behavior — owner ruling 12. Run `akm env list` for what the
  // bare form used to print.
});
