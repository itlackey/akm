import { type Plugin, tool } from "@opencode-ai/plugin"
import { agentikitOpen, agentikitRun, agentikitSearch, type KnowledgeView } from "./stash"
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
      description: "Search the Agentikit stash for tools, skills, commands, agents, and knowledge.",
      args: {
        query: tool.schema.string().describe("Case-insensitive substring search."),
        type: tool.schema
          .enum(["tool", "skill", "command", "agent", "knowledge", "any"])
          .optional()
          .describe("Optional type filter. Defaults to 'any'."),
        limit: tool.schema.number().optional().describe("Maximum number of hits to return. Defaults to 20."),
      },
      async execute({ query, type, limit }) {
        return tryJson(() => agentikitSearch({ query, type, limit }), "search Agentikit stash")
      },
    }),
    agentikit_open: tool({
      description: "Open a stash asset by ref. For knowledge assets, use view_mode to retrieve specific content (toc, section, lines, frontmatter).",
      args: {
        ref: tool.schema.string().describe("Open reference returned by agentikit_search."),
        view_mode: tool.schema
          .enum(["full", "toc", "frontmatter", "section", "lines"])
          .optional()
          .describe("View mode for knowledge assets. Defaults to 'full'. Ignored for other types."),
        heading: tool.schema.string().optional()
          .describe("Section heading to extract (required when view_mode is 'section')."),
        start_line: tool.schema.number().optional()
          .describe("Start line number, 1-based (for view_mode 'lines')."),
        end_line: tool.schema.number().optional()
          .describe("End line number, 1-based inclusive (for view_mode 'lines')."),
      },
      async execute({ ref, view_mode, heading, start_line, end_line }) {
        let view: KnowledgeView | undefined
        if (view_mode) {
          switch (view_mode) {
            case "section":
              view = { mode: "section", heading: heading ?? "" }
              break
            case "lines":
              view = { mode: "lines", start: start_line ?? 1, end: end_line ?? Infinity }
              break
            default:
              view = { mode: view_mode } as KnowledgeView
          }
        }
        return tryJson(() => agentikitOpen({ ref, view }), "open stash asset")
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
