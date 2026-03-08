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
import { loadConfig, updateConfig, type AgentikitConfig } from "./config"
import { resolveStashDir } from "./common"

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
  meta: { name: "config", description: "Show or update configuration" },
  args: {
    set: { type: "string", description: "Update a config key (key=value format)" },
  },
  run({ args }) {
    return runWithJsonErrors(() => {
      const stashDir = resolveStashDir()

      if (args.set) {
        const eqIndex = args.set.indexOf("=")
        if (eqIndex === -1) {
          throw new Error("--set expects key=value format")
        }
        const key = args.set.slice(0, eqIndex)
        const value = args.set.slice(eqIndex + 1)
        const partial = parseConfigValue(key, value)
        const config = updateConfig(partial, stashDir)
        console.log(JSON.stringify(config, null, 2))
      } else {
        const config = loadConfig(stashDir)
        console.log(JSON.stringify(config, null, 2))
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

runMain(main)

const SEARCH_USAGE_MODES: SearchUsageMode[] = ["none", "both", "item", "guide"]
const SEARCH_SOURCES: SearchSource[] = ["local", "registry", "both"]

function parseSearchUsageMode(value: string): SearchUsageMode {
  if ((SEARCH_USAGE_MODES as string[]).includes(value)) return value as SearchUsageMode
  throw new Error(`Invalid value for --usage: ${value}. Expected one of: ${SEARCH_USAGE_MODES.join("|")}`)
}

function parseSearchSource(value: string): SearchSource {
  if ((SEARCH_SOURCES as string[]).includes(value)) return value as SearchSource
  throw new Error(`Invalid value for --source: ${value}. Expected one of: ${SEARCH_SOURCES.join("|")}`)
}

function parseConnectionValue(
  key: string,
  value: string,
  exampleEndpoint: string,
  exampleModel: string,
): { endpoint: string; model: string; apiKey?: string } | undefined {
  if (value === "null" || value === "") return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(
      `Invalid value for ${key}: expected JSON object with endpoint and model`
      + ` (e.g. '{"endpoint":"${exampleEndpoint}","model":"${exampleModel}"}')`,
    )
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid value for ${key}: expected a JSON object`)
  }
  const obj = parsed as Record<string, unknown>
  if (typeof obj.endpoint !== "string" || !obj.endpoint || typeof obj.model !== "string" || !obj.model) {
    throw new Error(`Invalid value for ${key}: "endpoint" and "model" are required string fields`)
  }
  const result: { endpoint: string; model: string; apiKey?: string } = {
    endpoint: obj.endpoint,
    model: obj.model,
  }
  if (typeof obj.apiKey === "string" && obj.apiKey) {
    result.apiKey = obj.apiKey
  }
  return result
}

function parseConfigValue(key: string, value: string): Partial<AgentikitConfig> {
  switch (key) {
    case "semanticSearch":
      if (value !== "true" && value !== "false") {
        throw new Error(`Invalid value for semanticSearch: expected "true" or "false"`)
      }
      return { semanticSearch: value === "true" }
    case "additionalStashDirs":
      try {
        const parsed = JSON.parse(value)
        if (!Array.isArray(parsed)) throw new Error("expected JSON array")
        return { additionalStashDirs: parsed.filter((d: unknown): d is string => typeof d === "string") }
      } catch {
        throw new Error(`Invalid value for additionalStashDirs: expected JSON array (e.g. '["/path/a","/path/b"]')`)
      }
    case "embedding":
      return { embedding: parseConnectionValue("embedding", value, "http://localhost:11434/v1/embeddings", "nomic-embed-text") }
    case "llm":
      return { llm: parseConnectionValue("llm", value, "http://localhost:11434/v1/chat/completions", "llama3.2") }
    default:
      throw new Error(`Unknown config key: ${key}`)
  }
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
  return undefined
}
