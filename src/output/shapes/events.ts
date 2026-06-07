// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Output shape registration for `akm events list` and `akm events tail` (#204).
// Both share the same envelope; the renderer in text.ts uses distinct command
// names so it can format streaming differently.

import { shapeEventsOutput } from "./helpers";
import type { OutputShapeEntry } from "./registry";

const handler = (result: unknown, detail: Parameters<typeof shapeEventsOutput>[1]) =>
  shapeEventsOutput(result as Record<string, unknown>, detail);

export const eventsShapes: OutputShapeEntry[] = [
  { command: "events-list", handler },
  { command: "events-tail", handler },
];
