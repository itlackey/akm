// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { registerTextFormatter } from "./registry";

registerTextFormatter("move", (r) => {
  const obj = (r ?? {}) as { from?: unknown; to?: unknown; toPath?: unknown };
  const from = typeof obj.from === "string" ? obj.from : "?";
  const to = typeof obj.to === "string" ? obj.to : "?";
  const toPath = typeof obj.toPath === "string" ? ` (${obj.toPath})` : "";
  return `Moved ${from} -> ${to}${toPath}`;
});
