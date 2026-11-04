// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The read-only JSON routes behind `akm ui`: a table from path to the workspace operation it reads
 * (`src/workspace/*`, which owns the behaviour; documented in `docs/reference/ui-api.md`). Each entry only turns a
 * query string into that operation's input. Frozen with the rest of `akm ui`.
 */

import { parsePositiveIntFlag } from "../../cli/parse-args";
import { activity, assets, bundles, config, documents, host, proposals } from "../../workspace";

type Query = URLSearchParams;
type Handler = (query: Query) => unknown | Promise<unknown>;

function limit(query: Query): number | undefined {
  const raw = query.get("limit");
  return raw === null || raw === "" ? undefined : parsePositiveIntFlag(raw, "limit");
}

const flag = (query: Query, name: string): boolean => query.get(name) === "1" || query.get(name) === "true";
const text = (query: Query, name: string): string => query.get(name) ?? "";
const refInput = (query: Query) => ({ ref: text(query, "ref").trim() });

const ROUTES: Record<string, Handler> = {
  "/api/asset/improve": (query) => assets.improvement(refInput(query)),
  "/api/improve/impact": (query) => activity.improveImpact({ since: text(query, "since") }),
  "/api/overview/pulse": () => activity.pulse(),
  "/api/search/misses": (query) => assets.searchMisses({ since: text(query, "since") }),
  "/api/retrieval": (query) => activity.retrievalTrend({ since: text(query, "since") }),
  "/api/fs/folders": (query) => host.folders({ path: text(query, "path"), hidden: query.get("hidden") === "1" }),
  "/api/meta": () => activity.meta(),
  "/api/overview": (query) =>
    activity.overview({ probe: flag(query, "probe"), metricsSince: text(query, "metricsSince") }),
  "/api/health": (query) => activity.health({ probe: flag(query, "probe") }),
  "/api/tasks/history": (query) =>
    activity.taskHistory({ taskId: text(query, "taskId"), since: text(query, "since"), limit: limit(query) }),
  "/api/bundles": () => bundles.list(),
  "/api/bundle/files": (query) =>
    assets.bundleFiles({
      bundle: text(query, "bundle"),
      path: text(query, "path"),
      hidden: query.get("hidden") === "1",
    }),
  "/api/config": () => config.get(),
  "/api/proposals": (query) => {
    return proposals.list({
      status: text(query, "status"),
      source: text(query, "source"),
      age: text(query, "age"),
      week: text(query, "week"),
      class: text(query, "class"),
      limit: limit(query),
    });
  },
  "/api/changes": (query) => proposals.recentChanges({ limit: limit(query) }),
  "/api/search": (query) =>
    assets.search({
      q: text(query, "q"),
      type: query.get("type") || undefined,
      bundle: query.get("bundle") || undefined,
      belief: query.get("belief") || undefined,
      scope: Object.fromEntries(["user", "agent", "run", "channel"].map((key) => [key, text(query, `scope_${key}`)])),
      limit: limit(query),
    }),
  "/api/asset": (query) => assets.show(refInput(query)),
  "/api/asset/history": (query) =>
    assets.history({ ...refInput(query), revision: query.get("revision") ?? undefined, limit: limit(query) }),
  "/api/asset/related": (query) =>
    assets.related({ ...refInput(query), scope: (query.get("scope") ?? "all") as "all" | "bundle" }),
  "/api/asset/source": (query) => documents.readSource({ ref: text(query, "ref") }),
};

const PROPOSAL_ROUTE = /^\/api\/proposals\/([^/]+)$/;

/** What {@link handleApiRequest} returns for a path that is not an API route. */
export const NO_SUCH_ROUTE = Symbol("no-such-route");

/** Dispatch one `/api/...` request; handler errors propagate, an unknown route is {@link NO_SUCH_ROUTE}. */
export async function handleApiRequest(pathname: string, query: Query): Promise<unknown> {
  const route = ROUTES[pathname];
  if (route) return route(query);
  const proposalMatch = PROPOSAL_ROUTE.exec(pathname);
  if (proposalMatch) return proposals.get({ id: decodeURIComponent(proposalMatch[1] as string) });
  return NO_SUCH_ROUTE;
}
