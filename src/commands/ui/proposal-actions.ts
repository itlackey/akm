// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The proposal decisions `akm ui` makes: a table from path to the workspace operation (`src/workspace/proposals.ts`)
 * that accepts, rejects, reverts or reopens one proposal, or decides several. Each only turns a JSON body into that
 * operation's input. Frozen with the rest of `akm ui`.
 */

import { UsageError } from "../../core/errors";
import { proposals } from "../../workspace";

export type WriteRoute =
  | { kind: "accept"; id: string }
  | { kind: "reject"; id: string }
  | { kind: "revert"; id: string }
  | { kind: "reopen"; id: string }
  | { kind: "accept-many" }
  | { kind: "reject-many" };

/** The POST paths the UI may write proposals through; `null` for anything else. */
export function matchWriteRoute(pathname: string): WriteRoute | null {
  if (pathname === "/api/proposals/accept") return { kind: "accept-many" };
  if (pathname === "/api/proposals/reject") return { kind: "reject-many" };
  const match = /^\/api\/proposals\/([^/]+)\/(accept|reject|revert|reopen)$/.exec(pathname);
  if (!match) return null;
  let id: string;
  try {
    id = decodeURIComponent(match[1] as string);
  } catch {
    return null;
  }
  return { kind: match[2] as "accept" | "reject" | "revert" | "reopen", id };
}

/** The body as an object; an empty body is no fields. */
function bodyFields(body: unknown): { reason?: string; ids?: string[] } {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new UsageError("The request body must be a JSON object.", "INVALID_JSON_ARGUMENT");
  }
  return body as { reason?: string; ids?: string[] };
}

export async function handleWriteRequest(route: WriteRoute, body: unknown): Promise<unknown> {
  const { reason, ids } = bodyFields(body);
  switch (route.kind) {
    case "accept":
      return proposals.accept({ id: route.id });
    case "reject":
      return proposals.reject({ id: route.id, reason: reason as string });
    case "revert":
      return proposals.revert({ id: route.id });
    case "reopen":
      return proposals.reopen({ id: route.id });
    case "accept-many":
      return proposals.acceptMany({ ids: ids as string[] });
    case "reject-many":
      return proposals.rejectMany({ ids: ids as string[], reason: reason as string });
  }
}
