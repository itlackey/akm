// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Preloaded into a test server (`node --import`): answers the release installer's URL with a local script, so a test
// can run Desktop's real install path without the network. Every other request goes where it was going.
import { readFileSync } from "node:fs";

const real = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  const script = process.env.AKM_TEST_INSTALLER;
  if (script && /^https:\/\/github\.com\/itlackey\/akm\/releases\/.+\/install\.sh$/.test(url))
    return Promise.resolve(new Response(readFileSync(script, "utf8")));
  return real(input, init);
};
