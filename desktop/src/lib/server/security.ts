// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { timingSafeEqual } from "node:crypto";

export const COOKIE = "akm_desktop_session";
export function sameSecret(value: string | undefined | null, expected: string | undefined): boolean {
  if (!value || !expected || expected.length < 32) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function failure(status: number, code: string, message: string): Response {
  return Response.json({ ok: false, error: message, code }, { status });
}
