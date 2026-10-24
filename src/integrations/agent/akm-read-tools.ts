// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * akm's read-only tools for agent work, in harness-neutral form (#1244): the
 * `akm` capability. A harness adapts each one to its own tool API; the tool runs
 * in akm's process and returns what `akm --detail agent <command> --format json`
 * would print.
 */
import { renderOutput } from "../../cli/shared";
import { akmSearch } from "../../commands/read/search";
import { runCurate } from "../../commands/read/search-cli";
import { akmShowUnified } from "../../commands/read/show";
import { loadConfig } from "../../core/config/config";
import { withQuiet } from "../../core/warn";
import { resolveOutputMode } from "../../output/context";
import { stdoutText } from "../../output/stdout";

export interface AkmReadTool {
  readonly name: "akm_search" | "akm_show" | "akm_curate";
  readonly description: string;
  /** JSON Schema of the tool input. */
  readonly inputSchema: Record<string, unknown>;
  readonly run: (input: Record<string, unknown>) => Promise<string>;
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
const positiveInt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

/** Run one read command the way the CLI does with `--detail agent --format json`, quietly. */
function asCli(command: string, compute: (mode: ReturnType<typeof resolveOutputMode>) => Promise<unknown>) {
  return withQuiet(async () => {
    const mode = resolveOutputMode(["--detail", "agent", "--format", "json"], loadConfig().output ?? {});
    return stdoutText(renderOutput(command, await compute(mode), { ...mode, format: "json" }));
  });
}

function required(input: Record<string, unknown>, key: string): string {
  const value = str(input[key]);
  if (!value) throw new Error(`"${key}" is required`);
  return value;
}

export const AKM_READ_TOOLS: readonly AkmReadTool[] = [
  {
    name: "akm_curate",
    description:
      "Find the akm assets (skills, knowledge, memories, workflows) that best fit a task. Read one with akm_show before relying on it.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The task or question" },
        type: { type: "string", description: "Optional asset type filter" },
        limit: { type: "integer", minimum: 1 },
      },
      required: ["query"],
    },
    run: (input) =>
      asCli("curate", (mode) =>
        runCurate(
          {
            query: required(input, "query"),
            type: str(input.type),
            limit: positiveInt(input.limit) === undefined ? undefined : String(input.limit),
          },
          mode,
        ),
      ),
  },
  {
    name: "akm_search",
    description: "Search akm assets by name or keyword.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        type: { type: "string", description: "Optional asset type filter" },
        limit: { type: "integer", minimum: 1 },
      },
      required: ["query"],
    },
    run: (input) =>
      asCli("search", () =>
        akmSearch({ query: required(input, "query"), type: str(input.type), limit: positiveInt(input.limit) }),
      ),
  },
  {
    name: "akm_show",
    description: "Read one akm asset by its ref, as returned by akm_curate or akm_search.",
    inputSchema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
    run: (input) => asCli("show", () => akmShowUnified({ ref: required(input, "ref") })),
  },
];
