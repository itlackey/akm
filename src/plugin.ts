import { type Plugin, tool } from "@opencode-ai/plugin"
import { agentikitOpen, agentikitRun, agentikitSearch } from "./stash"
import { agentikitIndex } from "./indexer"

function tryJson(fn: () => unknown, action: string): string {
  try {
    return JSON.stringify(fn())
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return JSON.stringify({ ok: false, error: `Failed to ${action}: ${message}` })
  }
}

export const plugin: Plugin = async () => ({
  tool: {
    agentikit_search: tool({
      description: "Search the Agentikit stash for tools, skills, commands, and agents.",
      args: {
        query: tool.schema.string().describe("Case-insensitive substring search."),
        type: tool.schema
          .enum(["tool", "skill", "command", "agent", "any"])
          .optional()
          .describe("Optional type filter. Defaults to 'any'."),
        limit: tool.schema.number().optional().describe("Maximum number of hits to return. Defaults to 20."),
      },
      async execute({ query, type, limit }) {
        return tryJson(() => agentikitSearch({ query, type, limit }), "search Agentikit stash")
      },
    }),
    agentikit_open: tool({
      description: "Open a stash asset from an openRef returned by agentikit_search.",
      args: {
        ref: tool.schema.string().describe("Open reference returned by agentikit_search."),
      },
      async execute({ ref }) {
        return tryJson(() => agentikitOpen({ ref }), "open stash asset")
      },
    }),
    agentikit_run: tool({
      description: "Run a tool from the Agentikit stash by its openRef. Only tool refs are supported.",
      args: {
        ref: tool.schema.string().describe("Open reference of a tool returned by agentikit_search."),
      },
      async execute({ ref }) {
        return tryJson(() => agentikitRun({ ref }), "run stash tool")
      },
    }),
    agentikit_index: tool({
      description: "Build or rebuild the Agentikit search index. Scans stash directories, generates missing .stash.json metadata, and builds a semantic search index.",
      args: {},
      async execute() {
        return tryJson(() => agentikitIndex(), "build Agentikit index")
      },
    }),
  },
})
