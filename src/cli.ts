#!/usr/bin/env node
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

const initCommand = defineCommand({
  meta: { name: "init", description: "Initialize agentikit stash directory and set AGENTIKIT_STASH_DIR" },
  run() {
    return runWithJsonErrors(() => {
      const result = agentikitInit()
      console.log(JSON.stringify(result, null, 2))
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
      console.log(JSON.stringify(result, null, 2))
    })
  },
})

const searchCommand = defineCommand({
  meta: { name: "search", description: "Search the stash" },
  args: {
    query: { type: "positional", description: "Search query", required: false, default: "" },
    type: { type: "string", description: "Asset type filter (tool|skill|command|agent|knowledge|any)" },
    limit: { type: "string", description: "Maximum number of results" },
    usage: { type: "string", description: "Usage metadata mode (none|both|item|guide)", default: "both" },
    source: { type: "string", description: "Search source (local|registry|both)", default: "local" },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const type = args.type as "tool" | "skill" | "command" | "agent" | "knowledge" | "any" | undefined
      const limit = args.limit ? parseInt(args.limit, 10) : undefined
      const usage = parseSearchUsageMode(args.usage)
      const source = parseSearchSource(args.source)
      console.log(JSON.stringify(await agentikitSearch({ query: args.query, type, limit, usage, source }), null, 2))
    })
  },
})

const addCommand = defineCommand({
  meta: { name: "add", description: "Install a registry package or local git directory into the stash" },
  args: {
    ref: {
      type: "positional",
      description: "Registry ref (npm package, owner/repo, github URL, or local git directory)",
      required: true,
    },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      console.log(JSON.stringify(await agentikitAdd({ ref: args.ref }), null, 2))
    })
  },
})

const listCommand = defineCommand({
  meta: { name: "list", description: "List installed registry packages from config" },
  async run() {
    await runWithJsonErrors(async () => {
      console.log(JSON.stringify(await agentikitList(), null, 2))
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
      console.log(JSON.stringify(await agentikitRemove({ target: args.target }), null, 2))
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
      console.log(JSON.stringify(await agentikitUpdate({ target: args.target, all: args.all }), null, 2))
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
      console.log(JSON.stringify(await agentikitReinstall({ target: args.target, all: args.all }), null, 2))
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
  run({ args }) {
    return runWithJsonErrors(() => {
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
      console.log(JSON.stringify(agentikitShow({ ref: args.ref, view }), null, 2))
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
          console.log(JSON.stringify(listConfig(loadConfig()), null, 2))
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
          console.log(JSON.stringify(getConfigValue(loadConfig(), args.key), null, 2))
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
          console.log(JSON.stringify(listConfig(updated), null, 2))
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
          console.log(JSON.stringify(listConfig(updated), null, 2))
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
          console.log(JSON.stringify(listProviders(scope, loadConfig()), null, 2))
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
          console.log(JSON.stringify(listConfig(updated), null, 2))
        })
      },
    }),
  },
  run({ args }) {
    return runWithJsonErrors(() => {
      if (hasConfigSubcommand(args)) return
      if (args.list) {
        console.log(JSON.stringify(listConfig(loadConfig()), null, 2))
        return
      }
      if (args.get) {
        console.log(JSON.stringify(getConfigValue(loadConfig(), args.get), null, 2))
        return
      }
      if (args.unset) {
        const updated = unsetConfigValue(loadConfig(), args.unset)
        saveConfig(updated)
        console.log(JSON.stringify(listConfig(updated), null, 2))
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
        console.log(JSON.stringify(listConfig(config), null, 2))
      } else {
        console.log(JSON.stringify(listConfig(loadConfig()), null, 2))
      }
    })
  },
})

const main = defineCommand({
  meta: {
    name: "akm",
    description: "CLI tool to search, open, and run extension assets from an agentikit stash directory.",
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
    config: configCommand,
  },
})

const SEARCH_USAGE_MODES: SearchUsageMode[] = ["none", "both", "item", "guide"]
const SEARCH_SOURCES: SearchSource[] = ["local", "registry", "both"]
const CONFIG_SUBCOMMAND_SET = new Set(["list", "get", "set", "unset", "providers", "use"])

normalizeConfigArgv(process.argv)
runMain(main)

function parseSearchUsageMode(value: string): SearchUsageMode {
  if ((SEARCH_USAGE_MODES as string[]).includes(value)) return value as SearchUsageMode
  throw new Error(`Invalid value for --usage: ${value}. Expected one of: ${SEARCH_USAGE_MODES.join("|")}`)
}

function parseSearchSource(value: string): SearchSource {
  if ((SEARCH_SOURCES as string[]).includes(value)) return value as SearchSource
  throw new Error(`Invalid value for --source: ${value}. Expected one of: ${SEARCH_SOURCES.join("|")}`)
}

async function runWithJsonErrors(fn: (() => void) | (() => Promise<void>)): Promise<void> {
  try {
    await fn()
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    const hint = buildHint(message)
    console.error(JSON.stringify({ ok: false, error: message, hint }, null, 2))
    process.exit(1)
  }
}

function buildHint(message: string): string | undefined {
  if (message.includes("AGENTIKIT_STASH_DIR")) return "Run `akm init` or set AGENTIKIT_STASH_DIR to a valid directory."
  if (message.includes("Either <target> or --all is required")) return "Use `akm update --all` or pass a target like `akm update npm:@scope/pkg`."
  if (message.includes("Specify either <target> or --all")) return "Use only one: a positional target or `--all`."
  if (message.includes("No installed registry entry matched target")) return "Run `akm list` to view installed ids/refs, then retry with one of those values."
  if (message.includes("Invalid value for --source")) return "Pick one of: local, registry, both."
  if (message.includes("Invalid value for --usage")) return "Pick one of: none, both, item, guide."
  if (message.includes("expected JSON object with endpoint and model")) {
    return "Quote JSON values in your shell, for example: akm config set embedding '{\"endpoint\":\"http://localhost:11434/v1/embeddings\",\"model\":\"nomic-embed-text\"}'."
  }
  return undefined
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
 * Mutate argv before citty parses it so git-style config forms like
 * `akm config llm.maxTokens 512` and `akm config --get llm.maxTokens`
 * are normalized into the existing config subcommands.
 */
function normalizeConfigArgv(argv: string[]): void {
  const [, , command, argAfterCommand, argAfterKey, ...rest] = argv
  if (command !== "config") return
  if (!argAfterCommand) return
  if (argAfterCommand === "--list") {
    argv.splice(3, argv.length - 3, "list")
    return
  }
  if (argAfterCommand === "--get" && argAfterKey) {
    argv.splice(3, argv.length - 3, "get", argAfterKey, ...rest)
    return
  }
  if (argAfterCommand === "--unset" && argAfterKey) {
    argv.splice(3, argv.length - 3, "unset", argAfterKey, ...rest)
    return
  }
  if (argAfterCommand.startsWith("-")) return
  if (CONFIG_SUBCOMMAND_SET.has(argAfterCommand)) return

  // A single arg after `config` behaves like `git config <key>` and reads the value.
  if (argAfterKey === undefined) {
    argv.splice(3, argv.length - 3, "get", argAfterCommand)
    return
  }

  argv.splice(3, argv.length - 3, "set", argAfterCommand, argAfterKey, ...rest)
}
