// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What runs where, in words, once setup has chosen: model calls, agent work and
 * embeddings. The words are read off the table `akm info` and `akm health`
 * print (`../commands/targets.ts`), so the summary says what those say and what
 * a call does.
 */
import { type ProcessRow, type TargetRow, targetRows } from "../commands/targets";
import type { AkmConfig } from "../core/config/config";
import { getHarness } from "../integrations/harnesses";

export interface SetupRuns {
  modelCalls: string;
  agentWork: string;
  embeddings: string;
}

/** Whether akm can run this platform read-only for model calls, which keeps them from changing anything. */
export function runsReadOnly(platform: string): boolean {
  return getHarness(platform)?.confinable === true;
}

function modelSuffix(row: ProcessRow): string {
  return row.model ? ` (${row.model})` : "";
}

/** Model calls or agent work: where the row says it runs, or what is wrong with the config that stops it. */
function describeWork(row: ProcessRow, rows: readonly TargetRow[], modelWork: boolean): string {
  if (row.problem) return row.problem;
  if (row.kind === "connection") {
    return `${modelWork ? "connection" : "akm's own runtime over connection"} "${row.target}"${modelSuffix(row)}`;
  }
  if (row.kind === "harness") {
    const platform = rows.find((r) => r.type === "harness" && r.name === row.target);
    const restriction =
      modelWork && platform?.type === "harness"
        ? runsReadOnly(platform.platform)
          ? ", read-only"
          : ", cannot be restricted to read-only"
        : "";
    return `harness "${row.target}"${modelSuffix(row)}${restriction}`;
  }
  return "off: no connection or harness is configured";
}

function describeEmbeddings(row: ProcessRow): string {
  if (row.kind === "local") return `akm's built-in local embedder${modelSuffix(row)}`;
  if (row.kind === "connection") return `${row.model ?? "a model"} on connection "${row.target}"`;
  if (row.kind === "endpoint") return `${row.model ?? "a model"} at ${row.target}`;
  return "off";
}

export function describeRuns(config: AkmConfig): SetupRuns {
  const rows = targetRows({ config });
  const work = (name: ProcessRow["process"]) =>
    rows.find((r): r is ProcessRow => r.type === "process" && r.process === name) as ProcessRow;
  return {
    modelCalls: describeWork(work("improve"), rows, true),
    agentWork: describeWork(work("agents"), rows, false),
    embeddings: describeEmbeddings(work("embedding")),
  };
}
