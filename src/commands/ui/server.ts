// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The HTTP server behind `akm ui`: `node:http` so one implementation serves
 * Bun, Node and the compiled binary alike.
 *
 * Trust model: the server is for the person at this machine. It binds loopback
 * by default, every `/api/` request must carry the per-launch token, and the
 * `Host` header must be the address the server is bound to, which stops a web
 * page from reaching it through DNS rebinding. Static UI files are served
 * without the token and embed no data. Only GET (and HEAD) is accepted.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import appJs from "../../assets/ui/app.js" with { type: "text" };
import assetJs from "../../assets/ui/asset.js" with { type: "text" };
import bundlesJs from "../../assets/ui/bundles.js" with { type: "text" };
import changesJs from "../../assets/ui/changes.js" with { type: "text" };
import chartsJs from "../../assets/ui/charts.js" with { type: "text" };
import configJs from "../../assets/ui/config.js" with { type: "text" };
import indexHtml from "../../assets/ui/index.html" with { type: "text" };
import libJs from "../../assets/ui/lib.js" with { type: "text" };
import markdownJs from "../../assets/ui/markdown.js" with { type: "text" };
import overviewJs from "../../assets/ui/overview.js" with { type: "text" };
import proposalsJs from "../../assets/ui/proposals.js" with { type: "text" };
import searchJs from "../../assets/ui/search.js" with { type: "text" };
import stylesCss from "../../assets/ui/styles.css" with { type: "text" };
import { AkmError } from "../../core/errors";
import { getDirname } from "../../runtime";
import { handleApiRequest, NO_SUCH_ROUTE, type UiServerInfo } from "./api";
import { scrubUrlCredentials } from "./redact";

export const TOKEN_HEADER = "x-akm-ui-token";

const UI_DIR = path.join(getDirname(import.meta.url), "../../assets/ui");

/**
 * The UI files embedded at build time. Disk stays primary (an edit shows
 * without a rebuild, and files added beside these are served from disk), the
 * embedded copy covers the compiled standalone binary, where `assets/ui` is not
 * on any real filesystem. Same arrangement as the HTML report templates in
 * `src/output/html-render.ts`. A file the standalone binary must serve has to be
 * imported above and listed here.
 */
export const EMBEDDED_UI: Record<string, string> = {
  "index.html": indexHtml as unknown as string,
  "app.js": appJs as unknown as string,
  "asset.js": assetJs as unknown as string,
  "bundles.js": bundlesJs as unknown as string,
  "changes.js": changesJs as unknown as string,
  "charts.js": chartsJs as unknown as string,
  "config.js": configJs as unknown as string,
  "lib.js": libJs as unknown as string,
  "markdown.js": markdownJs as unknown as string,
  "overview.js": overviewJs as unknown as string,
  "proposals.js": proposalsJs as unknown as string,
  "search.js": searchJs as unknown as string,
  "styles.css": stylesCss as unknown as string,
};

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Same-origin only: the UI is plain files with no network access of its own
 * (nothing is fetched at runtime). Inline styles are allowed so a chart can set
 * a computed colour; inline scripts are not.
 */
const STATIC_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; " +
  "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
} as const;

export interface UiServerOptions {
  /** Address to bind. Default `127.0.0.1`. */
  host?: string;
  /** Port to bind; `0` (default) picks a free one. */
  port?: number;
  /** Session token; generated when omitted. */
  token?: string;
}

export interface UiServer extends UiServerInfo {
  token: string;
  /** `http://<host>:<port>/?token=<token>` */
  url: string;
  close(): Promise<void>;
}

/** Whether `host` binds every interface, so the `Host` header can be any address of this machine. */
function isWildcardHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "[::]";
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host);
}

/** `host` as it appears in a URL or a `Host` header (IPv6 literals in brackets). */
function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function isLoopbackBind(host: string): boolean {
  return isLoopbackHost(host);
}

function hostAllowed(header: string | undefined, host: string, port: number): boolean {
  if (!header) return false;
  const given = header.toLowerCase();
  if (given === `${urlHost(host).toLowerCase()}:${port}`) return true;
  if (!isWildcardHost(host)) return false;
  // A wildcard bind is reached by whatever address the machine has; DNS names stay refused (rebinding uses names).
  const match = /^(\[[0-9a-f:.]+\]|\d{1,3}(?:\.\d{1,3}){3}):(\d+)$/.exec(given);
  return match !== null && Number(match[2]) === port;
}

function tokenMatches(given: string | null | undefined, expected: string): boolean {
  if (!given) return false;
  // Hash both so the comparison is constant-time whatever the lengths.
  return timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(expected).digest());
}

function sendJson(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body, (_key, value) => (typeof value === "bigint" ? Number(value) : value));
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...extra,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(req.method === "HEAD" ? undefined : payload);
}

function sendError(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  status: number,
  code: string,
  error: string,
  extra: Record<string, string> = {},
): void {
  sendJson(req, res, status, { ok: false, error, code }, extra);
}

/** HTTP status for an error thrown by an API handler: the CLI's error classes, mapped. */
function statusFor(error: unknown): number {
  if (!(error instanceof AkmError)) return 500;
  switch (error.kind) {
    case "usage":
      return 400;
    case "not-found":
      return 404;
    case "transient":
      return 503;
    default:
      return 500;
  }
}

/** The file `urlPath` names under the UI directory, or the embedded copy; `null` when there is none. */
function readUiAsset(urlPath: string): { body: string | Buffer; type: string } | null {
  let relative: string;
  try {
    relative = decodeURIComponent(urlPath).replace(/^\/+/, "");
  } catch {
    return null;
  }
  if (relative === "") relative = "index.html";
  if (relative.includes("\0") || relative.includes("\\")) return null;
  const resolved = path.resolve(UI_DIR, relative);
  const inside = path.relative(UI_DIR, resolved);
  if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) return null;
  const type = CONTENT_TYPES[path.extname(resolved).toLowerCase()];
  if (!type) return null;
  try {
    if (fs.statSync(resolved).isFile()) return { body: fs.readFileSync(resolved), type };
  } catch {
    // Not on disk: fall back to the embedded copy below.
  }
  const embedded = EMBEDDED_UI[inside.split(path.sep).join("/")];
  return embedded === undefined ? null : { body: embedded, type };
}

export async function startUiServer(options: UiServerOptions = {}): Promise<UiServer> {
  const host = options.host ?? "127.0.0.1";
  const token = options.token ?? randomBytes(24).toString("base64url");
  const startedAt = new Date().toISOString();
  // Filled in once the socket is listening; requests cannot arrive before that.
  let info: UiServerInfo = { startedAt, host, port: 0 };

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendError(req, res, 500, "INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!hostAllowed(req.headers.host, host, info.port)) {
      sendError(req, res, 403, "HOST_NOT_ALLOWED", "The Host header does not match the address akm ui is bound to.");
      return;
    }
    const url = new URL(req.url ?? "/", "http://akm-ui.invalid");
    const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");

    // Only a GET of a static file is open; the API, and anything that is not a GET, needs the token.
    const readMethod = req.method === "GET" || req.method === "HEAD";
    if (isApi || !readMethod) {
      const given = req.headers[TOKEN_HEADER];
      const provided = (Array.isArray(given) ? given[0] : given) ?? url.searchParams.get("token");
      if (!tokenMatches(provided, token)) {
        sendError(req, res, 401, "UNAUTHORIZED", "Missing or invalid session token.", {
          "WWW-Authenticate": "X-Akm-Ui-Token",
        });
        return;
      }
    }
    if (!readMethod) {
      sendError(req, res, 405, "METHOD_NOT_ALLOWED", "akm ui is read-only: only GET is accepted.", {
        Allow: "GET, HEAD",
      });
      return;
    }

    if (isApi) {
      try {
        const data = await handleApiRequest(url.pathname, url.searchParams, info);
        if (data === NO_SUCH_ROUTE) {
          sendError(req, res, 404, "NOT_FOUND", `No such API route: ${url.pathname}`);
          return;
        }
        sendJson(req, res, 200, { ok: true, data: scrubUrlCredentials(data) });
      } catch (error) {
        const code = error instanceof AkmError ? error.code : "INTERNAL_ERROR";
        sendError(req, res, statusFor(error), code, error instanceof Error ? error.message : String(error));
      }
      return;
    }

    const asset = readUiAsset(url.pathname);
    if (!asset) {
      sendError(req, res, 404, "NOT_FOUND", `No such file: ${url.pathname}`);
      return;
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": asset.type,
      "Content-Length": Buffer.byteLength(asset.body),
      "Content-Security-Policy": STATIC_CSP,
    });
    res.end(req.method === "HEAD" ? undefined : asset.body);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  info = { startedAt, host, port };

  return {
    ...info,
    token,
    url: `http://${urlHost(host)}:${port}/?token=${token}`,
    close: () =>
      new Promise<void>((resolve) => {
        // Keep-alive sockets would hold close() open until they time out.
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
