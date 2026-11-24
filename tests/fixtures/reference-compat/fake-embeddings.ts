// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A fake OpenAI-compatible embeddings server for the corpus's `embeddings` scenario: `bun fake-embeddings.ts <port-file>`
 * listens on a free local port, writes the port to `<port-file>` and answers every `/embeddings` request with an
 * 8-number vector that depends only on the text's length. The corpus records only whether a vector exists, so the numbers
 * need to be stable, not meaningful.
 */
import fs from "node:fs";

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/embeddings")) {
      const body = (await req.json()) as { input: string | string[]; model?: string };
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return Response.json({
        object: "list",
        model: body.model,
        data: inputs.map((text, index) => ({
          object: "embedding",
          index,
          embedding: Array.from({ length: 8 }, (_, k) => ((text.length * (k + 1)) % 17) / 17 + 0.01),
        })),
      });
    }
    if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "fake" }] });
    return new Response("not found", { status: 404 });
  },
});
fs.writeFileSync(process.argv[2] as string, String(server.port));
