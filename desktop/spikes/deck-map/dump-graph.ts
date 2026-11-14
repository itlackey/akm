// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Writes `assets.graph()` from the working tree, for the configured HOME/XDG paths, to a JSON file the spike loads.
//   bun dump-graph.ts public/graph.json
import { graph } from "../../../src/workspace/graph.ts";

const out = process.argv[2] ?? "public/graph.json";
const g = await graph();
await Bun.write(out, JSON.stringify(g));
console.error(g.note);
