<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { api } from "./client";
  import type { MovedLinksReport } from "./library-files-model";
  let {
    report,
    onUpdated,
  }: {
    /** akm's list of the links that still name the old place of an asset that was moved. */
    report: MovedLinksReport;
    onUpdated: () => void;
  } = $props();
  let busy = $state(false),
    error = $state(""),
    done = $state<{ rewritten: number; files: string[] } | null>(null);
  const fixable = $derived(report.bundles.filter((entry) => entry.writeBlocker === null && entry.links.length));
  const blocked = $derived(report.bundles.filter((entry) => entry.writeBlocker !== null && entry.links.length));
  const count = $derived(fixable.reduce((sum, entry) => sum + entry.links.length, 0));
  async function update() {
    if (busy) return;
    busy = true;
    error = "";
    done = null;
    try {
      let rewritten = 0;
      const files: string[] = [];
      for (const entry of fixable) {
        const result = await api<{ rewritten: number; files: string[] }>(
          "/assets/update-moved-links",
          {},
          { bundle: entry.bundle },
        );
        rewritten += result.rewritten;
        files.push(...result.files);
      }
      done = { rewritten, files };
      onUpdated();
    } catch (cause) {
      error = (cause as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

{#if count || blocked.length}
  <section class="notice moved-links" aria-label="Links to the old place">
    <p>
      <strong>{report.total} {report.total === 1 ? "link still points" : "links still point"} at the old place.</strong>
      {#if count}<button
          class="btn btn-secondary"
          aria-disabled={busy ? "true" : undefined}
          aria-busy={busy || undefined}
          onclick={update}>{busy ? "Updating…" : `Update ${count} ${count === 1 ? "link" : "links"}`}</button
        >{/if}
    </p>
    {#each blocked as entry}<p class="muted small">
        {entry.links.length} in {entry.bundle}, not updated: {entry.writeBlocker}
      </p>{/each}
    {#if error}<p role="alert">{error}</p>{/if}
  </section>
{/if}
{#if done}<p class="notice" role="status">
    Updated {done.rewritten}
    {done.rewritten === 1 ? "link" : "links"} in {done.files.length}
    {done.files.length === 1 ? "file" : "files"}: <span class="mono wrap">{done.files.join(", ")}</span>.
  </p>{/if}
{#if error && !(count || blocked.length)}<p class="notice notice-warn" role="alert">{error}</p>{/if}
