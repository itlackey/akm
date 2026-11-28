// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { resolve } from "$app/paths";
import { setRoot } from "./lib/client";

// Where the UI is served from, set once before anything loads. Kit 3 has no `base` export: the root route is the base
// path and a slash.
setRoot(resolve("/").slice(0, -1));

// An app that frames the UI names its own style sheet in the frame's address: `?theme=<absolute http(s) URL>`
// (docs/theming.md). It is linked after the UI's own styles and is unlayered, so its `:root` custom properties win over
// `@layer tokens`. The page's policy takes style sheets only from the UI's origin and the frame parents
// (hooks.server.ts). Session storage keeps it for this frame across reloads; a later `?theme=` replaces it.
let theme = new URL(location.href).searchParams.get("theme");
try {
  if (theme === null) theme = sessionStorage.getItem("akm-theme");
  else sessionStorage.setItem("akm-theme", theme);
} catch {
  // Storage is blocked: the sheet lasts until the frame reloads.
}
if (theme && /^https?:\/\//i.test(theme))
  document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href: theme }));
