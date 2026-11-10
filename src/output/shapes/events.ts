// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Output shape registration for `akm log`. `log-list` is an internal registry key only:
// `shapeEventsOutput` builds its own envelope and never stamps a `shape` field on the wire.

import { shapeEventsOutput } from "./helpers";
import type { OutputShapeEntry } from "./registry";

const handler = (result: unknown, detail: Parameters<typeof shapeEventsOutput>[1]) =>
  shapeEventsOutput(result as Record<string, unknown>, detail);

export const eventsShapes: OutputShapeEntry[] = [{ command: "log-list", handler }];
