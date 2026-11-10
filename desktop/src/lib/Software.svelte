<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { onMount, tick } from "svelte";
  import { classifyEngineSkew, hostUpgradeOutrunsDesktop } from "./engine-skew";
  import Icon from "./Icon.svelte";
  import { harnessLabel, installedChannel, pluginChannel, pluginLine } from "./setup-model";
  import { actSoftware as act, runSoftware, savePreference, software, watchSoftware } from "./state/software.svelte";
  const releases = "https://github.com/itlackey/akm/releases";
  const data = $derived(software.data),
    error = $derived(software.error),
    submitting = $derived(software.submitting);
  // The channel new plugins install from: the saved choice, else Desktop's own release stage (the same rule as setup).
  const channel = $derived(pluginChannel(data?.engine, data?.preferences?.pluginChannel));
  const hostBusy = $derived(submitting || Boolean(data && data.host.phase !== "idle"));
  const updateBusy = $derived(submitting || Boolean(data?.desktop.menu?.busy));
  const skew = $derived(classifyEngineSkew(data?.engine, data?.host.cli?.version));
  const desktopBehind = $derived(hostUpgradeOutrunsDesktop(data?.engine, data?.host.upgrade?.latestVersion));
  // Desktop's own update state, from the main process (electron-updater).
  const update = $derived(data?.desktop.update);
  const embeddedPrerelease = $derived(/^\d+\.\d+\.\d+-/.test(data?.desktop.version ?? ""));
  // The line followed: what the updater reports, else the saved choice, else the embedded version's own stage.
  const updateChannel = $derived(
    update?.channel ?? data?.preferences?.updateChannel ?? (embeddedPrerelease ? "prerelease" : "stable"),
  );
  // The note that belongs to the "Desktop updates" choice; it is that control's description.
  const updatesHint = $derived(
    updateChannel === "stable" && embeddedPrerelease
      ? "This build is a prerelease. Stable releases are offered from the next stable release on; it is never replaced by an older one."
      : !update
        ? "The release line applies when the AKM Desktop app checks for updates."
        : "",
  );
  // What the host is doing, in words, for the status line a screen reader hears.
  const phases: Record<string, string> = {
    check: "Checking the CLI and plugins…",
    "install-cli": "Installing the AKM CLI…",
    "upgrade-cli": "Updating the CLI and plugins…",
    "install-plugin": "Installing the AKM plugin…",
  };
  // A saved choice is said in a live region beside its control; a failed save is the page's alert.
  let saved = $state({ updateChannel: "", pluginChannel: "" });
  async function choose(key: "updateChannel" | "pluginChannel", value: string) {
    saved[key] = "";
    await savePreference(key, value);
    if (software.error) return;
    saved[key] =
      key === "updateChannel"
        ? `Saved. AKM Desktop follows ${value === "prerelease" ? "stable and prerelease releases" : "stable releases only"}.`
        : `Saved. New plugins install from the ${value === "next" ? "prerelease" : "stable"} channel.`;
  }
  /**
   * Run a host action from its button and wait for it. The button stays focusable while busy; if it is gone when the
   * action ends (an installed plugin has no install button), focus goes to `fallback`, never to the page.
   */
  async function run(action: string, details: Record<string, unknown>, fallback: string) {
    if (hostBusy) return;
    await runSoftware(action, details);
    await tick();
    if (document.activeElement === document.body) document.getElementById(fallback)?.focus();
  }
  onMount(watchSoftware);
</script>

<div class="software">
  <div class="intro">
    <h2>Software</h2>
    <p class="muted">
      Desktop, host CLI and integrations on this computer. <a href="/setup">Run setup again</a>
    </p>
  </div>
  {#if error}<p class="notice notice-warn" role="alert">{error}</p>{/if}
  {#if !data}<p role="status">Loading software status…</p>{:else}
    <section aria-labelledby="desktop-software">
      <div class="software-row">
        <div>
          <h3 id="desktop-software">AKM Desktop <span class="muted mono">{data.desktop.version ?? ""}</span></h3>
          <!-- One live region whose text changes, so each update state is heard and not only repainted. -->
          <p role="status" id="desktop-update-status">
            {#if update?.state === "checking"}Checking for updates…
            {:else if update?.state === "current"}AKM Desktop is up to date.
            {:else if update?.state === "downloading"}Downloading version {update.version}. It installs when you quit
              AKM Desktop.
            {:else if update?.state === "downloaded"}Version {update.version} is ready. It installs when you quit AKM Desktop.
            {:else if update?.state === "available"}Version {update.version} is available.
              <a href="{releases}/tag/v{update.version}"
                >Download version {update.version} from its GitHub release page</a
              >.
            {:else if update?.state === "error"}{update.during === "download"
                ? `Could not download version ${update.version ?? ""}. The next check is in six hours.`
                : "Could not check for updates."}
              <a href={releases}>Download a newer version from the GitHub releases page</a> if you need one.
            {:else if update?.state === "unsupported"}{update.reason === "off"
                ? "Update checks are turned off (AKM_DESKTOP_UPDATES=off)."
                : update.reason === "not-appimage"
                  ? "This Linux build is not an AppImage, so it does not check for updates."
                  : "A development run does not check for updates."} To update, download a newer AKM Desktop.
            {:else}To update, download a newer AKM Desktop.{/if}
          </p>
          {#if update?.state === "error" && update.error}<details class="field-hint">
              <summary>Details</summary>
              <pre class="mono">{update.error}</pre>
            </details>{/if}
          <p class="field-hint">Built-in AKM engine {data.engine}.</p>
        </div>
        {#if data.preferences}
          <label class="field"
            >Desktop updates<select
              value={updateChannel}
              aria-describedby={updatesHint ? "desktop-updates-hint" : undefined}
              onchange={(event) => choose("updateChannel", event.currentTarget.value)}
              ><option value="stable">Stable releases</option><option value="prerelease"
                >Stable and prerelease releases</option
              ></select
            ></label
          >
        {/if}
      </div>
      {#if updatesHint}<p id="desktop-updates-hint" class="field-hint">{updatesHint}</p>{/if}
      <p class="field-hint saved" role="status">{saved.updateChannel}</p>
      {#if data.desktop.menu?.supported}
        <div class="menu-install">
          <div class="software-row">
            <div>
              <h4>Application menu</h4>
              <p role="status">
                {data.desktop.menu.busy
                  ? "Installing menu entry…"
                  : data.desktop.menu.installed
                    ? "Added to your application menu"
                    : "Open AKM Desktop without finding the download."}
              </p>
            </div>
            <button
              class="btn-secondary"
              aria-disabled={updateBusy}
              onclick={() => !updateBusy && act("desktop-menu-install")}
            >
              {data.desktop.menu.installed
                ? data.desktop.menu.runningInstalledCopy
                  ? "Repair menu entry"
                  : "Replace menu copy…"
                : "Add to application menu"}
            </button>
          </div>
          {#if data.desktop.menu.installed && !data.desktop.menu.runningInstalledCopy}<p class="field-hint">
              Close this download and open AKM Desktop from your application menu. Replace that copy to update.
            </p>
          {:else if !data.desktop.menu.installed}<p class="field-hint">
              Installs a copy for your account only. No administrator password needed; the download stays where it is.
            </p>{/if}
          {#if data.desktop.menu.error}<p class="notice notice-warn" role="alert">{data.desktop.menu.error}</p>{/if}
        </div>
      {/if}
    </section>
    <section aria-labelledby="host-cli" aria-busy={hostBusy}>
      <div class="software-row">
        <div>
          <h3 id="host-cli" tabindex="-1">
            Host AKM CLI <span class="muted mono">{data.host.cli?.version ?? ""}</span>
          </h3>
          <p role="status">
            {data.host.phase !== "idle"
              ? (phases[data.host.phase] ?? "Working…")
              : !data.host.cli
                ? "Not checked"
                : !data.host.cli.installed
                  ? "Not installed"
                  : !data.host.cli.runnable
                    ? "Installed, but not runnable"
                    : data.host.upgrade?.updateAvailable
                      ? `Update available: ${data.host.upgrade.latestVersion}`
                      : data.host.upgrade
                        ? "Checked by AKM"
                        : "Installed"}
          </p>
        </div>
        <!-- Busy buttons stay focusable (aria-disabled, not disabled): a disabled button drops keyboard focus to the page. -->
        <div class="btn-row">
          <button class="btn-quiet icon-label" aria-disabled={hostBusy} onclick={() => run("check", {}, "host-cli")}
            ><Icon name="refresh" />Check CLI & plugins</button
          >
          {#if data.host.cli && !data.host.cli.installed}<button
              aria-disabled={hostBusy}
              onclick={() => run("install-cli", {}, "host-cli")}>Install AKM CLI</button
            >
          {:else if data.host.cli?.runnable}<button
              aria-disabled={hostBusy || desktopBehind}
              aria-describedby={desktopBehind ? "host-cli-behind" : undefined}
              onclick={() => !desktopBehind && run("upgrade-cli", {}, "host-cli")}>Update CLI & plugins</button
            >{/if}
        </div>
      </div>
      {#if data.host.error}<p class="notice notice-warn" role="alert">{data.host.error}</p>
        {#if data.host.errorDetail}<details class="field-hint">
            <summary>Details</summary>
            <pre class="mono">{data.host.errorDetail}</pre>
          </details>{/if}{/if}
      <!-- The region is always there, so a receipt arriving in it is announced. -->
      <div role="status">
        {#if data.host.receipt}<p class="notice">{data.host.receipt}</p>{/if}
      </div>
      {#if desktopBehind}<p class="notice notice-warn" role="status" id="host-cli-behind">
          A newer AKM is available than the one built into this app. Update AKM Desktop first, then update the CLI.
        </p>
      {:else if skew === "host-older"}<p class="notice" role="status">
          Host akm {data.host.cli?.version} is older than this app's engine ({data.engine}). If the library index
          changed, the CLI will ask you to upgrade: use Update CLI & plugins.
        </p>
      {:else if skew === "host-newer"}<p class="notice" role="status">
          Host akm {data.host.cli?.version} is newer than this app's engine ({data.engine}). If AKM Desktop says the
          library was upgraded by a newer AKM, update AKM Desktop.
        </p>{/if}
      <p class="field-hint">
        Updates use <code>akm upgrade</code>, including its migration checks and installed plugins. The desktop’s
        bundled engine updates with the app.
      </p>
      <details>
        <summary>Installation details</summary>
        <dl>
          <dt>CLI path</dt>
          <dd class="mono">{data.host.cli?.path ?? `${data.host.cliDirectory} (new installations)`}</dd>
          <dt>Installer</dt>
          <dd>{data.host.upgrade?.installMethod ?? "Official AKM release installer"}</dd>
          <dt>Last command</dt>
          <dd class="mono">{data.host.command ?? "Not run"}</dd>
        </dl>
      </details>
    </section>
    <section aria-labelledby="harness-plugins" aria-busy={hostBusy}>
      <div class="plugin-heading">
        <div>
          <h3 id="harness-plugins">Harness plugins</h3>
          <p class="muted">Add AKM to a harness you already use.</p>
        </div>
        <label class="field"
          >New plugin channel<select
            value={channel}
            aria-describedby="plugin-channel-hint"
            onchange={(event) => choose("pluginChannel", event.currentTarget.value)}
            ><option value="latest">Stable</option><option value="next">Prerelease</option></select
          ></label
        >
      </div>
      <p class="field-hint saved" role="status">{saved.pluginChannel}</p>
      <!-- A list: each item is one harness, named first, then its plugin's state and channel in words. -->
      <ul class="plugin-list" aria-labelledby="harness-plugins">
        {#each data.host.harnesses as harness (harness.id)}
          {@const followed = installedChannel(harness, data.host.upgrade?.plugins)}
          <li class="plugin-row">
            <div>
              <h4 id="plugin-{harness.id}" tabindex="-1">
                {harnessLabel(harness)} <span class="muted small">{harness.version ?? ""}</span>
              </h4>
              <p class="muted small">{pluginLine(harness)}{followed ? `, ${followed}` : ""}.</p>
              {#if harness.plugin?.note}<p class="field-hint">{harness.plugin.note}</p>{/if}
              {#if harness.plugin?.detail}<details class="field-hint">
                  <summary>Details</summary>
                  <pre class="mono">{harness.plugin.detail}</pre>
                </details>{/if}
            </div>
            {#if harness.plugin?.state === "missing"}<button
                class="btn-secondary"
                aria-disabled={hostBusy}
                onclick={() => run("install-plugin", { harness: harness.id, channel }, `plugin-${harness.id}`)}
                >Install AKM plugin for {harnessLabel(harness)}</button
              >{/if}
          </li>
        {/each}
      </ul>
      <p class="field-hint" id="plugin-channel-hint">
        The channel is remembered and is also what setup installs. Native installers preserve existing configuration and
        marketplace channels; an installed plugin's channel is shown once the host CLI has been checked. Plugin
        installation does not sign you in or approve hooks.
      </p>
    </section>
  {/if}
</div>

<style>
  .software {
    max-width: 1000px;
    margin-inline: auto;
    padding: 0 8px;
  }
  .intro {
    margin: 32px 0;
  }
  .intro h2 {
    margin: 0;
    font-size: 24px;
  }
  .intro p {
    margin: 8px 0 0;
  }
  section {
    padding: 32px 0;
    margin: 0;
    border-top: 1px solid var(--border);
  }
  h3,
  h4 {
    margin: 0;
    font-size: 16px;
    text-transform: none;
    letter-spacing: 0;
  }
  h3 {
    font-size: 18px;
  }
  h3 span,
  h4 span {
    font-weight: 400;
    margin-left: 8px;
  }
  .software-row,
  .plugin-row,
  .plugin-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
  }
  .software-row p,
  .plugin-row p {
    margin: 8px 0 0;
  }
  .software-row {
    margin-bottom: 20px;
  }
  .btn-row {
    flex-wrap: wrap;
  }
  .btn-row button {
    min-height: var(--control-height);
  }
  .menu-install {
    margin: 24px 0 32px;
  }
  .menu-install .software-row {
    margin-bottom: 8px;
  }
  .menu-install button {
    flex-shrink: 0;
  }
  details {
    margin-top: 20px;
  }
  summary {
    cursor: pointer;
    color: var(--muted);
  }
  dl {
    display: grid;
    grid-template-columns: 120px minmax(0, 1fr);
    gap: 12px;
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .plugin-heading {
    margin-bottom: 12px;
  }
  .plugin-heading p {
    margin: 8px 0;
  }
  .plugin-heading label {
    font-size: 12px;
    min-width: 145px;
  }
  .plugin-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .plugin-row {
    padding: 20px 0;
    border-bottom: 1px solid var(--border);
  }
  .plugin-row:last-child {
    border: 0;
  }
  .plugin-row > div {
    min-width: 0;
  }
  .plugin-row p {
    overflow-wrap: anywhere;
  }
  .plugin-row button {
    flex: none;
  }
  .field-hint {
    max-width: 75ch;
    margin-top: 12px;
  }
  /* The "Saved" line is a live region that must stay in the page; empty, it takes no room. */
  .saved:empty {
    margin: 0;
  }
  @media (max-width: 700px) {
    .software-row,
    .plugin-heading,
    .plugin-row {
      align-items: flex-start;
      flex-wrap: wrap;
      gap: 16px;
    }
    .software-row > .btn-row {
      width: 100%;
    }
    /* A long name ("Install AKM plugin for Claude Code") wraps instead of widening the page. */
    .plugin-row button {
      flex-shrink: 1;
    }
    dl {
      grid-template-columns: 1fr;
      gap: 6px;
    }
    dd {
      margin-bottom: 10px;
    }
  }
</style>
