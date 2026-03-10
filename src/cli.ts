#!/usr/bin/env bun
import fs from "node:fs"
import path from "node:path"
import { defineCommand, runMain } from "citty"
import {
  agentikitAdd,
  agentikitList,
  agentikitReinstall,
  agentikitRemove,
  agentikitSearch,
  agentikitShow,
  agentikitUpdate,
  type KnowledgeView,
} from "./stash"
import type { SearchSource, SearchUsageMode } from "./stash-types"
import { agentikitInit } from "./init"
import { agentikitIndex } from "./indexer"
import { agentikitClone } from "./stash-clone"
import { agentikitSubmit } from "./submit"

import { resolveStashSources } from "./stash-source"
import { loadConfig, saveConfig } from "./config"
import {
  getConfigValue,
  listConfig,
  listProviders,
  parseConfigValue,
  setConfigValue,
  unsetConfigValue,
  useProvider,
} from "./config-cli"

// Read version from package.json
const pkgPath = path.resolve(import.meta.dir ?? __dirname, "../package.json")
const pkgVersion: string = JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version

/** Check whether --json flag is present in argv */
function isJsonMode(): boolean {
  return process.argv.includes("--json")
}

/** Output result: JSON if --json flag set, otherwise human-readable */
function output(command: string, result: unknown): void {
  if (isJsonMode()) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(formatHuman(command, result))
  }
}

/** Format a command result for human-readable output */
function formatHuman(command: string, result: unknown): string {
  const r = result as Record<string, unknown>

  switch (command) {
    case "init": {
      let out = `Stash initialized at ${r.stashDir ?? r.path ?? "unknown"}`
      if (r.envHint) out += `\n\nTo use akm in this shell session, run:\n\n  ${r.envHint}`
      if (r.profileUpdated) out += `\n\nFuture shells will pick it up automatically from ${r.profileUpdated}.`
      return out
    }
    case "index": {
      return `Indexed ${r.totalEntries ?? 0} entries from ${r.directoriesScanned ?? 0} directories (mode: ${r.mode ?? "unknown"})`
    }
    case "search": {
      const hits = (r.hits as Array<Record<string, unknown>>) ?? []
      if (hits.length === 0) return r.tip as string ?? "No results found."
      const lines = hits.map((h) => {
        const score = h.score != null ? ` (score: ${Number(h.score).toFixed(2)})` : ""
        const desc = h.description ? `  ${h.description}` : ""
        return `  ${h.name ?? h.ref}  [${h.type}]${score}${desc}`
      })
      return lines.join("\n")
    }
    case "show": {
      if (r.content != null) return String(r.content)
      if (r.runCmd != null) return String(r.runCmd)
      if (r.markdown != null) return String(r.markdown)
      return JSON.stringify(result, null, 2)
    }
    case "add": {
      const installed = r.installed as Record<string, unknown> | undefined
      const indexed = installed?.indexed ?? r.indexed ?? 0
      return `Installed ${r.ref} (${indexed} assets indexed)`
    }
    case "list": {
      const entries = (r.installed as Array<Record<string, unknown>>) ?? []
      if (entries.length === 0) return "No kits installed."
      const lines = entries.map((e) => `  ${e.id ?? e.ref}  ${e.stashRoot ?? ""}`)
      return lines.join("\n")
    }
    case "remove":
    case "update":
    case "reinstall": {
      const target = r.target ?? r.ref ?? ""
      const ok = r.ok !== false ? "OK" : "FAILED"
      return `${command}: ${target} ${ok}`
    }
    case "config-list":
    case "config-get":
    case "config-set":
    case "config-unset":
    case "config-use":
    case "config-providers":
    case "config": {
      if (typeof r === "object" && r !== null) {
        // For config get which returns { key, value }
        if ("key" in r && "value" in r) return `${r.key}=${JSON.stringify(r.value)}`
        // For config list / set / unset / use which returns full config
        const lines: string[] = []
        for (const [k, v] of Object.entries(r)) {
          lines.push(`${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
        }
        return lines.join("\n")
      }
      return String(result)
    }
    case "clone": {
      const dst = (r.destination as Record<string, unknown>)?.path ?? "unknown"
      const remote = r.remoteFetched ? " (fetched from remote)" : ""
      const over = r.overwritten ? " (overwritten)" : ""
      return `Cloned${remote} → ${dst}${over}`
    }
    case "sources": {
      const sources = (r.sources as Array<Record<string, unknown>>) ?? []
      if (sources.length === 0) return "No stash sources configured."
      return sources.map((s) => `  [${s.kind}] ${s.path}${s.writable ? " (writable)" : ""}`).join("\n")
    }
    case "submit": {
      const entry = r.entry as Record<string, unknown> | undefined
      const pr = r.pr as Record<string, unknown> | undefined
      const commands = (r.commands as string[] | undefined) ?? []
      if (r.dryRun) {
        const lines = [
          `Dry run: prepared registry entry ${entry?.name ?? entry?.id ?? "unknown"}`,
          "",
          JSON.stringify(entry, null, 2),
        ]
        if (commands.length > 0) {
          lines.push("", "Would run:")
          lines.push(...commands.map((command) => `  ${command}`))
        }
        return lines.join("\n")
      }
      const prUrl = typeof pr?.url === "string" ? pr.url : "unknown"
      const fork = r.fork as Record<string, unknown> | undefined
      const cleanupCmd = typeof fork?.cleanupCommand === "string" ? fork.cleanupCommand : undefined
      const lines = [`Submitted ${entry?.name ?? entry?.id ?? "registry entry"}.`, `PR: ${prUrl}`]
      if (cleanupCmd) {
        lines.push(`\nAfter the PR is merged, clean up the fork with:\n  ${cleanupCmd}`)
      }
      return lines.join("\n")
    }
    default:
      return JSON.stringify(result, null, 2)
  }
}

const initCommand = defineCommand({
  meta: { name: "init", description: "Initialize Agent-i-Kit's working stash directory and set AKM_STASH_DIR" },
  async run() {
    await runWithJsonErrors(async () => {
      const result = await agentikitInit()
      console.log(JSON.stringify(result, null, 2))
      if (result.envHint) {
        console.error(
          `\nTo use akm in this shell session, run:\n\n  ${result.envHint}\n`
        )
        if (result.shellSetup) {
          console.error(
            `\nTo make this permanent, add to your shell profile (~/.bashrc or ~/.zshrc):\n` +
            result.shellSetup.filter(l => !l.startsWith("#")).map(l => `  ${l}`).join("\n")
          )
        }
      }
    })
  },
})

const indexCommand = defineCommand({
  meta: { name: "index", description: "Build search index (incremental by default; --full forces full reindex)" },
  args: {
    full: { type: "boolean", description: "Force full reindex", default: false },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const result = await agentikitIndex({ full: args.full })
      output("index", result)
    })
  },
})

const searchCommand = defineCommand({
  meta: { name: "search", description: "Search the stash" },
  args: {
    query: { type: "positional", description: "Search query", required: false, default: "" },
    type: { type: "string", description: "Asset type filter (tool|skill|command|agent|knowledge|script|any)" },
    limit: { type: "string", description: "Maximum number of results" },
    usage: { type: "string", description: "Usage metadata mode (none|both|item|guide)", default: "both" },
    source: { type: "string", description: "Search source (local|registry|both)", default: "local" },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const type = args.type as "tool" | "skill" | "command" | "agent" | "knowledge" | "script" | "any" | undefined
      const limit = args.limit ? parseInt(args.limit, 10) : undefined
      const usage = parseSearchUsageMode(args.usage)
      const source = parseSearchSource(args.source)
      const result = await agentikitSearch({ query: args.query, type, limit, usage, source })
      output("search", result)
    })
  },
})

const addCommand = defineCommand({
  meta: { name: "add", description: "Install a kit from npm, GitHub, any git host, or a local directory" },
  args: {
    ref: {
      type: "positional",
      description: "Registry ref (npm package, owner/repo, git URL, or local directory)",
      required: true,
    },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const result = await agentikitAdd({ ref: args.ref })
      output("add", result)
    })
  },
})

const listCommand = defineCommand({
  meta: { name: "list", description: "List installed registry packages from config" },
  async run() {
    await runWithJsonErrors(async () => {
      const result = await agentikitList()
      output("list", result)
    })
  },
})

const removeCommand = defineCommand({
  meta: { name: "remove", description: "Remove an installed registry package by id or ref" },
  args: {
    target: { type: "positional", description: "Installed target (id or ref)", required: true },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const result = await agentikitRemove({ target: args.target })
      output("remove", result)
    })
  },
})

const updateCommand = defineCommand({
  meta: { name: "update", description: "Update one or all installed registry packages" },
  args: {
    target: { type: "positional", description: "Installed target (id or ref)", required: false },
    all: { type: "boolean", description: "Update all installed entries", default: false },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const result = await agentikitUpdate({ target: args.target, all: args.all })
      output("update", result)
    })
  },
})

const reinstallCommand = defineCommand({
  meta: { name: "reinstall", description: "Reinstall one or all installed registry packages" },
  args: {
    target: { type: "positional", description: "Installed target (id or ref)", required: false },
    all: { type: "boolean", description: "Reinstall all installed entries", default: false },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const result = await agentikitReinstall({ target: args.target, all: args.all })
      output("reinstall", result)
    })
  },
})

const showCommand = defineCommand({
  meta: { name: "show", description: "Show a stash asset by ref (e.g. agent:bunjs-typescript-coder.md)" },
  args: {
    ref: { type: "positional", description: "Asset ref (type:name)", required: true },
    view: { type: "string", description: "Knowledge view mode (full|toc|frontmatter|section|lines)" },
    heading: { type: "string", description: "Section heading (for --view section)" },
    start: { type: "string", description: "Start line (for --view lines)" },
    end: { type: "string", description: "End line (for --view lines)" },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      let view: KnowledgeView | undefined
      if (args.view) {
        switch (args.view) {
          case "section":
            view = { mode: "section", heading: args.heading ?? "" }
            break
          case "lines":
            view = {
              mode: "lines",
              start: Number(args.start ?? "1"),
              end: args.end ? parseInt(args.end, 10) : Number.MAX_SAFE_INTEGER,
            }
            break
          case "toc":
          case "frontmatter":
          case "full":
            view = { mode: args.view }
            break
          default:
            throw new Error(`Unknown view mode: ${args.view}. Expected one of: full|toc|frontmatter|section|lines`)
        }
      }
      const result = await agentikitShow({ ref: args.ref, view })
      output("show", result)
    })
  },
})

const configCommand = defineCommand({
  meta: { name: "config", description: "Show configuration, get/set keys, and manage embedding/LLM providers" },
  args: {
    list: { type: "boolean", description: "List current configuration with effective defaults", default: false },
    get: { type: "string", description: "Get a configuration value by key" },
    unset: { type: "string", description: "Unset an optional configuration key or whole embedding/llm section" },
    set: { type: "string", description: "Back-compat alias for updating a key (key=value format)" },
  },
  subCommands: {
    list: defineCommand({
      meta: { name: "list", description: "List current configuration with effective embedding/LLM settings" },
      run() {
        return runWithJsonErrors(() => {
          output("config", listConfig(loadConfig()))
        })
      },
    }),
    get: defineCommand({
      meta: { name: "get", description: "Get a configuration value by key" },
      args: {
        key: { type: "positional", required: true, description: "Config key (for example: embedding.provider)" },
      },
      run({ args }) {
        return runWithJsonErrors(() => {
          output("config", getConfigValue(loadConfig(), args.key))
        })
      },
    }),
    set: defineCommand({
      meta: { name: "set", description: "Set a configuration value by key" },
      args: {
        key: { type: "positional", required: true, description: "Config key (for example: llm.temperature)" },
        value: { type: "positional", required: true, description: "Config value" },
      },
      run({ args }) {
        return runWithJsonErrors(() => {
          const updated = setConfigValue(loadConfig(), args.key, args.value)
          saveConfig(updated)
          output("config", listConfig(updated))
        })
      },
    }),
    unset: defineCommand({
      meta: { name: "unset", description: "Unset an optional configuration key or whole embedding/llm section" },
      args: {
        key: { type: "positional", required: true, description: "Config key to unset" },
      },
      run({ args }) {
        return runWithJsonErrors(() => {
          const updated = unsetConfigValue(loadConfig(), args.key)
          saveConfig(updated)
          output("config", listConfig(updated))
        })
      },
    }),
    providers: defineCommand({
      meta: { name: "providers", description: "List available embedding or LLM providers" },
      args: {
        scope: { type: "positional", required: true, description: "Provider scope: embedding or llm" },
      },
      run({ args }) {
        return runWithJsonErrors(() => {
          const scope = parseProviderScope(args.scope)
          output("config", listProviders(scope, loadConfig()))
        })
      },
    }),
    use: defineCommand({
      meta: { name: "use", description: "Switch the default embedding or LLM provider" },
      args: {
        scope: { type: "positional", required: true, description: "Provider scope: embedding or llm" },
        provider: { type: "positional", required: true, description: "Provider name" },
      },
      run({ args }) {
        return runWithJsonErrors(() => {
          const scope = parseProviderScope(args.scope)
          const updated = useProvider(loadConfig(), scope, args.provider)
          saveConfig(updated)
          output("config", listConfig(updated))
        })
      },
    }),
  },
  run({ args }) {
    return runWithJsonErrors(() => {
      if (hasConfigSubcommand(args)) return
      if (args.list) {
        output("config", listConfig(loadConfig()))
        return
      }
      if (args.get) {
        output("config", getConfigValue(loadConfig(), args.get))
        return
      }
      if (args.unset) {
        const updated = unsetConfigValue(loadConfig(), args.unset)
        saveConfig(updated)
        output("config", listConfig(updated))
        return
      }
      if (args.set) {
        const eqIndex = args.set.indexOf("=")
        if (eqIndex === -1) {
          throw new Error("--set expects key=value format")
        }
        const key = args.set.slice(0, eqIndex)
        const value = args.set.slice(eqIndex + 1)
        const partial = parseConfigValue(key, value)
        const config = { ...loadConfig(), ...partial }
        saveConfig(config)
        output("config", listConfig(config))
      } else {
        output("config", listConfig(loadConfig()))
      }
    })
  },
})

const cloneCommand = defineCommand({
  meta: { name: "clone", description: "Clone an asset from any stash source into the working stash or a custom destination" },
  args: {
    ref: { type: "positional", description: "Asset ref (e.g. @installed:pkg/tool:script.sh)", required: true },
    name: { type: "string", description: "New name for the cloned asset" },
    force: { type: "boolean", description: "Overwrite if asset already exists in working stash", default: false },
    dest: { type: "string", description: "Destination directory (default: working stash)" },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const result = await agentikitClone({
        sourceRef: args.ref,
        newName: args.name,
        force: args.force,
        dest: args.dest,
      })
      output("clone", result)
    })
  },
})

const submitCommand = defineCommand({
  meta: { name: "submit", description: "Submit a kit to agentikit-registry by opening a pull request" },
  args: {
    ref: { type: "positional", description: "Public ref to submit (npm package, owner/repo, or local kit directory)", required: false },
    name: { type: "string", description: "Display name for the registry entry" },
    description: { type: "string", description: "Short description for the registry entry" },
    tags: { type: "string", description: "Comma-separated tags" },
    "asset-types": { type: "string", description: "Comma-separated asset types" },
    author: { type: "string", description: "Author name" },
    license: { type: "string", description: "License identifier" },
    homepage: { type: "string", description: "Homepage URL" },
    "dry-run": { type: "boolean", description: "Preview the entry and gh commands without creating a pull request", default: false },
    "cleanup-fork": { type: "boolean", description: "Show the fork cleanup command after the pull request is created (run it after the PR is merged)", default: false },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const result = await agentikitSubmit({
        ref: args.ref,
        name: args.name,
        description: args.description,
        tags: args.tags,
        assetTypes: args["asset-types"],
        author: args.author,
        license: args.license,
        homepage: args.homepage,
        dryRun: args["dry-run"],
        cleanupFork: args["cleanup-fork"],
        progress: isJsonMode() ? undefined : (message) => console.error(`• ${message}`),
      })
      output("submit", result)
    })
  },
})


const sourcesCommand = defineCommand({
  meta: { name: "sources", description: "List all stash sources with their kind, path, and status" },
  run() {
    return runWithJsonErrors(() => {
      const sources = resolveStashSources()
      output("sources", { sources })
    })
  },
})

const main = defineCommand({
  meta: {
    name: "akm",
    version: pkgVersion,
    description: "CLI tool to search, open, and manage assets from Agent-i-Kit stash.",
  },
  args: {
    json: { type: "boolean", description: "Output in JSON format", default: false },
  },
  subCommands: {
    init: initCommand,
    index: indexCommand,
    add: addCommand,
    list: listCommand,
    remove: removeCommand,
    update: updateCommand,
    reinstall: reinstallCommand,
    search: searchCommand,
    show: showCommand,
    clone: cloneCommand,
    submit: submitCommand,
    sources: sourcesCommand,
    config: configCommand,
  },
})

const SEARCH_USAGE_MODES: SearchUsageMode[] = ["none", "both", "item", "guide"]
const SEARCH_SOURCES: SearchSource[] = ["local", "registry", "both"]
const CONFIG_SUBCOMMAND_SET = new Set(["list", "get", "set", "unset", "providers", "use"])

// citty reads process.argv directly and does not accept a custom argv array,
// so we must replace process.argv with the normalized version before runMain.
const normalizedArgv = [...process.argv]
normalizeConfigArgv(normalizedArgv)
process.argv = normalizedArgv
runMain(main)

function parseSearchUsageMode(value: string): SearchUsageMode {
  if ((SEARCH_USAGE_MODES as string[]).includes(value)) return value as SearchUsageMode
  throw new Error(`Invalid value for --usage: ${value}. Expected one of: ${SEARCH_USAGE_MODES.join("|")}`)
}

function parseSearchSource(value: string): SearchSource {
  if ((SEARCH_SOURCES as string[]).includes(value)) return value as SearchSource
  throw new Error(`Invalid value for --source: ${value}. Expected one of: ${SEARCH_SOURCES.join("|")}`)
}

// ── Exit codes ──────────────────────────────────────────────────────────────
const EXIT_GENERAL = 1
const EXIT_USAGE = 2
const EXIT_CONFIG = 78

function classifyExitCode(message: string): number {
  // Usage / argument errors
  if (
    message.includes("required") ||
    message.includes("Invalid value for") ||
    message.includes("Expected one of") ||
    message.includes("expected JSON object")
  ) {
    return EXIT_USAGE
  }
  // Configuration errors
  if (
    message.includes("AKM_STASH_DIR") ||
    message.includes("Unable to determine") ||
    message.includes("config")
  ) {
    return EXIT_CONFIG
  }
  return EXIT_GENERAL
}

async function runWithJsonErrors(fn: (() => void) | (() => Promise<void>)): Promise<void> {
  try {
    await fn()
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    const hint = buildHint(message)
    const exitCode = classifyExitCode(message)
    console.error(JSON.stringify({ ok: false, error: message, hint }, null, 2))
    process.exit(exitCode)
  }
}

function buildHint(message: string): string | undefined {
  if (message.includes("AKM_STASH_DIR")) return "Run `akm init` or set AKM_STASH_DIR to a valid directory."
  if (message.includes("Either <target> or --all is required")) return "Use `akm update --all` or pass a target like `akm update npm:@scope/pkg`."
  if (message.includes("Specify either <target> or --all")) return "Use only one: a positional target or `--all`."
  if (message.includes("No installed registry entry matched target")) return "Run `akm list` to view installed ids/refs, then retry with one of those values."
  if (message.includes("remote package fetched but asset not found")) return "The remote package was fetched but doesn't contain the requested asset. Check the asset name and type."
  if (message.includes("Invalid value for --source")) return "Pick one of: local, registry, both."
  if (message.includes("Invalid value for --usage")) return "Pick one of: none, both, item, guide."
  if (message.includes("gh CLI is required")) return buildGhInstallHint()
  if (message.includes("gh CLI is not authenticated")) return "Run `gh auth login` and then retry `akm submit`."
  if (message.includes("not publicly accessible")) return "Check that the npm package is published or the GitHub repository is public, then retry."
  if (message.includes("already exists in agentikit-registry")) return "Update the existing registry entry instead of creating a duplicate, or choose a different public ref."
  if (message.includes("Unable to infer a public npm or GitHub ref") || message.includes("Unable to infer a publicly accessible npm package or GitHub repository")) {
    return "Run `akm submit <package-or-owner/repo>` explicitly, or add name/repository metadata to package.json."
  }
  if (message.includes("expected JSON object with endpoint and model")) {
    return "Quote JSON values in your shell, for example: akm config set embedding '{\"endpoint\":\"http://localhost:11434/v1/embeddings\",\"model\":\"nomic-embed-text\"}'."
  }
  return undefined
}

function buildGhInstallHint(): string {
  if (process.platform === "darwin") return "Install GitHub CLI with Homebrew: `brew install gh`."
  if (process.platform === "win32") return "Install GitHub CLI with winget: `winget install --id GitHub.cli`."
  return "Install GitHub CLI from https://cli.github.com/ or your package manager (for Debian/Ubuntu: `sudo apt install gh`)."
}

function parseProviderScope(value: string): "embedding" | "llm" {
  if (value === "embedding" || value === "llm") return value
  throw new Error(`Invalid provider scope: ${value}. Expected one of: embedding|llm`)
}

function hasConfigSubcommand(args: Record<string, unknown>): boolean {
  const command = Array.isArray(args._) ? args._[0] : undefined
  return typeof command === "string" && CONFIG_SUBCOMMAND_SET.has(command)
}

/**
 * Normalize argv before citty parses it so git-style config forms like
 * `akm config llm.maxTokens 512` and `akm config --get llm.maxTokens`
 * are normalized into the existing config subcommands.
 *
 * Operates on a copy of process.argv; the caller replaces process.argv
 * with the normalized result (safer than in-place splice).
 */
function normalizeConfigArgv(argv: string[]): void {
  // Global flags (like --json) should not be treated as config subcommand arguments.
  // We strip them from the analysis portion, normalize, then re-append them.
  const GLOBAL_FLAGS = new Set(["--json"])
  const globalFlags = argv.slice(3).filter((a) => GLOBAL_FLAGS.has(a))
  const configArgs = argv.slice(3).filter((a) => !GLOBAL_FLAGS.has(a))

  const [command, argAfterCommand, argAfterKey, ...rest] = [argv[2], ...configArgs]
  if (command !== "config") return
  if (!argAfterCommand) return

  const replaceArgs = (...newArgs: string[]) => {
    argv.splice(3, argv.length - 3, ...newArgs, ...globalFlags)
  }

  if (argAfterCommand === "--list") {
    replaceArgs("list")
    return
  }
  if (argAfterCommand === "--get" && argAfterKey) {
    replaceArgs("get", argAfterKey, ...rest)
    return
  }
  if (argAfterCommand === "--unset" && argAfterKey) {
    replaceArgs("unset", argAfterKey, ...rest)
    return
  }
  if (argAfterCommand.startsWith("-")) return
  if (CONFIG_SUBCOMMAND_SET.has(argAfterCommand)) return

  // A single arg after `config` behaves like `git config <key>` and reads the value.
  if (argAfterKey === undefined) {
    replaceArgs("get", argAfterCommand)
    return
  }

  replaceArgs("set", argAfterCommand, argAfterKey, ...rest)
}
