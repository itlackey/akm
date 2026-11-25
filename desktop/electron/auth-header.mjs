// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Whether a request goes to the AKM server itself: its URL's origin is exactly the server origin. Anything else
 * (another origin, a redirect that left the origin, a URL that does not parse) never gets the secret.
 * @param {string} url
 * @param {string} origin
 */
export function isServerRequest(url, origin) {
  try {
    return new URL(origin).origin === origin && new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Add `Authorization: Bearer <secret>` to the requests a session makes to the server's origin, and to no others.
 * Electron's interception is per session: call this only for the AKM window's own session. Returns a function that
 * removes the handler.
 * @param {Pick<import("electron").Session, "webRequest">} session
 * @param {string} origin
 * @param {string} secret
 */
export function addServerAuthorization(session, origin, secret) {
  session.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, callback) => {
    const requestHeaders = { ...details.requestHeaders };
    if (isServerRequest(details.url, origin)) requestHeaders.Authorization = `Bearer ${secret}`;
    callback({ requestHeaders });
  });
  return () => session.webRequest.onBeforeSendHeaders(null);
}
