// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Handle } from "@sveltejs/kit/hooks";
import { cookieName, failure, sameSecret } from "./lib/server/security.js";

// Read once and removed from the environment, so the CLI children AKM spawns do not inherit the session credential.
// Kept on globalThis because a dev server re-evaluates this module and the variable is gone by then.
const session = globalThis as { __akmDesktopSessionToken?: string };
session.__akmDesktopSessionToken ??= process.env.AKM_DESKTOP_SESSION_TOKEN;
delete process.env.AKM_DESKTOP_SESSION_TOKEN;
const token = session.__akmDesktopSessionToken;

export const handle: Handle = async ({ event, resolve }) => {
  const origin = process.env.AKM_DESKTOP_ORIGIN;
  if (!token || !origin)
    return failure(503, "SESSION_UNAVAILABLE", "Start AKM Desktop using its application launcher.");
  const COOKIE = cookieName(origin);
  if (event.url.origin !== origin || event.request.headers.get("host") !== new URL(origin).host) {
    return failure(403, "HOST_NOT_ALLOWED", "This application only accepts the address it was started with.");
  }
  const bootstrap = event.url.searchParams.get("desktop_session");
  if (event.request.method === "GET" && event.url.pathname === "/" && sameSecret(bootstrap, token)) {
    // Not a 303: a SameSite=Strict cookie is not sent on the redirect of a navigation that started on another site
    // (a link in a chat or an admin page), so the follow-up GET / would be 401. A refresh is a fresh navigation.
    return new Response('<!doctype html><meta http-equiv="refresh" content="0;url=/">', {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Set-Cookie": `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict${origin.startsWith("https:") ? "; Secure" : ""}`,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  }
  if (!sameSecret(event.cookies.get(COOKIE), token))
    return failure(401, "UNAUTHORIZED", "Missing or invalid application session.");
  if (!["GET", "HEAD"].includes(event.request.method) && event.request.headers.get("origin") !== origin) {
    return failure(403, "ORIGIN_NOT_ALLOWED", "Writes must originate in this application window.");
  }
  const response = await resolve(event);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Cache-Control", "no-store");
  return response;
};
