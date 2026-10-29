// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The OpenCode 2 plugin of akm's own agent runtime. akm writes this file to the runtime's config directory and names
// it in the inline config's `plugins` list (src/integrations/harnesses/opencode/runtime/). It runs inside OpenCode, so
// it imports no package: only Node's own child_process, to call back into akm.
//
//   - akm's three read tools, each a run of the akm that started OpenCode, with `--detail agent --format json`
//     (`--detail brief` when akm_show asks for a document's outline). akm passes the argv that runs it in
//     `AKM_OPENCODE_CLI`, a JSON array: the executable alone for a compiled akm, the runtime and the script for one
//     run as a script (Node and `dist/akm`, say), so no shebang or shell is needed on any platform. The run's
//     environment is the call's, so a stamped run's reads (`AKM_EVENT_SOURCE`) are recorded as that run's.
//   - The environment of the commands the agent runs: the variables akm set for the OpenCode process (its roots and
//     its OpenCode settings) are put back to what akm runs in, or removed, so the agent's shell sees the environment a
//     harness's child would.
//   - The connection's request fields, laid over each model request in the endpoint's own field names, as the chat
//     transport sends them. OpenCode sizes every request's output cap from the model's limit and sends it as
//     `max_tokens` or `max_completion_tokens`; that is its own accounting, not a cap anyone asked for, so it is
//     dropped, and the connection's fields carry a cap only when the connection writes one.
//   - The end of a run that has stopped getting anywhere: when the model has made the same tool calls three turns in a
//     row and been given the same results each time, the run fails with a message that says so, before the next model
//     request is sent. OpenCode has no such check of its own (its `doom_loop` setting is read and ignored), and a run
//     that never ends has nothing else to stop it when the connection sets no `timeoutMs`.

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
    description:
      'Read one akm asset by its ref, as returned by akm_curate or akm_search. For a large document, call it with detail "brief" for its outline (toc, no body), then with ref#<slug> for only the sections you need.',
    input: {
      type: "object",
      properties: {
        ref: { type: "string" },
        detail: { type: "string", enum: ["brief"], description: "brief: the outline (toc) without the body" },
      },
      required: ["ref"],
    },
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
    tool.positional === "ref" && input?.detail === "brief" ? "brief" : "agent",
    "--format",
    "json",
  ];
}

/** The argv in `AKM_OPENCODE_CLI`; throws unless it is a JSON array of strings with at least the executable. */
function akmArgv() {
  const raw = process.env.AKM_OPENCODE_CLI;
  if (!raw) throw new Error("AKM_OPENCODE_CLI is not set");
  const argv = JSON.parse(raw);
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((part) => typeof part === "string")) {
    throw new Error("AKM_OPENCODE_CLI is not a JSON array of strings");
  }
  return argv;
}

function runAkm([executable, ...prefix], args) {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...prefix, ...args],
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

/** How many turns in a row may make the same tool calls and get the same results before the run is stopped (the message says "three"). */
const REPEATED_TURNS = 3;

/**
 * A tool result as the check compares it. OpenCode saves an output too long to send whole to a file of its own for each
 * call and names that file in the result (`[showing … of …; full output saved to <file>]`), so the name is left out:
 * the same long output is the same result.
 */
const comparable = (content) =>
  JSON.stringify(content).replace(/full output saved to [^\]]*\]/g, "full output saved to <file>]");

/**
 * The names of the tools the model keeps calling, when each of the last REPEATED_TURNS turns of a chat request made the
 * same calls (the same name and arguments, ids ignored, parallel calls as a set) and was answered with the same
 * results, else undefined. A model that does this has settled on one answer to what it is told and does not leave it;
 * a call whose result changes (a poll) is not repeated.
 */
function repeatedToolCalls(messages) {
  if (!Array.isArray(messages)) return undefined;
  const turns = [];
  let names = [];
  let results = new Map();
  // From the newest message back: the tool results, then the assistant message that made the calls they answer.
  for (let i = messages.length - 1; i >= 0 && turns.length < REPEATED_TURNS; i--) {
    const message = messages[i];
    if (message?.role === "tool") {
      results.set(message.tool_call_id, comparable(message.content));
      continue;
    }
    if (message?.role !== "assistant" || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
      return undefined;
    }
    const calls = message.tool_calls.map((call) => [
      call?.function?.name,
      call?.function?.arguments,
      results.get(call?.id),
    ]);
    if (calls.some(([name, , result]) => name === undefined || result === undefined)) return undefined;
    if (turns.length === 0) names = [...new Set(calls.map(([name]) => name))];
    turns.push(
      calls
        .map((call) => JSON.stringify(call))
        .sort()
        .join("\n"),
    );
    results = new Map();
  }
  return turns.length === REPEATED_TURNS && turns.every((turn) => turn === turns[0]) ? names : undefined;
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
              return { content: await runAkm(akmArgv(), args) };
            } catch (error) {
              return { content: `${tool.name} failed: ${error instanceof Error ? error.message : String(error)}` };
            }
          },
        });
      }
    });

    const shellEnv = ctx.options?.shellEnv;
    if (isObject(shellEnv)) {
      await ctx.shell.hook("create.before", async (event) => {
        for (const [name, value] of Object.entries(shellEnv)) {
          if (typeof value === "string") event.env[name] = value;
          else delete event.env[name];
        }
      });
    }

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
      // Measured on OpenCode 2.2.0: an error thrown from this hook fails the run's turn before the request is sent, and
      // `opencode run` exits 1 with the error's message (an unknown error in the session, which akm reports as a
      // non-zero exit). Answering the request with a 4xx instead also ends the run, but only after the request has gone
      // to the model.
      const repeated = repeatedToolCalls(body.messages);
      if (repeated) {
        const tools = repeated.map((name) => `\`${name}\``).join(", ");
        throw new Error(
          `akm stopped this run: the model called ${tools} with the same input three times in a row and got the same result each time.`,
        );
      }
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
