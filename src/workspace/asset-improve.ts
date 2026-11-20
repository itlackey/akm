// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** What improve proposed for one asset, how it was decided, and how the asset has been used since. */

import { metricsWindow, readUsageRows } from "../commands/metrics/metrics";
import { resolveStashDir } from "../core/common";
import { UsageError } from "../core/errors";
import { listStateProposals } from "../storage/repositories/proposals-repository";
import { classifyOutcome, decidedAt, weekOf, weekRange } from "./derive";
import { stateDbUnavailable, withReadonlyStateDb } from "./readers";

const DAY = 86_400_000;

export function assetImprove(input: { ref: string }) {
  const ref = input.ref?.trim();
  if (!ref) throw new UsageError("Give the asset's ref: <bundle>//<type>/<name>.", "MISSING_REQUIRED_ARGUMENT");
  const window = metricsWindow("90d");
  const state = withReadonlyStateDb(
    (db) => ({
      proposals: listStateProposals(db, { stashDir: resolveStashDir(), ref, withContent: false }),
      mine: readUsageRows(db, window).filter((row) => row.ref === ref),
    }),
    null,
  );
  if (!state) return stateDbUnavailable();
  const { proposals, mine } = state;
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
    available: true as const,
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
