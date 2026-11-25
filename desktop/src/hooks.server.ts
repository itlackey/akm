// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Handle } from "@sveltejs/kit/hooks";
import { activity } from "akm-cli/workspace";
import { hostTools } from "./lib/server/features/software.js";
import { cookieName, failure, sameSecret } from "./lib/server/security.js";
import { endSession, startLink, startSession, useLink, useSession, type WebState } from "./lib/server/web-access.js";

// server.mjs hands over the resolved settings on globalThis. A dev server (scripts/dev.mjs) has no server.mjs: it passes
// the same two values in the environment. The secret is read once and removed, so the CLI children AKM spawns do not
// inherit it; globalThis keeps it because a dev server re-evaluates this module and the variable is gone by then.
const shared = globalThis as { __akmWeb?: WebState };
if (!shared.__akmWeb && process.env.AKM_WEB_SECRET && process.env.AKM_DESKTOP_ORIGIN)
  shared.__akmWeb = { secret: process.env.AKM_WEB_SECRET, origin: process.env.AKM_DESKTOP_ORIGIN, frameParents: [] };
delete process.env.AKM_WEB_SECRET;

// The daily usage report (docs/reference/data-and-telemetry.md): once at server start, in the background, never
// throws. akm decides whether it is due; `usage.report: false` in the config turns it off.
void activity.reportUsage();

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>:root{color-scheme:light dark}body{font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}form{display:grid;gap:12px;width:min(22rem,90vw)}input,button{font:inherit;padding:.5rem}p{margin:0}.error{color:#c00}</style>${body}</html>`;

function loginForm(up: string, error: boolean): string {
  return page(
    "AKM login",
    `<form method="post" action="${up}api/session"><h1>AKM</h1>${error ? '<p class="error" role="alert">That secret was not accepted.</p>' : ""}<label>Secret<br><input type="password" name="secret" autocomplete="current-password" autofocus required style="width:100%;box-sizing:border-box"></label><button type="submit">Log in</button></form>`,
  );
}

export const handle: Handle = async ({ event, resolve }) => {
  const web = shared.__akmWeb;
  if (!web) return failure(503, "SESSION_UNAVAILABLE", "Start AKM Desktop using its application launcher.");
  const { origin, secret, frameParents } = web;
  const https = origin.startsWith("https:");
  const COOKIE = cookieName(origin);
  const { method, headers } = event.request;
  const path = event.url.pathname;
  const framed = frameParents.length > 0;
  // The form posts to /api/session from wherever the page is, which behind a path prefix is not the site root.
  const up = "../".repeat(path.split("/").length - 2);

  // Every response: no caching, and framing allowed for exactly the configured parents or denied.
  const finish = (response: Response) => {
    response.headers.set("X-Content-Type-Options", "nosniff");
    if (!response.headers.has("Referrer-Policy")) response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("Cache-Control", "no-store");
    if (framed) {
      const directive = `frame-ancestors ${frameParents.join(" ")}`;
      const csp = response.headers.get("content-security-policy");
      response.headers.delete("X-Frame-Options");
      response.headers.set(
        "Content-Security-Policy",
        !csp
          ? directive
          : /frame-ancestors[^;]*/.test(csp)
            ? csp.replace(/frame-ancestors[^;]*/, directive)
            : `${csp}; ${directive}`,
      );
    } else response.headers.set("X-Frame-Options", "DENY");
    return response;
  };
  // A cookie in a frame on another site needs SameSite=None, which a browser accepts only as Secure and partitioned.
  const cookie = (value: string, extra = "") =>
    `${COOKIE}=${value}; Path=/; HttpOnly; ${framed && https ? "SameSite=None; Secure; Partitioned" : `SameSite=Strict${https ? "; Secure" : ""}`}${extra}`;
  // The login form is the one page that posts a form: under `no-referrer` a browser sends `Origin: null` with it.
  const html = (body: string, status: number, extra: Record<string, string> = {}) =>
    finish(
      new Response(body, {
        status,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy":
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
          "Referrer-Policy": "same-origin",
          ...extra,
        },
      }),
    );
  // Redirects are relative, so the UI works behind a proxy that serves it under a path prefix.
  const redirect = (to: string, extra: Record<string, string>) =>
    finish(new Response(null, { status: 303, headers: { Location: to, ...extra } }));
  const refuse = (...args: Parameters<typeof failure>) => finish(failure(...args));

  if (event.url.origin !== origin || headers.get("host") !== new URL(origin).host)
    return refuse(403, "HOST_NOT_ALLOWED", "This application only accepts the address it was started with.");

  // One-time login link: opening it starts a session. It is the same sequence a typed address always had: a navigation
  // that started on another site does not send a SameSite=Strict cookie on a redirect, so that one takes a refresh.
  if (method === "GET" && path === "/" && event.url.searchParams.has("login")) {
    if (useLink(event.url.searchParams.get("login"))) {
      const set = { "Set-Cookie": cookie(startSession()) };
      const site = headers.get("sec-fetch-site");
      if (site === "none" || site === "same-origin") return redirect("./", set);
      return html('<!doctype html><meta http-equiv="refresh" content="0;url=./">', 200, {
        ...set,
        "Referrer-Policy": "no-referrer",
      });
    }
  }

  const writeOriginOk = ["GET", "HEAD"].includes(method) || headers.get("origin") === origin;
  const originDenied = () => refuse(403, "ORIGIN_NOT_ALLOWED", "Writes must come from this application's own address.");

  // The login form posts the secret in the body.
  if (method === "POST" && path === "/api/session") {
    if (!writeOriginOk) return originDenied();
    if (!(headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded"))
      return refuse(415, "UNSUPPORTED_MEDIA_TYPE", "The login form is sent as application/x-www-form-urlencoded.");
    const body = await event.request.text();
    if (body.length > 4096) return refuse(413, "PAYLOAD_TOO_LARGE", "The login form is too large.");
    if (sameSecret(new URLSearchParams(body).get("secret"), secret))
      return redirect("../", { "Set-Cookie": cookie(startSession()) });
    return html(loginForm(up, true), 401);
  }

  const bearer = /^Bearer (.+)$/i.exec(headers.get("authorization") ?? "")?.[1];
  const byHeader = headers.has("authorization");
  const sessionId = event.cookies.get(COOKIE);
  if (byHeader ? !sameSecret(bearer, secret) : !useSession(sessionId)) {
    const navigation =
      ["GET", "HEAD"].includes(method) &&
      !path.startsWith("/api/") &&
      (headers.get("accept") ?? "").includes("text/html");
    if (navigation && !byHeader) return html(loginForm(up, false), 401);
    return refuse(401, "UNAUTHORIZED", "Missing or invalid application session.");
  }
  if (!writeOriginOk) return originDenied();

  if (path === "/api/session") {
    if (method === "GET") {
      const active = (web.inflight ?? 1) > 1 || (Boolean(hostTools.pending) && hostTools.state.phase !== "check");
      return finish(Response.json({ ok: true, active, session: !byHeader }));
    }
  }
  if (method === "POST" && path === "/api/session/link") {
    if (!byHeader) return refuse(403, "FORBIDDEN", "A login link is issued only to a request that carries the secret.");
    return finish(Response.json({ url: `${origin}/?login=${startLink()}` }));
  }
  if (method === "POST" && path === "/api/session/logout") {
    endSession(sessionId);
    return finish(Response.json({ ok: true }, { headers: { "Set-Cookie": cookie("", "; Max-Age=0") } }));
  }
  return finish(await resolve(event));
};
