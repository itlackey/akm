<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "./client";
  import SetupAgents from "./SetupAgents.svelte";
  import SetupLibrary from "./SetupLibrary.svelte";
  import { agentCards } from "./setup-model";
  import { refreshBundles } from "./state/workspace.svelte";
  import { software, watchSoftware } from "./state/software.svelte";

  type Detected = { stashDir: string; harnesses: Array<{ platform: string; path: string }> };
  let detected = $state<Detected | null>(null);
  let enabled = $state<string[]>([]);
  let error = $state("");

  /** The harnesses akm is set to use, as its own config names them. */
  async function refreshEnabled() {
    const { config } = await api<{ config: { harnesses?: Record<string, { platform?: string }> } }>("/config");
    enabled = Object.entries(config.harnesses ?? {}).map(([name, harness]) => harness.platform ?? name);
  }
  const akmSees = $derived(detected?.harnesses.map((harness) => harness.platform) ?? []);
  const cards = $derived(software.data ? agentCards(software.data.host, software.data.engine, akmSees, enabled) : []);

  onMount(() => {
    const stop = watchSoftware();
    Promise.all([api<Detected>("/setup/detect"), refreshBundles(), refreshEnabled()])
      .then(([found]) => (detected = found))
      .catch((cause) => (error = (cause as Error).message));
    return stop;
  });
</script>

<div class="setup">
  <div class="setup-heading">
    <h1>Set up akm</h1>
    <p class="muted">
      Create your library, connect the agents you use, and check that they can reach it. Each step shows what is true
      now, so you can run setup again at any time. Nothing runs until you press a button.
    </p>
  </div>
  {#if error}<p class="notice notice-warn" role="alert">{error}</p>{/if}
  {#if !detected}<p role="status">Looking at this computer…</p>{:else}
    <SetupLibrary stashDir={detected.stashDir} />
    <SetupAgents {cards} engine={software.data?.engine} onconfigured={refreshEnabled} />
  {/if}
</div>

<style>
  .setup {
    max-width: 860px;
    margin: 0 auto;
    padding: 8px 0 48px;
  }
  .setup-heading h1 {
    margin: 0 0 12px;
  }
  .setup-heading p {
    margin: 0 0 24px;
    max-width: 68ch;
    line-height: 1.6;
  }
</style>
