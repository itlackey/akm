// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** `GET /api/asset/improve?ref=`: what improve proposed for one asset, how it was decided, and how the asset has been used since. */

import { UsageError } from "../../core/errors";
import { listStateProposals } from "../../storage/repositories/proposals-repository";
import { metricsWindow, readUsageRows } from "../metrics/metrics-cli";
import { classifyOutcome, decidedAt, weekOf, weekRange } from "./derive";
import { tryStashDir, withReadonlyStateDb } from "./readers";

const DAY = 86_400_000;

export function assetImprove(query: URLSearchParams) {
  const ref = query.get("ref")?.trim();
  if (!ref) throw new UsageError("Give the asset's ref: ?ref=<bundle>//<type>/<name>.", "MISSING_REQUIRED_ARGUMENT");
  const stashDir = tryStashDir();
  const window = metricsWindow("90d");
  const { proposals, mine } = withReadonlyStateDb(
    (db) => ({
      proposals: stashDir ? listStateProposals(db, { stashDir, ref, withContent: false }) : [],
      mine: readUsageRows(db, window).filter((row) => row.ref === ref),
    }),
    { proposals: [], mine: [] },
  );
  const now = Date.now();
  const weeks = weekRange(
    new Date(now - 90 * DAY).toISOString().slice(0, 10),
    new Date(now).toISOString().slice(0, 10),
  );
  const usageByWeek = weeks.map((week) => {
    const inWeek = mine.filter((row) => weekOf(row.at) === week);
    return {
      week,
      hits: inWeek.filter((row) => row.eventType === "search" || row.eventType === "show").length,
      positive: inWeek.filter((row) => row.signal === "positive").length,
      negative: inWeek.filter((row) => row.signal === "negative").length,
    };
  });
  return {
    proposals: proposals
      .map((p) => ({
        id: p.id,
        source: p.source,
        status: p.status,
        outcome: classifyOutcome(p),
        createdAt: p.createdAt,
        decidedAt: p.status === "pending" ? null : decidedAt(p),
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    usageByWeek,
  };
}
