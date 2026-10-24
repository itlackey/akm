// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Local stand-ins for the engines a per-engine test drives: an LLM stub on
 * 127.0.0.1 and a fake harness binary. Each replays scripted replies, so a test
 * sees what reached the engine and what the command did with the reply.
 */

import fs from "node:fs";

/** What an LLM stub recorded of one request. */
export interface LlmStubBody {
  messages: Array<{ content: string }>;
  response_format?: { json_schema?: { schema?: unknown } };
}

/** What an engine says to its `call`th request, from its scripted replies; the last one repeats. */
export function scriptedReply(replies: readonly string[], call: number): string {
  return replies[Math.min(call, replies.length) - 1] ?? "";
}

/**
 * An LLM stub that answers by the first path segment of the engine's endpoint,
 * with a list of scripted replies or a function of the request. `bodies` holds
 * every request body it has received, in order.
 */
export function serveLlmStub(
  scenarios: Record<string, readonly string[] | ((req: Request) => Response | Promise<Response>)>,
) {
  const bodies: LlmStubBody[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const scenario = scenarios[new URL(req.url).pathname.split("/")[1] ?? ""];
      if (!scenario) return new Response("unknown scenario", { status: 404 });
      bodies.push((await req.json()) as LlmStubBody);
      if (typeof scenario === "function") return scenario(req);
      return Response.json({ choices: [{ message: { content: scriptedReply(scenario, bodies.length) } }] });
    },
  });
  return { server, bodies };
}

/** What a fake harness binary saw on one call. */
export interface HarnessCall {
  argv: string[];
  eventSource: string | null;
  cwd: string;
}

/**
 * A fake harness binary. It records each call's argv, event source and working
 * directory beside itself (`<bin>.call.<n>`, `<bin>.count`) and replies per
 * {@link scriptedReply}: as Claude Code's result envelope when `--output-format
 * json` is passed and `framing` says so, as plain text otherwise.
 */
export function fakeHarness(replies: readonly string[], framing: "plain" | "claude" = "plain"): string {
  return `#!${process.execPath}
const fs = require("node:fs");
const self = process.argv[1];
const argv = process.argv.slice(2);
const countFile = self + ".count";
const call = (fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) : 0) + 1;
fs.writeFileSync(countFile, String(call));
fs.writeFileSync(self + ".call." + call, JSON.stringify({ argv, eventSource: process.env.AKM_EVENT_SOURCE ?? null, cwd: process.cwd() }));
const replies = ${JSON.stringify(replies)};
const text = replies[Math.min(call, replies.length) - 1];
const format = argv.indexOf("--output-format");
const envelope = ${JSON.stringify(framing)} === "claude" && format >= 0 && argv[format + 1] === "json";
process.stdout.write((envelope ? JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, session_id: "fake-claude-session" }) : text) + "\\n");
`;
}

/** The calls the fake harness at `bin` recorded, in order. */
export function harnessCalls(bin: string): HarnessCall[] {
  if (!fs.existsSync(`${bin}.count`)) return [];
  const count = Number(fs.readFileSync(`${bin}.count`, "utf8"));
  return Array.from(
    { length: count },
    (_, index) => JSON.parse(fs.readFileSync(`${bin}.call.${index + 1}`, "utf8")) as HarnessCall,
  );
}

/** Forget every call the fake harnesses in `dir` recorded. */
export function clearHarnessCalls(dir: string): void {
  for (const file of fs.readdirSync(dir)) {
    if (/\.(count|call\.\d+)$/.test(file)) fs.rmSync(`${dir}/${file}`);
  }
}
