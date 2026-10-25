// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Local stand-ins for what a test drives a command against: an LLM stub on
 * 127.0.0.1 standing for a connection and a fake harness binary. Each replays scripted replies, so a test
 * sees what reached it and what the command did with the reply.
 */

import fs from "node:fs";
import path from "node:path";

/** What an LLM stub recorded of one request. */
export interface LlmStubBody {
  messages: Array<{ content: string }>;
  response_format?: { json_schema?: { schema?: unknown } };
}

/** What a connection or harness says to its `call`th request, from its scripted replies; the last one repeats. */
export function scriptedReply(replies: readonly string[], call: number): string {
  return replies[Math.min(call, replies.length) - 1] ?? "";
}

/**
 * An LLM stub that answers by the first path segment of the connection's endpoint,
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
  /** What was written to its stdin: the prompt, for a harness that reads it there. */
  stdin: string;
  /** The environment it was started with. */
  env: Record<string, string>;
  eventSource: string | null;
  cwd: string;
}

/** How a fake harness binary behaves beyond printing its scripted replies. */
export interface FakeHarnessOptions {
  /** Read stdin and record it. False for an interactive launch, whose stdin is the terminal's. Default true. */
  readStdin?: boolean;
  /** Printed on stderr after the reply. */
  stderr?: string;
  /** Exit code. Default 0. */
  exitCode?: number;
  /** Print nothing and sleep until killed, after recording the call. */
  hang?: boolean;
  /** Wait this long, after recording the call, before answering. */
  delayMs?: number;
}

/**
 * A fake harness binary. It records each call's argv, stdin, env, event source and
 * working directory beside itself (`<bin>.call.<n>`, `<bin>.count`) and prints
 * the scripted reply as plain text, per {@link scriptedReply}.
 */
export function fakeHarness(replies: readonly string[], options: FakeHarnessOptions = {}): string {
  const behaviour = options.hang
    ? 'require("node:child_process").spawnSync("sleep", ["30"]);'
    : `setTimeout(() => {
  process.stdout.write(replies[Math.min(call, replies.length) - 1] + "\\n");${
    options.stderr ? ` process.stderr.write(${JSON.stringify(options.stderr)});` : ""
  }
  process.exitCode = ${options.exitCode ?? 0};
}, ${options.delayMs ?? 0});`;
  return `#!${process.execPath}
const fs = require("node:fs");
const self = process.argv[1];
const argv = process.argv.slice(2);
const stdin = ${options.readStdin === false ? '""' : 'fs.readFileSync(0, "utf8")'};
const countFile = self + ".count";
const call = (fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) : 0) + 1;
fs.writeFileSync(countFile, String(call));
fs.writeFileSync(self + ".call." + call, JSON.stringify({ argv, stdin, env: process.env, eventSource: process.env.AKM_EVENT_SOURCE ?? null, cwd: process.cwd() }));
const replies = ${JSON.stringify(replies)};
${behaviour}
`;
}

/** Write a fake harness binary named `name` into `dir`; returns its path. */
export function writeFakeHarness(
  dir: string,
  name: string,
  replies: readonly string[] = [""],
  options?: FakeHarnessOptions,
): string {
  const bin = path.join(dir, name);
  fs.writeFileSync(bin, fakeHarness(replies, options), { mode: 0o755 });
  return bin;
}

/** The prompt a recorded call carried: its stdin, or the last argument of a harness that takes it on the command line. */
export function promptOf(call: HarnessCall | undefined): string {
  return call?.stdin ? call.stdin : (call?.argv.at(-1) ?? "");
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
