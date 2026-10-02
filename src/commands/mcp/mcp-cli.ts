// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm mcp` — a read-only Model Context Protocol server on stdio.
 *
 * It serves exactly two tools, `search` and `show`, to a client that may not
 * run a shell: unattended model work on opencode, whose bash permission matches
 * a command's words only, so `akm show x > ~/stash/y` would pass a rule for
 * `akm show`. Nothing here can write. The tools call `akmSearch` and
 * `akmShowUnified` with usage logging off, and refuse to build a missing index.
 *
 * The stash and config are the process's own, so `AKM_CONFIG_DIR`,
 * `AKM_DATA_DIR` and the rest choose which stash it serves.
 *
 * The wire format is newline-delimited JSON-RPC 2.0, which is all MCP's stdio
 * transport asks of a server that only answers requests: `initialize`,
 * `notifications/initialized`, `ping`, `tools/list` and `tools/call`.
 */

import { createInterface } from "node:readline";
import { defineCommand } from "citty";
import { runWithJsonErrors } from "../../cli/shared";
import { isRecord } from "../../core/common";
import { AkmError } from "../../core/errors";
import { indexCanServeStash } from "../../indexer/ensure-index";
import { resolveReadSources } from "../../indexer/read-preflight";
import { shapeForCommand } from "../../output/shapes";
import { NORMAL_DESCRIPTION_LIMIT, truncateDescription } from "../../output/shapes/helpers";
import { pkgVersion } from "../../version";
import { akmSearch } from "../read/search";
import { akmShowUnified } from "../read/show";

/** Newest first. A client asking for another version is answered with the newest. */
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** The tool's text reply, or a throw the client reads as a tool error. */
  run(args: Record<string, unknown>): Promise<string>;
}

/** An index akm would build on first read is never built here: a build is a write, and takes minutes. */
function assertIndexReady(): void {
  const stashDir = resolveReadSources().primarySource?.path;
  if (stashDir && !indexCanServeStash(stashDir)) {
    throw new Error("No usable search index for this stash. Run `akm index` first; `akm mcp` never builds one.");
  }
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  return value;
}

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = optionalString(args, name);
  if (value === undefined) throw new Error(`${name} is required.`);
  return value;
}

const TOOLS: readonly McpTool[] = [
  {
    name: "search",
    description:
      "Search the akm stash for assets (skills, knowledge, memories, lessons, ...) by keyword. " +
      "Returns compact hits: ref, type, description, score. Pass a hit's ref to the show tool to read the asset. " +
      "An empty query lists assets.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query. Empty lists assets." },
        type: { type: "string", description: "Only assets of this type, such as skill, knowledge, memory or lesson." },
        limit: { type: "integer", minimum: 1, description: "Maximum number of hits (default 20, at most 200)." },
      },
      required: ["query"],
    },
    async run(args) {
      const query = requiredString(args, "query");
      const type = optionalString(args, "type");
      const limit = args.limit;
      if (limit !== undefined && limit !== null && (!Number.isInteger(limit) || (limit as number) < 1)) {
        throw new Error("limit must be a positive integer.");
      }
      assertIndexReady();
      const result = await akmSearch({
        query,
        ...(type ? { type } : {}),
        ...(typeof limit === "number" ? { limit } : {}),
        skipLogging: true,
      });
      // Local hits only: `source` is never registry or all, so a registry hit is a type-level possibility.
      const hits = result.hits.flatMap((hit) =>
        !("ref" in hit)
          ? []
          : [
              {
                ref: hit.ref,
                type: hit.type,
                ...(hit.description
                  ? { description: truncateDescription(hit.description, NORMAL_DESCRIPTION_LIMIT) }
                  : {}),
                ...(hit.score !== undefined ? { score: hit.score } : {}),
              },
            ],
      );
      return JSON.stringify({
        hits,
        ...(result.tip ? { tip: result.tip } : {}),
        ...(result.warnings?.length ? { warnings: result.warnings } : {}),
      });
    },
  },
  {
    name: "show",
    description:
      "Show one stash asset by ref, as `akm show` renders it: its content and metadata. " +
      "Env and secret assets show names only, never values. " +
      "Append #<heading-slug> to a ref to read one section of a markdown asset.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Asset ref, as search returns it: [bundle//]conceptId[#fragment]." },
      },
      required: ["ref"],
    },
    async run(args) {
      const ref = requiredString(args, "ref");
      assertIndexReady();
      const result = await akmShowUnified({ ref, skipLogging: true });
      // The text `akm show <ref>` prints by default.
      return JSON.stringify(shapeForCommand("show", result, "brief", "human"), null, 2);
    },
  },
];

const reply = (id: unknown, result: unknown): string => JSON.stringify({ jsonrpc: "2.0", id, result });
const failure = (id: unknown, code: number, message: string): string =>
  JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });

function toolErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const hint = error instanceof AkmError ? error.hint() : undefined;
  return hint ? `${message}\n${hint}` : message;
}

async function callTool(id: unknown, params: unknown): Promise<string> {
  const name = isRecord(params) ? params.name : undefined;
  if (typeof name !== "string") return failure(id, INVALID_PARAMS, "tools/call needs a tool name.");
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return failure(id, INVALID_PARAMS, `Unknown tool: ${name}`);
  const args = isRecord(params) && isRecord(params.arguments) ? params.arguments : {};
  try {
    return reply(id, { content: [{ type: "text", text: await tool.run(args) }] });
  } catch (error) {
    return reply(id, { content: [{ type: "text", text: toolErrorText(error) }], isError: true });
  }
}

/**
 * One line of the stdio stream in, the line to answer it with out. A notification
 * (a request with no `id`) and a client's own response get no answer.
 */
async function handleMcpLine(line: string): Promise<string | undefined> {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return failure(null, PARSE_ERROR, "Parse error");
  }
  if (!isRecord(message) || message.jsonrpc !== "2.0") return failure(null, INVALID_REQUEST, "Invalid Request");
  if (typeof message.method !== "string") {
    // A response to a request akm never sent: ignore it.
    return "result" in message || "error" in message ? undefined : failure(null, INVALID_REQUEST, "Invalid Request");
  }
  const { id, method, params } = message;
  if (id === undefined) return undefined;
  if (typeof id !== "string" && typeof id !== "number")
    return failure(null, INVALID_REQUEST, "Invalid Request: bad id");
  switch (method) {
    case "initialize": {
      const asked = isRecord(params) ? params.protocolVersion : undefined;
      const protocolVersion = PROTOCOL_VERSIONS.find((version) => version === asked) ?? PROTOCOL_VERSIONS[0];
      return reply(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "akm", version: pkgVersion },
      });
    }
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        })),
      });
    case "tools/call":
      return callTool(id, params);
    default:
      return failure(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

export const mcpCommand = defineCommand({
  meta: {
    name: "mcp",
    description:
      "Serve read-only akm search and show to an MCP client over stdio (JSON-RPC 2.0). Run it as the client's MCP server command: `akm mcp`.",
  },
  run() {
    return runWithJsonErrors(async () => {
      for await (const line of createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })) {
        if (!line.trim()) continue;
        const answer = await handleMcpLine(line);
        // Not console.log: on Bun it can write only part of a large string to a pipe (see src/output/stdout.ts).
        if (answer !== undefined) process.stdout.write(`${answer}\n`);
      }
    });
  },
});
