#!/usr/bin/env node
import { agentikitSearch, agentikitOpen, agentikitRun, agentikitInit, type KnowledgeView } from "./stash"
import { agentikitIndex } from "./indexer"

const args = process.argv.slice(2)
const command = args[0]

function flag(name: string): string | undefined {
  const idx = args.indexOf(name)
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined
}

function usage(): never {
  console.error("Usage: agentikit <init|search|open|run> [options]")
  console.error("")
  console.error("Commands:")
  console.error("  init                 Initialize agentikit stash directory and set AGENTIKIT_STASH_DIR")
  console.error("  index                Build search index with metadata generation")
  console.error("  search [query]       Search the stash (--type tool|skill|command|agent|knowledge|any) (--limit N)")
  console.error("  open <type:name>     Open a stash asset by ref")
  console.error("       Knowledge view options: --view full|toc|frontmatter|section|lines")
  console.error("         --heading <text>   Section heading (for --view section)")
  console.error("         --start <N>        Start line (for --view lines)")
  console.error("         --end <N>          End line (for --view lines)")
  console.error("  run <type:name>      Run a tool by ref")
  process.exit(1)
}

switch (command) {
  case "init": {
    const result = agentikitInit()
    console.log(JSON.stringify(result, null, 2))
    break
  }
  case "index": {
    const result = agentikitIndex()
    console.log(JSON.stringify(result, null, 2))
    break
  }
  case "search": {
    const query = args.find((a, i) => i > 0 && !a.startsWith("--") && args[i - 1] !== "--type" && args[i - 1] !== "--limit") ?? ""
    const type = flag("--type") as "tool" | "skill" | "command" | "agent" | "any" | undefined
    const limitStr = flag("--limit")
    const limit = limitStr ? parseInt(limitStr, 10) : undefined
    console.log(JSON.stringify(agentikitSearch({ query, type, limit }), null, 2))
    break
  }
  case "open": {
    const ref = args[1]
    if (!ref) { console.error("Error: missing ref argument\n"); usage() }
    const viewMode = flag("--view")
    let view: KnowledgeView | undefined
    if (viewMode) {
      switch (viewMode) {
        case "section":
          view = { mode: "section", heading: flag("--heading") ?? "" }
          break
        case "lines":
          view = { mode: "lines", start: Number(flag("--start") ?? "1"), end: Number(flag("--end") ?? "Infinity") }
          break
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
    console.log(JSON.stringify(agentikitOpen({ ref, view }), null, 2))
    break
  }
  case "run": {
    const ref = args[1]
    if (!ref) { console.error("Error: missing ref argument\n"); usage() }
    const result = agentikitRun({ ref })
    console.log(JSON.stringify(result, null, 2))
    process.exit(result.exitCode)
    break
  }
  default:
    usage()
}
