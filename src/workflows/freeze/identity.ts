// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { spawnSync } from "node:child_process";
import { UsageError } from "../../core/errors";
import type { TaskV3ScriptInterpreter } from "../../tasks/prepare/prepared-execution";
import type { BaseUnit } from "./step-values";

export function scriptExecutable(interpreter: TaskV3ScriptInterpreter): string {
  if (interpreter === "bun" || interpreter === "bun-standalone") return process.execPath;
  if (interpreter === "kotlin") return "kotlin";
  return interpreter;
}

export function gitIdentity(unit: BaseUnit, root: string): { gitCommitOid?: string } {
  if (unit.isolation !== "worktree") return {};
  const result = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
  const oid = result.status === 0 ? result.stdout.trim() : "";
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) {
    throw new UsageError(
      `Worktree-isolated workflow root ${root} has no immutable Git HEAD OID.`,
      "WORKFLOW_SOURCE_INVALID",
    );
  }
  return { gitCommitOid: oid };
}
