import { type Plugin, tool } from "@opencode-ai/plugin"
import { agentikitOpen, agentikitRun, agentikitSearch } from "./stash"

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
        try {
          return JSON.stringify(agentikitSearch({ query, type, limit }))
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          return JSON.stringify({
            ok: false,
            error: `Failed to search Agentikit stash: ${message}`,
          })
        }
      },
    }),
    agentikit_open: tool({
      description: "Open a stash asset from an openRef returned by agentikit_search.",
      args: {
        ref: tool.schema.string().describe("Open reference returned by agentikit_search."),
      },
      async execute({ ref }) {
        try {
          return JSON.stringify(agentikitOpen({ ref }))
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          return JSON.stringify({
            ok: false,
            error: `Failed to open stash asset: ${message}`,
          })
        }
      },
    }),
    agentikit_run: tool({
      description: "Run a tool from the Agentikit stash by its openRef. Only tool refs are supported.",
      args: {
        ref: tool.schema.string().describe("Open reference of a tool returned by agentikit_search."),
      },
      async execute({ ref }) {
        try {
          return JSON.stringify(agentikitRun({ ref }))
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          return JSON.stringify({
            ok: false,
            error: `Failed to run stash tool: ${message}`,
          })
        }
      },
    }),
  },
})
