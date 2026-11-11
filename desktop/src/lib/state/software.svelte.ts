// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { api } from "../client";
import type { HostHarness, HostSnapshot } from "../setup-model";
import { snapshotFeed, waitUntilIdle } from "../software-model";

export type Harness = HostHarness & { path?: string };
/** Desktop's own update state, from the main process (electron-updater); absent in the web process. */
export interface UpdateState {
  state: string;
  version?: string;
  error?: string;
  /** Download progress, 0 to 100, while a release downloads. */
  percent?: number;
  /** What the error interrupted. */
  during?: "check" | "download";
  /** Why this run never checks. */
  reason?: "development" | "off" | "not-appimage";
  /** The release line followed: the saved choice, else the stage of the embedded version. */
  channel: "stable" | "prerelease";
}
interface UpgradeView {
  latestVersion?: string;
  currentVersion?: string;
  updateAvailable?: boolean;
  installMethod?: string;
  channel?: string;
  currentChannel?: string;
  /** Each harness plugin akm found: the channel it follows and what the run did with it. */
  plugins?: Array<{ harness: string; channel?: string; outcome?: string; reason?: string }>;
  lockstep?: { heldBack?: boolean; plugin?: string; pinnedVersion?: string; newestVersion?: string; reason?: string };
}
export interface SoftwareSnapshot {
  engine: string;
  /** The saved Desktop choices that Software offers; absent means the default derived from the engine's stage. */
  preferences?: { updateChannel?: "stable" | "prerelease"; pluginChannel?: "latest" | "next" };
  desktop: {
    version?: string;
    update?: UpdateState;
    menu?: {
      supported: boolean;
      installed: boolean;
      busy: boolean;
      runningInstalledCopy?: boolean;
      replacesExistingCopy?: boolean;
      appImage?: string;
      error?: string;
    };
  };
  host: HostSnapshot & {
    phase: string;
    cliDirectory: string;
    harnesses: Harness[];
    error?: string;
    errorDetail?: string;
    receipt?: string;
    checkedAt?: string;
    command?: string;
    upgrade?: UpgradeView;
    /** The last action's own command and result, apart from the check that followed it. */
    action?: { command: string; upgrade?: UpgradeView };
    /** akm is where Install AKM CLI puts it, so Desktop may repair it with consent. */
    cliManaged?: boolean;
    /** What is waiting for consent after its action stopped to ask: `cli` or a harness id. */
    consent?: string;
    /** An action that timed out: its outcome is unknown until a check confirms it. */
    unsettled?: string;
  };
}
export interface Outcome {
  error?: string;
  errorDetail?: string;
  receipt?: string;
}

/** Host software as the server reports it, shared by Settings → Software and first-run setup. */
export const software = $state({ data: null as SoftwareSnapshot | null, error: "", submitting: false });

const feed = snapshotFeed(() => api<SoftwareSnapshot>("/desktop/software"));
/** Fetch the snapshot; false when the server could not be reached. A transport error clears once a refresh succeeds. */
export async function refreshSoftware(): Promise<boolean> {
  const result = await feed();
  if (result.ok && !result.stale) {
    software.data = result.data;
    if (result.recovered) software.error = "";
  } else if (!result.ok && !result.stale) software.error = result.error;
  return result.ok;
}

/** Start a software action. Host actions run in the background; `refreshSoftware` shows their progress. */
export async function actSoftware(action: string, details: Record<string, unknown> = {}) {
  software.submitting = true;
  software.error = "";
  try {
    await api("/desktop/software", {}, { action, ...details });
    await refreshSoftware();
  } catch (cause) {
    software.error = (cause as Error).message;
  } finally {
    software.submitting = false;
  }
}

/**
 * Save one Desktop choice (the update or plugin channel) and show the state it leads to. The result says whether the
 * running app has it (`applied: false`: saved, but not reached the updater yet), or is undefined when it was not saved.
 */
export async function savePreference(key: "updateChannel" | "pluginChannel", value: string) {
  software.error = "";
  try {
    const saved = await api<{ applied?: boolean; applyError?: string }>("/desktop/preferences", {}, { [key]: value });
    await refreshSoftware();
    return saved;
  } catch (cause) {
    software.error = (cause as Error).message;
    return undefined;
  }
}

/** Run a host action and wait for it to finish; what it ended with is the server's receipt or error. */
export async function runSoftware(action: string, details: Record<string, unknown> = {}): Promise<Outcome> {
  await actSoftware(action, details);
  if (software.error) return { error: software.error };
  // Losing the status connection is not the operation's outcome: it was not cancelled and may still be running.
  const connected = await waitUntilIdle(
    refreshSoftware,
    () => Boolean(software.data && software.data.host.phase !== "idle"),
    () => new Promise((resolve) => setTimeout(resolve, 500)),
  );
  if (!connected)
    return {
      error: "Lost contact with the status connection. The operation was not cancelled and may still be running.",
    };
  const { error, errorDetail, receipt } = software.data?.host ?? {};
  return { error, errorDetail, receipt };
}

/** Keep the snapshot fresh while a view is open; checks the host once if nobody has. Returns the stop function. */
export function watchSoftware() {
  let alive = true;
  void (async () => {
    await refreshSoftware();
    if (alive && !software.data?.host.cli && software.data?.host.phase === "idle") await actSoftware("check");
  })();
  const timer = setInterval(() => alive && void refreshSoftware(), 2000);
  return () => {
    alive = false;
    clearInterval(timer);
  };
}
