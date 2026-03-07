#!/usr/bin/env node
import { agentikitSearch, agentikitOpen, agentikitRun, agentikitInit } from "./stash"

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
  console.error("  search [query]       Search the stash (--type tool|skill|command|agent|any) (--limit N)")
  console.error("  open <type:name>     Open a stash asset by ref")
  console.error("  run <type:name>      Run a tool by ref")
  process.exit(1)
}

switch (command) {
  case "init": {
    const result = agentikitInit()
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
    console.log(JSON.stringify(agentikitOpen({ ref }), null, 2))
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
