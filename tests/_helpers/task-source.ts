// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import {
  type ParsedTaskSource,
  type ParseTaskSourceInput,
  parseTaskSource,
} from "../../src/tasks/source/parse-task-source";

/** `parseTaskSource` for a file a test wrote as version 4: the result is the version 4 arm, or the test fails. */
export function parseV4TaskSource(input: ParseTaskSourceInput): Extract<ParsedTaskSource, { version: 4 }> {
  const parsed = parseTaskSource(input);
  if (parsed.version !== 4) throw new Error(`expected a version 4 task source, got ${parsed.version}`);
  return parsed;
}
