// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A loopback OpenAI-compatible model for driving the real OpenCode binary in
 * tests. Its behaviour comes from the first user message: `MODE:<name>`.
 *
 *   answer    reply "ANSWER-<n>"
 *   question  call the `question` tool, then reply "Q-DONE"
 *   shell     call `shell`, then reply with the tool result
 *   env       call `shell` to print $AKM_PROBE, $AKM_AMBIENT, $HOME and $AKM_CONFIG_DIR, then reply with the tool result
 *   runtime   call `shell` to print the variables akm's own runtime sets for the OpenCode process, then reply with the tool result
 *   hang      accept the request and never answer it
 *   subagent  call `subagent`, whose prompt asks the child for MODE:env, then reply with its result
 *   write     call `write`, then reply with the tool result
 *   akm       call `akm_search`, then reply with the tool result
 *   length    first step cut at the output limit, then "PART-TWO"
 *   cutoff    every step cut at the output limit
 *   compact   a tool step reporting a nearly full context, which makes OpenCode
 *             compact the conversation mid-turn
 *
 * `requests` records what each call offered and asked, for assertions.
 */

type Message = { role: string; content?: unknown };
const text = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("")
      : "";

export interface FakeModelRequest {
  readonly mode: string;
  /** The path and query the request was made to. */
  readonly url: string;
  readonly tools: readonly string[];
  readonly system: string;
  readonly lastUser: string;
  readonly toolResult?: string;
  /** The request's other fields: sampling and limits. */
  readonly params: Record<string, unknown>;
  /** The request asked the model to summarize the conversation (a compaction). */
  readonly summarize: boolean;
  /** The `Authorization` header the request carried, if any. */
  readonly authorization?: string;
}

export interface FakeModelServer {
  readonly url: string;
  readonly requests: FakeModelRequest[];
  stop(): void;
}

/** A shell command that prints the variables akm's own runtime sets for the OpenCode process, each as `LABEL=value` or `LABEL=unset`. */
const RUNTIME_PROBE = `echo "${Object.entries({
  CONFIG: "OPENCODE_CONFIG_CONTENT",
  DATA: "XDG_DATA_HOME",
  CACHE: "XDG_CACHE_HOME",
  TMP: "TMPDIR",
  FREE: "OPENCODE_DISABLE_FREE_MODELS",
  SOURCE: "AKM_EVENT_SOURCE",
  DIR: "AKM_DATA_DIR",
})
  .map(([label, name]) => `${label}=$(printenv ${name} || echo unset)`)
  .join(" ")}"`;

export function startFakeModel(): FakeModelServer {
  const requests: FakeModelRequest[] = [];
  let n = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.method === "GET") return Response.json({ object: "list", data: [{ id: "fake-model", object: "model" }] });
      const body = (await req.json()) as { messages?: Message[]; tools?: { function?: { name?: string } }[] };
      const { messages: _messages, tools: _tools, ...params } = body as Record<string, unknown>;
      n += 1;
      const messages = body.messages ?? [];
      const users = messages.filter((m) => m.role === "user").map((m) => text(m.content));
      const system = messages
        .filter((m) => m.role === "system")
        .map((m) => text(m.content))
        .join("\n");
      const tools = (body.tools ?? []).map((t) => t.function?.name ?? "");
      const last = messages.at(-1);
      const afterTool = last?.role === "tool";
      const assistants = messages.filter((m) => m.role === "assistant").length;
      let mode = /MODE:(\w+)/.exec(users.find((u) => /MODE:\w+/.test(u)) ?? "")?.[1] ?? "answer";
      if (!tools.length && /title/i.test(system)) mode = "title";
      const all = messages.map((m) => text(m.content)).join("\n");
      const authorization = req.headers.get("authorization");
      const target = new URL(req.url);
      requests.push({
        mode,
        url: `${target.pathname}${target.search}`,
        ...(authorization ? { authorization } : {}),
        tools,
        system,
        params,
        summarize: /MUST summarize the conversation|MUST use this format/.test(all),
        lastUser: users.at(-1) ?? "",
        ...(afterTool ? { toolResult: text(last?.content) } : {}),
      });
      // A tool result can carry paths under TMPDIR, so the cap has to clear any path a host can have.
      const result = text(last?.content).slice(0, 4000);
      let reply: { content?: string; tool?: { name: string; args: unknown }; finish?: string; big?: boolean } = {
        content: `ANSWER-${n}`,
      };
      if (mode === "title") reply = { content: "Test title" };
      else if (mode === "question")
        reply = afterTool
          ? { content: "Q-DONE" }
          : {
              tool: {
                name: "question",
                args: {
                  questions: [{ question: "Which?", header: "Pick", options: [{ label: "A", description: "a" }] }],
                },
              },
            };
      else if (mode === "shell")
        reply = afterTool
          ? { content: `SHELL:${result}` }
          : { tool: { name: "shell", args: { command: "echo HELLO", description: "hello" } } };
      else if (mode === "env")
        reply = afterTool
          ? { content: `ENV:${result}` }
          : {
              tool: {
                name: "shell",
                args: {
                  command: 'echo "PROBE=$AKM_PROBE AMBIENT=$AKM_AMBIENT HOME=$HOME CONFIG=$AKM_CONFIG_DIR"',
                  description: "probe",
                },
              },
            };
      else if (mode === "runtime")
        reply = afterTool
          ? { content: `RUNTIME:${result}` }
          : { tool: { name: "shell", args: { command: RUNTIME_PROBE, description: "probe" } } };
      else if (mode === "subagent")
        reply = afterTool
          ? { content: `SUB:${result}` }
          : {
              tool: {
                name: "subagent",
                args: { agent: "general", description: "probe the child", prompt: "MODE:env from the child" },
              },
            };
      else if (mode === "write")
        reply = afterTool
          ? { content: `WRITE:${result}` }
          : { tool: { name: "write", args: { filePath: "x.md", content: "hi" } } };
      else if (mode === "akm")
        reply = afterTool ? { content: `AKM:${result}` } : { tool: { name: "akm_search", args: { query: "demo" } } };
      else if (mode === "length")
        reply = assistants === 0 ? { content: "PART-ONE ", finish: "length" } : { content: "PART-TWO" };
      else if (mode === "cutoff") reply = { content: `CUT-${assistants} `, finish: "length" };
      else if (mode === "compact") {
        if (/MUST summarize the conversation|MUST use this format/.test(all) && !/SUMMARY-TEXT/.test(all))
          reply = { content: "## Objective\n- SUMMARY-TEXT" };
        else if (!afterTool && !/SUMMARY-TEXT/.test(all))
          reply = { tool: { name: "shell", args: { command: "echo BIG", description: "big" } }, big: true };
        else reply = { content: "COMPACT-DONE" };
      }
      if (mode === "hang") return new Promise<Response>(() => {});
      const id = `c${n}`;
      const created = Math.floor(Date.now() / 1000);
      const usage = reply.big
        ? { prompt_tokens: 38000, completion_tokens: 7, total_tokens: 38007 }
        : { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };
      const finish = reply.tool ? "tool_calls" : (reply.finish ?? "stop");
      const chunk = (delta: unknown, f: string | null, extra: Record<string, unknown> = {}) =>
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "fake-model", choices: [{ index: 0, delta, finish_reason: f }], ...extra })}\n\n`;
      let out = reply.tool
        ? chunk(
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `call_${n}`,
                  type: "function",
                  function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) },
                },
              ],
            },
            null,
          )
        : chunk({ role: "assistant", content: reply.content }, null);
      out += chunk({}, finish, { usage });
      out += "data: [DONE]\n\n";
      return new Response(out, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) };
}
