// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type ProjectView, withProjectLine } from "../../core/projects";
import { formatSearchPlain } from "./helpers";
import type { TextFormatterEntry } from "./registry";

export const searchFormatters: TextFormatterEntry[] = [
  {
    command: "search",
    handler: (r, detail) => withProjectLine(formatSearchPlain(r, detail), r.project as ProjectView | undefined),
  },
];
