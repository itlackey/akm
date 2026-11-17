// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** One plugin entry of an `akm upgrade` result: what akm did, or under `--check` would do, for one harness. */
export interface PluginEntry {
  harness: string;
  channel?: string;
  outcome?: string;
  from?: string;
  to?: string;
  reason?: string;
}

const LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  "opencode-v2": "OpenCode 2",
};

/** The channel akm says a plugin follows, as words that finish a sentence about it. */
export const channelWords = (channel: string | undefined): string | undefined =>
  channel === "latest"
    ? "on the stable channel"
    : channel === "next"
      ? "on the prerelease channel"
      : channel === "pinned"
        ? "pinned to one version"
        : undefined;

/** What akm reports for one plugin: the outcome in words, then akm's own message. Nothing is compared here. */
export function planText(item: PluginEntry): string {
  const what: Record<string, string> = {
    pending: `Update installs ${item.to ?? "a newer release"}`,
    updated: `Updated${item.to ? ` to ${item.to}` : ""}`,
    current: "Up to date",
    skipped: "Skipped",
    deferred: "Deferred. Close the harness, then update again",
    failed: "Failed",
    unknown: item.reason ? "Not checked" : "Not checked; Update refreshes it",
  };
  return `${what[item.outcome ?? ""] ?? item.outcome ?? "Not reported"}${item.reason ? ` (${item.reason})` : ""}.`;
}

export function upgradeOutcomeText(item: PluginEntry): string {
  const on = channelWords(item.channel);
  return `${LABELS[item.harness] ?? item.harness} plugin${on ? `, ${on}` : ""}: ${planText(item)}`;
}
