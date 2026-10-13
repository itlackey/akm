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

/** The session columns both majors' tables share (`session` in OpenCode 1, `session_v2` in OpenCode 2). */
export type SessionRow = {
  id: string;
  title: string | null;
  directory: string | null;
  time_created: number | null;
  time_updated: number | null;
};

export function toMeta(r: Partial<SessionRow>, sessionId: string): OpenCodeSessionMeta {
  return {
    sessionId,
    startedAt: typeof r.time_created === "number" ? r.time_created : undefined,
    endedAt: typeof r.time_updated === "number" ? r.time_updated : undefined,
    projectHint: typeof r.directory === "string" && r.directory.length > 0 ? r.directory : undefined,
    title: typeof r.title === "string" && r.title.length > 0 ? r.title : undefined,
  };
}

export interface OpenCodeSessionRead {
  meta: OpenCodeSessionMeta;
  events: SessionEvent[];
  inlineRefs: InlineRefMention[];
}
