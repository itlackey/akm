// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { timingSafeEqual } from "node:crypto";

/**
 * Browsers share cookies across ports of one host, so several instances on a host each need their own name.
 * The origin's port tells them apart.
 */
export function cookieName(origin: string): string {
  const url = new URL(origin);
  return `akm_desktop_session_${url.port || (url.protocol === "https:" ? "443" : "80")}`;
}
export function sameSecret(value: string | undefined | null, expected: string | undefined): boolean {
  if (!value || !expected || expected.length < 32) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function failure(status: number, code: string, message: string): Response {
  return Response.json({ ok: false, error: message, code }, { status });
}
