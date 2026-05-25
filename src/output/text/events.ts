// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Output text formatters for `akm events list` / `akm events tail` (#204).
// Both share a renderer; `events-tail` is also called per-event by the streaming
// code path via `formatEventLine`.

import { formatEventsPlain } from "./helpers";
import { registerTextFormatter } from "./registry";

registerTextFormatter("events-list", (r) => formatEventsPlain(r));
registerTextFormatter("events-tail", (r) => formatEventsPlain(r));
