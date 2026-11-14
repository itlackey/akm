// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Serves the built spike, the graph dump, and `assets.related` from the working tree for the configured HOME/XDG
// paths, the way Desktop's server answers `/api/related`.
//   bun serve.ts [port=4790]
import { join } from "node:path";
import { related } from "../../../src/workspace/assets.ts";

const port = Number(process.argv[2] ?? 4790);
const dist = join(import.meta.dir, "dist");
Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/related")
      return Response.json(await related({ ref: url.searchParams.get("ref") ?? "" }));
    if (url.pathname === "/graph.json") return new Response(Bun.file(join(import.meta.dir, "public/graph.json")));
    const file = Bun.file(join(dist, url.pathname === "/" ? "local.html" : url.pathname));
    return (await file.exists()) ? new Response(file) : new Response("Not found", { status: 404 });
  },
});
console.error(`http://localhost:${port}/`);
