// Output text formatters for `akm events list` / `akm events tail` (#204).
// Both share a renderer; `events-tail` is also called per-event by the streaming
// code path via `formatEventLine`.

import { formatEventsPlain } from "./helpers";
import { registerTextFormatter } from "./registry";

registerTextFormatter("events-list", (r) => formatEventsPlain(r));
registerTextFormatter("events-tail", (r) => formatEventsPlain(r));
