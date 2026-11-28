// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { resolve } from "$app/paths";
import { setRoot } from "./lib/client";

// Where the UI is served from, set once before anything loads. Kit 3 has no `base` export: the root route is the base
// path and a slash.
setRoot(resolve("/").slice(0, -1));

// An app that frames the UI from another origin answers `{ akmReady }` with its token overrides, such as
// `#akm-web { --accent: … }`, as `{ akmCss }` (docs/theming.md); a same-origin app adds its style to this document
// directly. Only the parent page is heard, and `frame-ancestors` already limits who that can be.
if (window.parent !== window) {
  addEventListener("message", (event) => {
    if (event.source === window.parent && typeof event.data?.akmCss === "string")
      document.head.append(Object.assign(document.createElement("style"), { textContent: event.data.akmCss }));
  });
  window.parent.postMessage({ akmReady: true }, "*");
}
