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
import { assertFlatAssetName, combineCreatePath, normalizeCreateSubPath } from "../../core/asset/asset-create";
import { assetPathForName, deriveCanonicalAssetName } from "../../core/asset/asset-placement";
import { isWithin, writeFileAtomic } from "../../core/common";
import { loadConfig } from "../../core/config/config";
import { findEnvSource, makeEnvRef, parseEnvRef, resolveEnvPath } from "../../core/env-secret-ref";
import { ConfigError, NotFoundError, UsageError } from "../../core/errors";
import { isQuiet } from "../../core/warn";
import { resolveSourceEntries } from "../../indexer/search/search-source";
import { readStdin } from "../../runtime";
import { buildChildEnv } from "./child-env";

/**
 * Walk each stash's env files and return one entry per `.env` file, using the
 * env asset spec's canonical-name logic (e.g. `env/team/prod.env` →
 * `env:team/prod`, `env/team/.env` → `env:team/default`).
 */
function listEnvsRecursive(
  listKeysFn: (envPath: string) => { keys: string[] },
): Array<{ ref: string; path: string; keys: string[] }> {
  const result: Array<{ ref: string; path: string; keys: string[] }> = [];
  for (const source of resolveSourceEntries(undefined, loadConfig())) {
    const root = path.join(source.path, "env");
    if (!fs.existsSync(root)) continue;

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        if (entry.name !== ".env" && !entry.name.endsWith(".env")) continue;
        const canonical = deriveCanonicalAssetName("env", root, full);
        if (!canonical) continue;
        // Skip sensitive envs: a sibling .sensitive marker file suppresses listing.
        const markerPath = full.replace(/\.env$/, ".sensitive");
        if (fs.existsSync(markerPath)) continue;
        const { keys } = listKeysFn(full);
        result.push({ ref: makeEnvRef(canonical, source), path: full, keys });
      }
    };
    walk(root);
  }
  return result;
}

const envListCommand = defineJsonCommand({
  meta: { name: "list", description: "List all env files across all stashes with their key names (no values)" },
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
  },
  async run({ args }) {
    const { createEnv, writeEnv } = await import("./env.js");
    // `create` always targets env/, never the frozen vaults/ copy.
    const parsed = parseEnvRef(args.name);
    // `name` is flat; subdirectory placement is `--path`'s job.
    assertFlatAssetName(parsed.name);
    parsed.name = combineCreatePath(normalizeCreateSubPath(getStringArg(args, "path")), parsed.name);
    const source = findEnvSource(parsed.origin);
    const envRoot = path.join(source.path, "env");
    const absPath = assetPathForName("env", envRoot, parsed.name);
    if (!isWithin(absPath, envRoot)) {
      throw new UsageError(`Env name "${parsed.name}" escapes the env directory.`);
    }

    const fromFile = args["from-file"];
    const fromStdin = args["from-stdin"] === true;
    if (fromFile !== undefined && fromStdin) {
      throw new UsageError("Pass only one of --from-file or --from-stdin.", "INVALID_FLAG_VALUE");
    }

    if (fromFile !== undefined || fromStdin) {
      // Ingest path: never silently clobber an existing env file.
      if (fs.existsSync(absPath)) {
        throw new UsageError(
          `Env "${makeEnvRef(parsed.name, source)}" already exists. Remove it first (\`akm env remove\`) or edit the file directly.`,
          "RESOURCE_ALREADY_EXISTS",
        );
      }
      let content: string;
      if (fromFile !== undefined) {
        if (!fs.existsSync(fromFile)) {
          throw new NotFoundError(`Source file not found: ${fromFile}`, "FILE_NOT_FOUND");
        }
        content = fs.readFileSync(fromFile, "utf8");
      } else {
        const MAX_ENV_BYTES = 1024 * 1024; // 1 MB
        const buf = await readStdin(
          MAX_ENV_BYTES,
          () => new UsageError("Env file exceeds 1 MB limit.", "INVALID_FLAG_VALUE"),
        );
        content = buf.toString("utf8");
      }
      writeEnv(absPath, content);
    } else {
      createEnv(absPath);
    }

    if (args.sensitive) {
      const markerPath = absPath.replace(/\.env$/, ".sensitive");
      if (!fs.existsSync(markerPath)) {
        fs.writeFileSync(markerPath, "", { mode: 0o600 });
      }
    }
    output("env-create", { ref: makeEnvRef(parsed.name, source) });
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
  opts: { only?: string[]; except?: string[]; clean?: boolean; inherit?: string[] },
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
              `       For one value use a secret: \`akm secret run secret:${maybeKey} ${maybeKey} -- <command>\`.`,
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
  process.exit(result.status ?? 0);
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
      "Run a command with the env file injected into its environment: `akm env run <ref> -- <command>`. Use `-- $SHELL` for an interactive session. Restrict which variables are injected with --only / --except. Values may embed `${secret:NAME}` tokens, replaced at run time with the sibling `secret:NAME` value from the same stash. Pass --clean to start the child with a minimal inherited environment instead of the full parent environment.",
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
  },
  async run({ args }) {
    await runEnvInjected(args.target, {
      only: parseKeyListFlag(args.only),
      except: parseKeyListFlag(args.except),
      clean: args.clean === true,
      inherit: parseKeyListFlag(args.inherit) ?? [],
    });
  },
});

const envRemoveCommand = defineJsonCommand({
  meta: { name: "remove", description: "Remove an env file (and its .sensitive marker, if any)" },
  args: {
    ref: { type: "positional", description: "Env ref", required: true },
    yes: { type: "boolean", alias: "y", description: "Skip confirmation prompt", default: false },
  },
  async run({ args }) {
    const parsed = parseEnvRef(args.ref);
    const source = findEnvSource(parsed.origin);
    const envRoot = path.join(source.path, "env");
    const absPath = assetPathForName("env", envRoot, parsed.name);
    if (!isWithin(absPath, envRoot)) {
      throw new UsageError(`Env name "${parsed.name}" escapes the env directory.`);
    }
    const { confirmDestructive } = await import("../../cli/confirm.js");
    const confirmed = await confirmDestructive(`Remove env "${args.ref}"? This cannot be undone.`, {
      yes: args.yes === true,
    });
    if (!confirmed) {
      process.stderr.write("Aborted.\n");
      return;
    }
    if (!fs.existsSync(absPath)) {
      throw new NotFoundError(`Env not found: ${makeEnvRef(parsed.name, source)}`);
    }
    const { removeEnv } = await import("./env.js");
    const removed = removeEnv(absPath);
    output("env-remove", { ref: makeEnvRef(parsed.name, source), removed });
  },
});

const envSetCommand = defineJsonCommand({
  meta: {
    name: "set",
    description:
      "Set (create or update) a single KEY in an env file: `akm env set <ref> <KEY>`. The value is read from stdin by default (never via argv); use --from-env <VAR> or --from-file <path>. Preserves existing comments and key order; the value is never printed. Creates the env file if it does not exist.",
  },
  args: {
    ref: { type: "positional", description: "Env ref (e.g. env:prod or just prod)", required: true },
    key: { type: "positional", description: "Key name to set (e.g. API_URL)", required: true },
    "from-env": { type: "string", description: "Read the value from the named environment variable" },
    "from-file": { type: "string", description: "Read the value from this file" },
  },
  async run({ args }) {
    const parsed = parseEnvRef(args.ref);
    const source = findEnvSource(parsed.origin);
    const envRoot = path.join(source.path, "env");
    const absPath = assetPathForName("env", envRoot, parsed.name);
    if (!isWithin(absPath, envRoot)) {
      throw new UsageError(`Env name "${parsed.name}" escapes the env directory.`);
    }
    const key = String(args.key);
    const { ENV_KEY_RE, setEnvKey } = await import("./env.js");
    if (!ENV_KEY_RE.test(key)) {
      throw new UsageError(`Invalid env key "${key}". Keys match [A-Za-z_][A-Za-z0-9_]*.`, "INVALID_FLAG_VALUE");
    }

    const fromEnv = args["from-env"];
    const fromFile = args["from-file"];
    if (fromEnv !== undefined && fromFile !== undefined) {
      throw new UsageError("Pass only one of --from-file or --from-env (or use stdin).", "INVALID_FLAG_VALUE");
    }
    const MAX_ENV_VALUE_BYTES = 1024 * 1024; // 1 MB
    let value: string;
    if (fromFile !== undefined) {
      if (!fs.existsSync(fromFile)) {
        throw new NotFoundError(`File not found: ${fromFile}`, "FILE_NOT_FOUND");
      }
      const buf = fs.readFileSync(fromFile);
      if (buf.byteLength > MAX_ENV_VALUE_BYTES) throw new UsageError("Value exceeds the 1 MB limit.");
      value = buf.toString("utf8");
    } else if (fromEnv !== undefined) {
      const v = process.env[fromEnv];
      if (v === undefined) {
        throw new UsageError(`Environment variable "${fromEnv}" is not set.`, "INVALID_FLAG_VALUE");
      }
      value = v;
    } else {
      const buf = await readStdin(MAX_ENV_VALUE_BYTES, () => new UsageError("Value exceeds the 1 MB limit."));
      // Strip a single trailing newline so `echo "$VAL" | akm env set` is exact.
      value = buf.toString("utf8").replace(/\n$/, "");
    }
    setEnvKey(absPath, key, value);
    // Warn (never block) on process-hijacking key names, matching the env-run audit.
    const { isDangerousEnvKey } = await import("../lint/env-key-rules.js");
    if (isDangerousEnvKey(key) && !isQuiet()) {
      process.stderr.write(
        `warning: "${key}" can influence process execution when this env is loaded via 'akm env run'.\n`,
      );
    }
    output("env-set", { ref: makeEnvRef(parsed.name, source), key });
  },
});

const envUnsetCommand = defineJsonCommand({
  meta: {
    name: "unset",
    description:
      "Remove one or more KEYs from an env file: `akm env unset <ref> <KEY...>`. Preserves other keys and comments. To remove the whole file, use `akm env remove`.",
  },
  args: {
    ref: { type: "positional", description: "Env ref (e.g. env:prod or just prod)", required: true },
    // `key` is read from the raw positionals (one or more) in run(); declared
    // non-required so citty doesn't block before we emit a structured error.
    key: { type: "positional", description: "Key name(s) to remove (one or more)", required: false },
  },
  async run({ args }) {
    const parsed = parseEnvRef(args.ref);
    const source = findEnvSource(parsed.origin);
    const envRoot = path.join(source.path, "env");
    const absPath = assetPathForName("env", envRoot, parsed.name);
    if (!isWithin(absPath, envRoot)) {
      throw new UsageError(`Env name "${parsed.name}" escapes the env directory.`);
    }
    if (!fs.existsSync(absPath)) {
      throw new NotFoundError(`Env not found: ${makeEnvRef(parsed.name, source)}`);
    }
    // citty puts every positional in `args._` (incl. the ref at [0]); the keys
    // are the remaining positionals. citty also mis-captures the space-separated
    // value of a global flag (`--format json`) as a positional, so drop any
    // token that is actually a global flag's value (cli.ts:1335 documents this).
    const invocation = getParsedInvocation();
    const globalFlagValues = new Set(
      ["--format", "--shape", "--detail", "--scope", "--filter", "--target"]
        .map((flag) => invocation.getFlagValue(flag))
        .filter((v): v is string => typeof v === "string"),
    );
    const keys = (Array.isArray(args._) ? (args._ as unknown[]).map(String) : [])
      .slice(1)
      .filter((k) => !globalFlagValues.has(k));
    if (keys.length === 0) {
      throw new UsageError("Usage: akm env unset <ref> <KEY...> (one or more keys).", "MISSING_REQUIRED_ARGUMENT");
    }
    const { ENV_KEY_RE, unsetEnvKeys } = await import("./env.js");
    const invalid = keys.filter((k) => !ENV_KEY_RE.test(k));
    if (invalid.length > 0) {
      throw new UsageError(`Invalid env key(s): ${invalid.join(", ")}.`, "INVALID_FLAG_VALUE");
    }
    const { removed, missing } = unsetEnvKeys(absPath, keys);
    output("env-unset", { ref: makeEnvRef(parsed.name, source), removed, missing });
  },
});

export const envCommand = defineGroupCommand({
  meta: {
    name: "env",
    description:
      "Manage `.env` files — a group of related CONFIGURATION values for an app or service (URLs, flags, plus any credentials it needs), loaded together. Values may or may not be sensitive; akm protects them all the same (key names visible, values never in structured output). For a single sensitive value used on its own (an auth token, key, or cert), use `akm secret`.",
  },
  subCommands: {
    list: envListCommand,
    path: envPathCommand,
    export: envExportCommand,
    run: envRunCommand,
    create: envCreateCommand,
    set: envSetCommand,
    unset: envUnsetCommand,
    remove: envRemoveCommand,
  },
  async defaultRun() {
    const { listKeys } = await import("./env.js");
    output("env-list", { envs: listEnvsRecursive(listKeys) });
  },
});
