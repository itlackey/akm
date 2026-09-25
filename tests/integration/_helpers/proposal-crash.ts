// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const RUNNER = path.join(import.meta.dir, "proposal-crash-runner.ts");

/**
 * Spawn `proposal-crash-runner.ts` against `proposalId`, wait until its
 * journal is durably written at `phase`, then SIGKILL it — simulating a
 * crash at that exact recovery phase. `markersDir` and `children` are the
 * caller's `beforeEach`-scoped marker directory and child-process registry
 * (reaped in `afterEach`); the marker filename is namespaced by
 * `operation`/`phase`/`proposalId` so crashing several proposals at the same
 * phase in one test never collides.
 */
export async function crashProposalAt(
  markersDir: string,
  children: ChildProcess[],
  phase: string,
  proposalId: string,
  operation = "accept",
  target?: string,
): Promise<void> {
  const marker = path.join(markersDir, `${operation}-${phase}-${proposalId}.ready`);
  const child = spawn("bun", [RUNNER, phase, marker, proposalId, operation, ...(target ? [target] : [])], {
    env: { ...process.env },
    stdio: "ignore",
  });
  children.push(child);
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(marker)) {
    if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) {
      throw new Error(`proposal crash runner did not reach ${phase}`);
    }
    await Bun.sleep(10);
  }
  const markerContent = fs.readFileSync(marker, "utf8");
  if (markerContent === "unsupported") {
    throw new Error(`proposal crash runner does not support ${phase}`);
  }
  if (markerContent.startsWith("error:")) throw new Error(markerContent);
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}
