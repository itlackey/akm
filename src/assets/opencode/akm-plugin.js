// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The OpenCode 2 plugin of akm's own agent runtime. akm writes this file to the runtime's config directory and names
// it in the inline config's `plugins` list (src/integrations/harnesses/opencode/runtime/). It runs inside OpenCode, so
// it imports no package: only Node's own child_process, to call back into akm.
//
//   - akm's three read tools, each a call of the akm executable `AKM_OPENCODE_CLI` names, with `--detail agent
//     --format json`. The run's environment is the call's, so a stamped run's reads (`AKM_EVENT_SOURCE`) are recorded
//     as that run's.
//   - The connection's request fields, laid over each model request in the endpoint's own field names, as the chat
//     transport sends them. OpenCode sizes every request's output cap from the model's limit and sends it as
//     `max_tokens` or `max_completion_tokens`; that is its own accounting, not a cap anyone asked for, so it is
//     dropped, and the connection's fields carry a cap only when the connection writes one.

import { execFile } from "node:child_process";

const OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;

const TOOLS = [
  {
    name: "akm_curate",
    command: "curate",
    positional: "query",
    description:
      "Find the akm assets (skills, knowledge, memories, workflows) that best fit a task. Read one with akm_show before relying on it.",
    input: {
      type: "object",
      properties: {
        query: { type: "string", description: "The task or question" },
        type: { type: "string", description: "Optional asset type filter" },
        limit: { type: "integer", minimum: 1 },
      },
      required: ["query"],
    },
  },
  {
    name: "akm_search",
    command: "search",
    positional: "query",
    description: "Search akm assets by name or keyword.",
    input: {
      type: "object",
      properties: {
        query: { type: "string" },
        type: { type: "string", description: "Optional asset type filter" },
        limit: { type: "integer", minimum: 1 },
      },
      required: ["query"],
    },
  },
  {
    name: "akm_show",
    command: "show",
    positional: "ref",
    description: "Read one akm asset by its ref, as returned by akm_curate or akm_search.",
    input: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
  },
];

const text = (value) => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);

/** The arguments of one tool call for the akm CLI; throws when the required one is missing. */
function cliArguments(tool, input) {
  const value = text(input?.[tool.positional]);
  if (!value) throw new Error(`"${tool.positional}" is required`);
  const type = text(input?.type);
  const limit = Number.isInteger(input?.limit) && input.limit > 0 ? String(input.limit) : undefined;
  return [
    tool.command,
    value,
    ...(type && tool.positional !== "ref" ? ["--type", type] : []),
    ...(limit && tool.positional !== "ref" ? ["--limit", limit] : []),
    "--detail",
    "agent",
    "--format",
    "json",
  ];
}

function runAkm(cli, args) {
  return new Promise((resolve, reject) => {
    execFile(
      cli,
      args,
      { encoding: "utf8", maxBuffer: OUTPUT_LIMIT_BYTES, env: process.env },
      (error, stdout, stderr) => {
        if (error) reject(new Error((stderr || error.message).trim()));
        else resolve(stdout);
      },
    );
  });
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** `over` laid over `base`; an object on both sides is merged one level deep, anything else of `over` wins. */
function withFields(base, over) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(over)) {
    merged[key] = isObject(merged[key]) && isObject(value) ? { ...merged[key], ...value } : value;
  }
  return merged;
}

export default {
  id: "akm",
  setup: async (ctx) => {
    await ctx.tool.transform((editor) => {
      for (const tool of TOOLS) {
        editor.add({
          name: tool.name,
          description: tool.description,
          input: tool.input,
          options: { codemode: false },
          execute: async (input) => {
            try {
              const args = cliArguments(tool, input);
              const cli = process.env.AKM_OPENCODE_CLI;
              if (!cli) throw new Error("AKM_OPENCODE_CLI is not set");
              return { content: await runAkm(cli, args) };
            } catch (error) {
              return { content: `${tool.name} failed: ${error instanceof Error ? error.message : String(error)}` };
            }
          },
        });
      }
    });

    const fields = ctx.options?.requestFields;
    await ctx.session.hook("http.request", async (event) => {
      const request = event.request;
      if (request.body === null) return;
      let body;
      try {
        body = JSON.parse(await request.clone().text());
      } catch {
        return;
      }
      if (!isObject(body)) return;
      const { max_tokens: _own, max_completion_tokens: _ownCompletion, ...kept } = body;
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      event.request = new Request(request.url, {
        method: request.method,
        headers,
        body: JSON.stringify(isObject(fields) ? withFields(kept, fields) : kept),
        signal: request.signal,
      });
    });
  },
};
