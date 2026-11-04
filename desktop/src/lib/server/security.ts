import { timingSafeEqual } from 'node:crypto';

export const COOKIE = 'akm_desktop_session';
export function sameSecret(value: string | undefined | null, expected: string | undefined): boolean {
  if (!value || !expected || expected.length < 32) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function failure(status: number, code: string, message: string): Response {
  return Response.json({ ok: false, error: message, code }, { status });
}
