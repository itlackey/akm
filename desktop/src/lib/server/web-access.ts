// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { randomBytes } from "node:crypto";

/**
 * What the server hands the request hook: the settings it resolved at startup. `secret` is the only credential.
 * `inflight` is the server's count of requests being served, which `GET /api/session` reports as `active`.
 */
export interface WebState {
  secret: string;
  origin: string;
  frameParents: string[];
  inflight?: number;
}

/** Idle sessions end after this long. */
const sessionIdleMs = 8 * 60 * 60 * 1000;
/** A one-time login link works for this long. */
const linkTtlMs = 60_000;
const maxSessions = 256;
const maxLinks = 64;

const id = () => randomBytes(32).toString("base64url");

// In memory only: a restart ends every session and link. Kept on globalThis because a dev server re-evaluates this module.
const store = globalThis as { __akmWebAccess?: { sessions: Map<string, number>; links: Map<string, number> } };
store.__akmWebAccess ??= { sessions: new Map(), links: new Map() };
const { sessions, links } = store.__akmWebAccess;

/** Drop what has expired, then the oldest if the table is still full. Maps keep insertion order, so the first is oldest. */
function trim(table: Map<string, number>, limit: number, now: number, ttl: number) {
  for (const [key, used] of table) if (now - used > ttl) table.delete(key);
  while (table.size >= limit) table.delete(table.keys().next().value as string);
}

// The functions take the time (`now`) so a test can pass one instead of waiting.
export function startSession(now = Date.now()): string {
  const key = id();
  trim(sessions, maxSessions, now, sessionIdleMs);
  sessions.set(key, now);
  return key;
}

/** True while the session exists and has been used within the idle period; using it renews it. */
export function useSession(key: string | undefined, now = Date.now()): boolean {
  const used = key ? sessions.get(key) : undefined;
  if (key === undefined || used === undefined) return false;
  sessions.delete(key);
  if (now - used > sessionIdleMs) return false;
  sessions.set(key, now);
  return true;
}

export function endSession(key: string | undefined) {
  if (key) sessions.delete(key);
}

export function startLink(now = Date.now()): string {
  const code = id();
  trim(links, maxLinks, now, linkTtlMs);
  links.set(code, now);
  return code;
}

/** A link works once: finding it removes it. */
export function useLink(code: string | null, now = Date.now()): boolean {
  const made = code ? links.get(code) : undefined;
  if (code === null || made === undefined) return false;
  links.delete(code);
  return now - made <= linkTtlMs;
}
