// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";

const fixtureArgs = process.argv.slice(2);
if (fixtureArgs.length !== 3 || fixtureArgs.some((value) => value.length === 0)) {
  process.stderr.write("Usage: bun fake-services.ts <metadata.json> <requests.jsonl> <site-version.txt>\n");
  process.exit(2);
}
const [metadataPath, requestLogPath, siteVersionPath] = fixtureArgs as [string, string, string];

const registryIndex = fs.readFileSync(path.join(import.meta.dir, "registry-index.json"), "utf8");

function appendRequest(request: Request, body?: Record<string, unknown>): void {
  const input = body?.input;
  fs.appendFileSync(
    requestLogPath,
    `${JSON.stringify({
      method: request.method,
      pathname: new URL(request.url).pathname,
      authorizationPresent: request.headers.has("authorization"),
      model: typeof body?.model === "string" ? body.model : undefined,
      messageCount: Array.isArray(body?.messages) ? body.messages.length : undefined,
      inputCount: Array.isArray(input) ? input.length : input === undefined ? undefined : 1,
      maxTokensPresent: body ? Object.hasOwn(body, "max_tokens") : undefined,
      responseFormatPresent: body ? Object.hasOwn(body, "response_format") : undefined,
    })}\n`,
  );
}

function chatResponse(content: string): Response {
  return Response.json({
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

function siteVersion(): string {
  try {
    return fs.readFileSync(siteVersionPath, "utf8").trim() || "v1";
  } catch {
    return "v1";
  }
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    let body: Record<string, unknown> | undefined;
    if (request.method === "POST" && request.headers.get("content-type")?.includes("application/json")) {
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        body = undefined;
      }
    }
    appendRequest(request, body);

    if (url.pathname === "/ok/chat/completions") {
      return chatResponse(
        JSON.stringify({
          tags: ["manual-qa"],
          description: "Deterministic manual QA response",
          observed: "2026-08-05",
          complete: true,
          missing: [],
          feedback: "",
        }),
      );
    }
    if (url.pathname === "/probe/chat/completions") {
      return chatResponse('{"ok":true,"ingest":true,"lint":true}');
    }
    if (url.pathname === "/proposal/chat/completions") {
      return chatResponse(
        JSON.stringify({
          ref: "lessons/qa-llm-proposal",
          content:
            "---\ndescription: Deterministic LLM proposal fixture\nwhen_to_use: Verifying controlled proposal generation\n---\n\nUse the controlled manual QA service.\n",
        }),
      );
    }
    if (url.pathname === "/reject/chat/completions") {
      return chatResponse('{"complete":false,"missing":["fixture criterion"],"feedback":"qa-gate-rejected"}');
    }
    if (url.pathname === "/malformed/chat/completions") return chatResponse("not-json");
    if (url.pathname === "/invalid-envelope/chat/completions") return Response.json({ invalid: true });
    if (url.pathname === "/error/chat/completions") return new Response("qa-llm-http-500", { status: 500 });
    if (url.pathname === "/echo-auth/chat/completions") {
      return new Response(`qa-echoed-credential=${request.headers.get("authorization") ?? "missing"}`, { status: 500 });
    }
    if (url.pathname === "/slow/chat/completions") {
      await Bun.sleep(10_000);
      return chatResponse('{"complete":true,"missing":[]}');
    }

    if (url.pathname === "/v1/embeddings") {
      const input = body?.input;
      const count = Array.isArray(input) ? input.length : 1;
      return Response.json({
        object: "list",
        model: "qa-embedding",
        data: Array.from({ length: count }, (_, index) => ({
          object: "embedding",
          index,
          embedding: [1, index % 2, 0, 0],
        })),
        usage: { prompt_tokens: count, total_tokens: count },
      });
    }
    if (url.pathname === "/error/embeddings") return new Response("qa-embedding-http-500", { status: 500 });
    if (url.pathname === "/slow/embeddings") {
      await Bun.sleep(10_000);
      return Response.json({ data: [] });
    }

    if (url.pathname === "/registry/index.json") {
      return new Response(registryIndex, { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/registry/malformed.json") {
      return new Response("{", { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/registry/error.json") return new Response("qa-registry-http-500", { status: 500 });

    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /site/private\nCrawl-delay: 0\n", {
        headers: { "content-type": "text/plain" },
      });
    }
    if (url.pathname === "/site/" || url.pathname === "/site") {
      return new Response(
        `<html><body><h1>Manual QA Site ${siteVersion()}</h1><a href="/site/a">A</a><a href="/site/b">B</a><a href="/site/private">Private</a></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    }
    if (url.pathname === "/site/a") {
      return new Response(`<html><body><h1>Page A</h1><p>qa-site-a-${siteVersion()}</p></body></html>`, {
        headers: { "content-type": "text/html" },
      });
    }
    if (url.pathname === "/site/b") {
      return new Response(`<html><body><h1>Page B</h1><p>qa-site-b-${siteVersion()}</p></body></html>`, {
        headers: { "content-type": "text/html" },
      });
    }
    if (url.pathname === "/site/private") {
      return new Response("<html><body>qa-site-private-must-not-be-crawled</body></html>", {
        headers: { "content-type": "text/html" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

const baseUrl = `http://${server.hostname}:${server.port}`;
fs.writeFileSync(
  metadataPath,
  `${JSON.stringify({
    pid: process.pid,
    baseUrl,
    chat: {
      ok: `${baseUrl}/ok/chat/completions`,
      probe: `${baseUrl}/probe/chat/completions`,
      proposal: `${baseUrl}/proposal/chat/completions`,
      reject: `${baseUrl}/reject/chat/completions`,
      malformed: `${baseUrl}/malformed/chat/completions`,
      invalidEnvelope: `${baseUrl}/invalid-envelope/chat/completions`,
      error: `${baseUrl}/error/chat/completions`,
      echoAuth: `${baseUrl}/echo-auth/chat/completions`,
      slow: `${baseUrl}/slow/chat/completions`,
    },
    embeddings: `${baseUrl}/v1/embeddings`,
    registry: `${baseUrl}/registry/index.json`,
    website: `${baseUrl}/site/`,
  })}\n`,
);

const stop = (): void => {
  server.stop(true);
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

await new Promise<never>(() => {});
