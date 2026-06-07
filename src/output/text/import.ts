// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { formatImportPlain } from "./helpers";
import type { TextFormatterEntry } from "./registry";

export const importFormatters: TextFormatterEntry[] = [{ command: "import", handler: (r) => formatImportPlain(r) }];
