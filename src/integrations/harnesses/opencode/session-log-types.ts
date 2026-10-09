// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { InlineRefMention, SessionEvent } from "../../session-logs/types";

/** Per-session metadata a store adapter hands back to the provider (no harness stamp yet). */
export interface OpenCodeSessionMeta {
  sessionId: string;
  startedAt?: number;
  endedAt?: number;
  projectHint?: string;
  title?: string;
}

export interface OpenCodeSessionRead {
  meta: OpenCodeSessionMeta;
  events: SessionEvent[];
  inlineRefs: InlineRefMention[];
}
