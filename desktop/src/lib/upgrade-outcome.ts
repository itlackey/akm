// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The line `akm upgrade` prints for one plugin (src/output/text/command-format.ts), minus the version move. */
const LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  "opencode-v2": "OpenCode 2",
};

export function upgradeOutcomeText(item: {
  harness: string;
  channel?: string;
  channelMismatch?: boolean;
  outcome?: string;
  reason?: string;
}): string {
  const outcome = item.outcome === "current" && item.channel ? "current within its configured channel" : item.outcome;
  const channel = item.channel ? ` [channel ${item.channel}${item.channelMismatch ? "; differs from CLI" : ""}]` : "";
  const reason = item.reason ? ` (${item.reason})` : "";
  const deferred = item.outcome === "deferred" ? ". Close the harness, then update again." : "";
  return `${LABELS[item.harness] ?? item.harness} plugin ${outcome}${channel}${reason}${deferred}`;
}
