<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import type { FrontmatterRead } from "./types";
  import PropertyValue from "./PropertyValue.svelte";
  let { properties, failure = "" }: { properties: FrontmatterRead | null; failure?: string } = $props();
  const first = ["description", "tags", "project", "updated"];
  const entries = $derived(
    [...(properties?.entries ?? [])].sort((a, b) => {
      const rank = (key: string) => (first.includes(key) ? first.indexOf(key) : first.length);
      return rank(a.key) - rank(b.key);
    }),
  );
</script>

{#if failure}<p class="muted small properties-note" role="status">Properties are not shown: {failure}</p>
{:else if properties?.error}<p class="notice notice-warn properties-note" role="alert">
    The frontmatter cannot be read: {properties.error.reason}{properties.error.line
      ? ` (line ${properties.error.line})`
      : ""}
  </p>
{:else if properties?.present}<section class="properties" aria-label="Properties">
    <dl>
      {#each entries as entry (entry.key)}<dt>{entry.key}</dt>
        <dd><PropertyValue value={entry.value} /></dd>{/each}
    </dl>
  </section>{/if}

<style>
  .properties {
    margin: 0 0 16px;
    padding: 12px 16px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: 13px;
  }
  .properties dl {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 4px 16px;
    margin: 0;
  }
  .properties dt {
    color: var(--muted);
    font-weight: 550;
  }
  .properties dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .properties-note {
    margin: 0 0 12px;
  }
</style>
