// One process of the metrics fold race test: wait for the start file, then fold and purge once.
import fs from "node:fs";
import { openStateDatabase } from "../../src/core/state-db";
import { foldBeforePurge } from "../../src/indexer/metrics/fold";
import { purgeFoldedEvents } from "../../src/storage/repositories/metrics-rollup-repository";

const [readyFile, goFile] = process.argv.slice(2) as [string, string];
const db = openStateDatabase();
fs.writeFileSync(readyFile, "");
while (!fs.existsSync(goFile)) Bun.sleepSync(1);
try {
  const folded = foldBeforePurge(db);
  if (folded) purgeFoldedEvents(db, 1, folded);
} finally {
  db.close();
}
