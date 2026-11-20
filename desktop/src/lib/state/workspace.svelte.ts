// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { api, apiState } from "../client";
import { renameBundle } from "../drafts";
import { isUnconfigured, type Starter } from "../setup-model";
import type { Bundle } from "../types";

/** Workspace-wide state the shell and the sections share. Per-view state stays in the page. */
export const workspace = $state({
  bundles: [] as Bundle[],
  defaultBundle: "",
  /** The starter bundle as akm reports it; null until the bundle list has been read. */
  starter: null as Starter | null,
  bundlesReady: false,
  /** Nothing is configured: no bundle and no working library, so first-run setup is what comes next. */
  unconfigured: false,
  /** Bumped when the bundle list changes, so a view showing derived results knows to look again. */
  bundleRevision: 0,
  /** Pending proposals; null when the queue could not be read (not the same as zero). */
  pendingCount: null as number | null,
  theme: "system",
  /** The app runs in the Electron shell, which can show a file in the system file manager. */
  native: false,
  /**
   * A form with unsaved changes that is not a Library draft (Projects, Connections): while `dirty`, leaving by
   * navigation, Back/Forward or closing the window asks first. `what` is the sentence the dialog shows.
   */
  guard: { dirty: false, what: "" },
  /** Projects renamed in this session, old name to new, so Back to an old page finds the project. */
  renamedProjects: {} as Record<string, string>,
  /** Where each section was last left, so the primary navigation returns to it. */
  sectionHref: {
    Home: "/",
    Library: "/library/search",
    Projects: "/projects",
    Review: "/review",
    Activity: "/activity/overview",
    Settings: "/settings/bundles",
  } as Record<string, string>,
});

export async function refreshPending() {
  try {
    workspace.pendingCount = (
      await apiState<{ fullCount: number }>("/proposals", { status: "pending", limit: "1" })
    ).fullCount;
  } catch {
    workspace.pendingCount = null;
  }
}

export async function refreshBundles(onlyIfChanged = false) {
  const data = await api<{
    bundles: Bundle[];
    writeTarget: { name: string | null; blocker: string | null };
    starter: Starter;
  }>("/bundles");
  // Where akm sends new content when no bundle is named: its own answer, empty when none resolves.
  const target = data.writeTarget.name ?? "";
  const changed =
    JSON.stringify(workspace.bundles) !== JSON.stringify(data.bundles) || workspace.defaultBundle !== target;
  workspace.bundles = data.bundles;
  workspace.bundlesReady = true;
  workspace.unconfigured = isUnconfigured(data);
  workspace.defaultBundle = target;
  workspace.starter = data.starter;
  if (!onlyIfChanged || changed) workspace.bundleRevision++;
}

/** Pending count and bundle list together, for views that show both (Home). */
export async function refreshContext() {
  await Promise.all([
    refreshPending(),
    refreshBundles(true).catch(() => {
      workspace.bundlesReady = false;
    }),
  ]);
}

export function applyTheme() {
  const root = document.documentElement;
  if (workspace.theme === "system") delete root.dataset.theme;
  else root.dataset.theme = workspace.theme;
  try {
    localStorage.setItem("akm-ui-theme", workspace.theme);
  } catch {
    /* the window preference still works */
  }
}

/** A renamed bundle keeps its drafts, and Library returns to a location that exists. */
export function bundleRenamed(oldName: string, name: string) {
  renameBundle(oldName, name);
  workspace.sectionHref.Library = `/library/files?${new URLSearchParams({ bundle: name })}`;
}
