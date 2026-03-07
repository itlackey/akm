#!/usr/bin/env node
import { agentikitSearch, agentikitShow, type KnowledgeView } from "./stash"
import { agentikitInit } from "./init"
import { agentikitIndex } from "./indexer"
import { loadConfig, updateConfig, type AgentikitConfig } from "./config"
import { resolveStashDir } from "./common"

const args = process.argv.slice(2)
const command = args[0]

type FlagKind = "boolean" | "string"

function parseCliArgs(
  argv: string[],
  specs: Record<string, FlagKind>,
): { flags: Record<string, string | boolean | undefined>; positionals: string[] } {
  const flags: Record<string, string | boolean | undefined> = {}
  const positionals: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const kind = specs[arg]

    if (kind === "boolean") {
      flags[arg] = true
      continue
    }

    if (kind === "string") {
      if (i + 1 < argv.length) {
        flags[arg] = argv[i + 1]
        i++
      }
      continue
    }

    if (arg.startsWith("--")) {
      continue
    }

    positionals.push(arg)
  }

  return { flags, positionals }
}

function usage(): never {
  console.error("Usage: agentikit <init|index|search|show|config> [options]")
  console.error("")
  console.error("Commands:")
  console.error("  init                 Initialize agentikit stash directory and set AGENTIKIT_STASH_DIR")
  console.error("  index [--full]       Build search index (incremental by default; --full forces full reindex)")
  console.error("  search [query]       Search the stash (--type tool|skill|command|agent|knowledge|any) (--limit N)")
  console.error("  show <type:name>     Show a stash asset by ref")
  console.error("       Knowledge view options: --view full|toc|frontmatter|section|lines")
  console.error("         --heading <text>   Section heading (for --view section)")
  console.error("         --start <N>        Start line (for --view lines)")
  console.error("         --end <N>          End line (for --view lines)")
  console.error("  config               Show current configuration")
  console.error("  config --set k=v     Update a configuration key")
  process.exit(1)
}

async function main() {
  switch (command) {
    case "init": {
      const result = agentikitInit()
      console.log(JSON.stringify(result, null, 2))
      break
    }
    case "index": {
      const parsed = parseCliArgs(args.slice(1), { "--full": "boolean" })
      const full = parsed.flags["--full"] === true
      const result = await agentikitIndex({ full })
      console.log(JSON.stringify(result, null, 2))
      break
    }
    case "search": {
      const parsed = parseCliArgs(args.slice(1), { "--type": "string", "--limit": "string" })
      const query = parsed.positionals.join(" ")
      const type = parsed.flags["--type"] as "tool" | "skill" | "command" | "agent" | "knowledge" | "any" | undefined
      const limitStr = parsed.flags["--limit"] as string | undefined
      const limit = limitStr ? parseInt(limitStr, 10) : undefined
      console.log(JSON.stringify(await agentikitSearch({ query, type, limit }), null, 2))
      break
    }
    case "show": {
      const ref = args[1]
      if (!ref) { console.error("Error: missing ref argument\n"); return usage() }
      const parsed = parseCliArgs(args.slice(2), {
        "--view": "string",
        "--heading": "string",
        "--start": "string",
        "--end": "string",
      })
      const viewMode = parsed.flags["--view"] as string | undefined
      let view: KnowledgeView | undefined
      if (viewMode) {
        switch (viewMode) {
          case "section":
            view = { mode: "section", heading: (parsed.flags["--heading"] as string | undefined) ?? "" }
            break
          case "lines": {
            const startVal = parsed.flags["--start"] as string | undefined
            const endVal = parsed.flags["--end"] as string | undefined
            view = {
              mode: "lines",
              start: Number(startVal ?? "1"),
              end: endVal ? parseInt(endVal, 10) : Number.MAX_SAFE_INTEGER,
            }
            break
          }
          case "toc":
          case "frontmatter":
          case "full":
            view = { mode: viewMode }
            break
          default:
            console.error(`Unknown view mode: ${viewMode}`)
            usage()
        }
      }
      console.log(JSON.stringify(agentikitShow({ ref, view }), null, 2))
      break
    }
    case "config": {
      const parsed = parseCliArgs(args.slice(1), { "--set": "string" })
      const stashDir = resolveStashDir()

      if (parsed.flags["--set"]) {
        const raw = parsed.flags["--set"] as string
        const eqIndex = raw.indexOf("=")
        if (eqIndex === -1) {
          console.error("Error: --set expects key=value format")
          process.exit(1)
        }
        const key = raw.slice(0, eqIndex)
        const value = raw.slice(eqIndex + 1)
        const partial = parseConfigValue(key, value)
        const config = updateConfig(partial, stashDir)
        console.log(JSON.stringify(config, null, 2))
      } else {
        const config = loadConfig(stashDir)
        console.log(JSON.stringify(config, null, 2))
      }
      break
    }
    default:
      usage()
  }
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})

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
