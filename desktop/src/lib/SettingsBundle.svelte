<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { tick } from "svelte";
  import { date } from "./client";
  import Icon from "./Icon.svelte";
  import BundleRename from "./BundleRename.svelte";
  import { provenance } from "./settings-presenter";
  import type { SettingsBundle } from "./settings-presenter";
  export let bundle: SettingsBundle;
  export let action: (path: string, body: unknown) => Promise<void>;
  export let busy = false;
  export let managing = false;
  export let hidden = false;
  let previous: SettingsBundle | null = null,
    enabled = true,
    writable = false,
    components: Record<string, boolean> = {},
    confirm = false,
    removing = false;
  let heading: HTMLHeadingElement,
    wasManaging = false;
  $: if (managing !== wasManaging) {
    wasManaging = managing;
    if (managing) tick().then(() => heading?.focus({ preventScroll: true }));
  }
  $: writableKind = ["filesystem", "git"].includes(bundle.kind);
  $: if (bundle !== previous) {
    previous = bundle;
    enabled = bundle.enabled;
    writable = bundle.writableSetting ?? bundle.kind === "filesystem";
    components = Object.fromEntries(
      bundle.components.map((item) => [
        item.name,
        item.writable ?? bundle.writableSetting ?? bundle.kind === "filesystem",
      ]),
    );
  }
  $: counts = Object.entries(bundle.byType ?? {})
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  $: total = counts.reduce((sum, [, count]) => sum + count, 0);
  async function save() {
    await action("/bundles/settings", {
      bundle: bundle.name,
      enabled,
      ...(writableKind ? { writable } : {}),
      componentWritability: Object.fromEntries(
        bundle.components
          .filter(
            (item) =>
              writableKind &&
              item.configured &&
              !item.name.includes(".") &&
              components[item.name] !== (item.writable ?? bundle.writableSetting ?? bundle.kind === "filesystem"),
          )
          .map((item) => [item.name, components[item.name]]),
      ),
    });
  }
</script>

<article
  class="bundle-card"
  class:bundle-management={managing}
  {hidden}
  aria-label={managing ? `Manage bundle ${bundle.name}` : `Bundle ${bundle.name}`}
>
  {#if managing}
    <header class="manage-heading">
      <div>
        <h2 tabindex="-1" bind:this={heading}>Manage {bundle.name}</h2>
        <p class="muted">{bundle.path ?? bundle.source?.locator ?? "Source path unavailable"}</p>
      </div>
      <a href={`/library/search?bundle=${encodeURIComponent(bundle.name)}`} aria-label={`Browse ${bundle.name} assets`}
        >Browse assets <Icon name="arrow-right" size={16} /></a
      >
    </header>
    <BundleRename bundle={bundle.name} {action} disabled={busy} />
    <form class="bundle-settings" on:submit|preventDefault={save}>
      <div class="setting-row">
        <label class="check-label"
          ><input type="checkbox" role="switch" class="switch" bind:checked={enabled} disabled={busy} /> Enabled</label
        >
        <p class="muted">Include this bundle in AKM. Choose another default before disabling the default bundle.</p>
      </div>
      <div class="setting-row">
        <label class="check-label"
          ><input
            type="checkbox"
            role="switch"
            class="switch"
            bind:checked={writable}
            disabled={busy || !writableKind}
          /> Bundle writable default</label
        >
        <p class="muted">Allow supported AKM writes. Individual components can override this default.</p>
      </div>
      <fieldset>
        <legend>Component access</legend>{#each bundle.components as component}<div class="component-row">
            <label class="check-label"
              ><input
                type="checkbox"
                role="switch"
                class="switch"
                bind:checked={components[component.name]}
                disabled={busy || !writableKind || !component.configured || component.name.includes(".")}
              /><span>{component.name} writable</span></label
            >
            <p class="muted">
              {component.adapter} · {component.root ?? "."} · {component.writable === undefined
                ? "Inherits bundle default"
                : "Explicit override"}
            </p>
          </div>{/each}{#if !bundle.components.length}<p>No components reported.</p>{/if}
      </fieldset>
      <div class="manage-save">
        <p class="muted small">{provenance(bundle.settingsSource)}. Saving creates a local override.</p>
        <button disabled={busy}>Save {bundle.name} settings</button>
      </div>
    </form>
    <section class="bundle-maintenance">
      <div>
        <h3>Refresh the bundle</h3>
        <p class="muted">Use AKM’s update process to synchronize and rebuild this bundle’s index.</p>
      </div>
      <button class="btn-secondary" disabled={busy} on:click={() => action("/bundles/update", { bundle: bundle.name })}
        ><Icon name="refresh" size={16} /> Update / reindex {bundle.name}</button
      >
    </section>
    <section class="bundle-removal">
      <div>
        <h3>Unregister this bundle</h3>
        <p class="muted">Remove it from AKM’s configured sources.</p>
      </div>
      {#if !removing}<button
          class="quiet danger-action"
          on:click={() => {
            removing = true;
            confirm = false;
          }}>Unregister {bundle.name}…</button
        >{:else}<form
          class="removal-confirmation"
          on:submit|preventDefault={() => action("/bundles/remove", { bundle: bundle.name, confirm })}
        >
          <p>
            Registration and managed installed cache may be removed. Filesystem source files remain on disk. This is not
            a generic source-file delete.
          </p>
          <label class="check-label"
            ><input type="checkbox" bind:checked={confirm} required /> Remove {bundle.name} registration</label
          >
          <div class="btn-row">
            <button type="button" class="btn-secondary" disabled={busy} on:click={() => (removing = false)}
              >Keep bundle</button
            ><button class="btn-danger" disabled={busy || !confirm}>Confirm removal</button>
          </div>
        </form>{/if}
    </section>
  {:else}
    <header class="card-head">
      <div class="bundle-title">
        <h3>{bundle.name}</h3>
        <a
          class="btn btn-secondary"
          href={`/settings/bundles?manage=${encodeURIComponent(bundle.name)}`}
          aria-label={`Manage ${bundle.name}`}><Icon name="sliders" size={16} /> Manage</a
        >
      </div>
      <div class="bundle-badges">
        <span class="badge">{bundle.kind}</span>{#if bundle.default}<span class="badge">Default</span>{/if}<span
          class="badge">{bundle.enabled ? "Enabled" : "Disabled"}</span
        ><span class="badge">{bundle.writable ? "Writable" : "Read-only"}</span>{#if !bundle.exists}<span
            class="badge badge-fail">Missing source</span
          >{/if}
      </div>
    </header>
    <dl class="bundle-facts">
      <dt>Path</dt>
      <dd class="mono wrap">{bundle.path ?? "Not available"}</dd>
      <dt>Source</dt>
      <dd class="wrap">
        {bundle.source?.locator ?? "Not available"} <span class="muted">({bundle.source?.kind ?? "Unknown"})</span>
      </dd>
      <dt>Version</dt>
      <dd>{bundle.version ?? "Not recorded"}</dd>
      <dt>Indexed assets</dt>
      <dd>{bundle.itemCount}</dd>
    </dl>
    {#if total}<div
        class="stacked-bar"
        role="img"
        aria-label={counts.map(([name, count]) => `${name}: ${count}`).join(", ")}
      >
        {#each counts as [name, count], i}<span
            class={`series-${(i % 6) + 1}`}
            style={`flex:${count}`}
            title={`${name}: ${count}`}
          ></span>{/each}
      </div>
      <ul class="bundle-counts">
        {#each counts as [name, count]}<li>{name} <strong>{count}</strong></li>{/each}
      </ul>{:else}<p class="muted">No indexed assets.</p>{/if}
    <h4>Git status</h4>
    {#if bundle.git}<dl class="bundle-facts">
        <dt>Branch</dt>
        <dd>{bundle.git.branch ?? "Detached HEAD"}</dd>
        <dt>Upstream</dt>
        <dd class="wrap">
          {bundle.git.upstream === null
            ? "No upstream"
            : `${bundle.git.upstream} · ${bundle.git.ahead} ahead / ${bundle.git.behind} behind`}
        </dd>
        <dt>Uncommitted</dt>
        <dd>{bundle.git.dirtyPaths ? `${bundle.git.dirtyPaths} paths` : "Clean"}</dd>
        <dt>Last commit</dt>
        <dd>
          {#if bundle.git.lastCommit}<code>{bundle.git.lastCommit.sha.slice(0, 8)}</code> · {date(
              bundle.git.lastCommit.time,
            )}
            <p>{bundle.git.lastCommit.subject}</p>{:else}No commits{/if}
        </dd>
      </dl>{:else}<p class="muted">Not a Git repository.</p>{/if}
    <footer class="bundle-actions">
      <a href={`/library/search?bundle=${encodeURIComponent(bundle.name)}`} aria-label={`Browse ${bundle.name} assets`}
        >Browse assets <Icon name="arrow-right" size={16} /></a
      >
    </footer>
  {/if}
</article>

<style>
  .bundle-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    width: 100%;
  }
  .bundle-title h3 {
    flex: 1;
    margin: 0;
    overflow-wrap: anywhere;
  }
  .bundle-title a {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex: none;
  }
  .bundle-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .bundle-card {
    min-width: 0;
    background: var(--surface);
    padding: 24px;
    border-radius: var(--radius-panel, 8px);
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .card-head {
    flex-wrap: wrap;
    gap: 8px 12px;
  }
  .card-head h3 {
    flex-basis: 100%;
    font-size: 20px;
  }
  .bundle-facts {
    display: grid;
    grid-template-columns: minmax(5rem, 0.25fr) minmax(0, 1fr);
    gap: 8px 16px;
    font-size: 14px;
    margin: 0;
  }
  .bundle-facts dt {
    color: var(--muted);
  }
  .bundle-facts dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .bundle-facts p {
    margin: 4px 0;
  }
  .bundle-counts {
    display: flex;
    flex-wrap: wrap;
    list-style: none;
    gap: 4px 16px;
    padding: 0;
    margin: 0;
    font-size: 13px;
  }
  .stacked-bar {
    height: 6px;
    display: flex;
    overflow: hidden;
    border-radius: 3px;
  }
  .bundle-card h4 {
    margin: 4px 0 0;
  }
  .bundle-card > p {
    margin: 0;
  }
  .bundle-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-top: auto;
    padding-top: 8px;
  }
  .bundle-actions a,
  .manage-heading > a {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .bundle-management {
    max-width: 900px;
    padding: 28px 32px;
    gap: 24px;
  }
  .manage-heading {
    display: flex;
    justify-content: space-between;
    align-items: start;
    gap: 24px;
  }
  .manage-heading h2 {
    font-size: 24px;
    margin: 0;
  }
  .manage-heading h2:focus {
    outline: 0;
  }
  .manage-heading p {
    margin: 8px 0 0;
    overflow-wrap: anywhere;
    font-size: 14px;
  }
  .manage-heading > a {
    flex: none;
    font-size: 14px;
  }
  .bundle-settings {
    display: grid;
    gap: 24px;
    margin: 0;
  }
  .setting-row p,
  .component-row p {
    margin: 8px 0 0;
    font-size: 14px;
    max-width: 65ch;
  }
  .bundle-settings fieldset {
    display: grid;
    gap: 16px;
    border: 0;
    border-top: 1px solid var(--border);
    padding: 20px 0 0;
    margin: 0;
    min-width: 0;
  }
  .bundle-settings legend {
    font-size: 16px;
    font-weight: 600;
    padding: 0 12px 0 0;
  }
  .check-label {
    align-items: center;
  }
  .manage-save {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 24px;
    padding-top: 8px;
  }
  .manage-save p {
    margin: 0;
    max-width: 45ch;
  }
  .bundle-maintenance,
  .bundle-removal {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 16px 24px;
    border-top: 1px solid var(--border);
    padding-top: 24px;
    margin: 0;
  }
  .bundle-maintenance h3,
  .bundle-removal h3 {
    font-size: 16px;
  }
  .bundle-maintenance p,
  .bundle-removal p {
    font-size: 14px;
    margin: 8px 0 0;
    max-width: 55ch;
  }
  .danger-action {
    color: var(--fail);
  }
  .removal-confirmation {
    flex-basis: 100%;
    display: grid;
    gap: 16px;
  }
  .removal-confirmation .btn-row {
    justify-content: flex-end;
  }
  .badge-fail {
    color: var(--fail);
  }
  @media (max-width: 650px) {
    .bundle-card,
    .bundle-management {
      padding: 20px;
    }
    .manage-heading,
    .manage-save {
      align-items: start;
      flex-direction: column;
    }
    .bundle-facts {
      grid-template-columns: 5rem minmax(0, 1fr);
    }
    .bundle-actions {
      flex-wrap: wrap;
    }
  }
</style>
