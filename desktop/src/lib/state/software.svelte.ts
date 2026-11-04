// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { api } from "../client";
import type { HostHarness, HostSnapshot } from "../setup-model";

export type Harness = HostHarness & { path?: string; major?: number };
export interface SoftwareSnapshot {
  engine: string;
  desktop: {
    version?: string;
    update?: { state: string; version?: string; error?: string };
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
    upgrade?: {
      latestVersion?: string;
      currentVersion?: string;
      updateAvailable?: boolean;
      installMethod?: string;
      channel?: string;
    };
  };
}
export interface Outcome {
  error?: string;
  errorDetail?: string;
  receipt?: string;
}

/** Host software as the server reports it, shared by Settings → Software and first-run setup. */
export const software = $state({ data: null as SoftwareSnapshot | null, error: "", submitting: false });

export async function refreshSoftware() {
  try {
    software.data = await api<SoftwareSnapshot>("/desktop/software");
  } catch (cause) {
    software.error = (cause as Error).message;
  }
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

/** Run a host action and wait for it to finish; what it ended with is the server's receipt or error. */
export async function runSoftware(action: string, details: Record<string, unknown> = {}): Promise<Outcome> {
  await actSoftware(action, details);
  if (software.error) return { error: software.error };
  while (software.data && software.data.host.phase !== "idle") {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await refreshSoftware();
  }
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
