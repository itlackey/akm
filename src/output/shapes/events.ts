// Output shape registration for `akm events list` and `akm events tail` (#204).
// Both share the same envelope; the renderer in text.ts uses distinct command
// names so it can format streaming differently.

import { shapeEventsOutput } from "./helpers";
import { registerOutputShape } from "./registry";

const handler = (result: unknown, detail: Parameters<typeof shapeEventsOutput>[1]) =>
  shapeEventsOutput(result as Record<string, unknown>, detail);

registerOutputShape("events-list", handler);
registerOutputShape("events-tail", handler);
