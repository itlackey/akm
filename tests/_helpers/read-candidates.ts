// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AdapterReadCandidate, DirectoryAdapterBase } from "../../src/core/adapter/directory-adapter";
import type { Bundle } from "../../src/core/adapter/types";

/** A directory adapter's protected `readCandidates` hook, for the tests that pin its inversion. */
export function readCandidates(adapter: DirectoryAdapterBase, b: Bundle, conceptId: string): AdapterReadCandidate[] {
  return (adapter as unknown as { readCandidates(b: Bundle, id: string): AdapterReadCandidate[] }).readCandidates(
    b,
    conceptId,
  );
}
