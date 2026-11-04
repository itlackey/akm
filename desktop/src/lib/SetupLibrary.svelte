<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { api, pickFolder } from "./client";
  import { hasStarter, STARTER } from "./setup-model";
  import { refreshBundles, workspace } from "./state/workspace.svelte";

  let { stashDir }: { stashDir: string } = $props();
  let dir = $state(""),
    starter = $state(true),
    busy = $state(false),
    outcomes = $state<Array<{ ok: boolean; text: string }>>([]),
    dirInput = $state<HTMLInputElement>();

  const created = $derived(!workspace.unconfigured);
  const wantsStarter = $derived(starter && !hasStarter(workspace.bundles));
  const failed = $derived(outcomes.some((outcome) => !outcome.ok));
  const message = (cause: unknown) => (cause as Error).message;

  /** Create the library when there is none, then add the starter bundle when it is wanted. Safe to repeat. */
  async function run() {
    busy = true;
    outcomes = [];
    try {
      if (workspace.unconfigured) {
        try {
          const result = await api<{ bundleDir: string }>("/setup/apply", {}, { dir: dir || stashDir });
          outcomes.push({ ok: true, text: `Library created at ${result.bundleDir}.` });
        } catch (cause) {
          outcomes.push({ ok: false, text: `The library could not be created. ${message(cause)}` });
          return;
        } finally {
          await refreshBundles().catch(() => undefined);
        }
      }
      if (wantsStarter) {
        try {
          await api("/bundles/add", {}, { source: STARTER });
          outcomes.push({ ok: true, text: "Starter bundle added and indexed." });
        } catch (cause) {
          outcomes.push({ ok: false, text: `The starter bundle could not be added. ${message(cause)}` });
        } finally {
          await refreshBundles().catch(() => undefined);
        }
      }
    } finally {
      busy = false;
    }
  }
  async function browse() {
    try {
      const folder = await pickFolder(dir || stashDir);
      if (folder !== null) dir = folder;
    } catch (cause) {
      outcomes = [{ ok: false, text: message(cause) }];
    }
    dirInput?.focus();
  }
</script>

<section class="setup-step" aria-labelledby="setup-library">
  <div class="step-head">
    <h2 id="setup-library">1. Your library</h2>
    <span class="badge" data-tone={created ? "ok" : "warn"}>{created ? "✓ Ready" : "Not created yet"}</span>
  </div>
  {#if created}
    <p>
      Your library is set up with {workspace.bundles.length}
      {workspace.bundles.length === 1 ? "bundle" : "bundles"}:
      {workspace.bundles.map((bundle) => bundle.name).join(", ") || "the working library"}.
      <a href="/settings/bundles">Manage bundles</a>
    </p>
  {:else}
    <p>
      The library is the folder where akm keeps what your agents learn. Nothing else works until it exists. It stays on
      this computer.
    </p>
    <div class="field">
      <label class="field-label" for="setup-dir">Location</label>
      <div class="field-control">
        <input id="setup-dir" bind:this={dirInput} bind:value={dir} placeholder={stashDir} autocomplete="off" />
        <button class="btn-secondary" type="button" onclick={browse}>Browse folders…</button>
      </div>
    </div>
  {/if}
  {#if !created || !hasStarter(workspace.bundles)}
    <label class="check-label">
      <input type="checkbox" bind:checked={starter} /> Add the AKM starter bundle
      <span class="muted">(<code>itlackey/akm-stash</code>; downloads from GitHub)</span>
    </label>
    <div class="btn-row">
      <button disabled={busy || (created && !wantsStarter)} onclick={run}
        >{busy ? "Working…" : failed ? "Retry" : created ? "Add starter bundle" : "Create library"}</button
      >
    </div>
  {/if}
  {#each outcomes as outcome}
    <p
      class="notice"
      class:notice-warn={!outcome.ok}
      class:notice-ok={outcome.ok}
      role={outcome.ok ? "status" : "alert"}
    >
      {outcome.text}
    </p>
  {/each}
</section>

<style>
  .btn-row {
    margin-top: 16px;
  }
</style>
