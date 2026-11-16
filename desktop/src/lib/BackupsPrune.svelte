<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { api } from "./client";
  import { pruneSummary, type BackupsPrune } from "./home-model";

  /** A host whose check goes away once the backups are gone says the result itself; without one, this says it. */
  let { onDone }: { onDone?: (result: BackupsPrune) => void } = $props();
  const OLDER_THAN = "30d";

  let busy = $state(false),
    preview = $state<BackupsPrune | null>(null),
    done = $state<BackupsPrune | null>(null),
    error = $state("");

  async function run(dryRun: boolean) {
    busy = true;
    error = "";
    try {
      const result = await api<BackupsPrune>("/backups/prune", {}, { olderThan: OLDER_THAN, dryRun, confirm: !dryRun });
      if (dryRun) preview = result;
      else {
        preview = null;
        if (onDone) onDone(result);
        else done = result;
      }
    } catch (failure) {
      error = failure instanceof Error ? failure.message : "The backups could not be pruned.";
    } finally {
      busy = false;
    }
  }
</script>

<div class="prune">
  {#if preview && preview.count > 0}
    <p role="status">
      Removes {pruneSummary(preview)} older than {preview.olderThan}. The newest backup in each folder stays.
    </p>
    <div class="btn-row">
      <button class="btn-danger" disabled={busy} onclick={() => run(false)}
        >Remove {preview.count} {preview.count === 1 ? "backup" : "backups"}</button
      ><button class="btn-secondary" disabled={busy} onclick={() => (preview = null)}>Cancel</button>
    </div>
  {:else}
    {#if preview}<p role="status">Nothing is older than {preview.olderThan}; the newest backup in each folder stays.</p>
    {:else if done}<p role="status">Removed {pruneSummary(done)}. Check health to update the size above.</p>{/if}
    <button class="btn-secondary" disabled={busy} onclick={() => run(true)}
      >{busy ? "Checking…" : "Prune backups…"}</button
    >
  {/if}
  {#if error}<p class="notice notice-fail" role="alert">{error}</p>{/if}
</div>

<style>
  .prune {
    display: grid;
    gap: var(--space-2);
    justify-items: start;
    margin-top: var(--space-3);
  }
  .prune p {
    margin: 0;
    font-size: var(--text-s);
    color: var(--muted);
  }
  .prune .notice {
    margin: 0;
    color: var(--text);
  }
</style>
