<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import type { Json } from "./types";
  import PropertyValue from "./PropertyValue.svelte";
  let { value }: { value: Json | undefined } = $props();
  const scalar = (item: Json | undefined) => item === null || typeof item !== "object";
  const text = (item: Json | undefined) => (item === null || item === undefined ? "empty" : String(item));
</script>

{#if Array.isArray(value)}
  {#if value.every(scalar)}{value.map(text).join(", ")}{:else}<ol class="property-list">
      {#each value as item}<li><PropertyValue value={item} /></li>{/each}
    </ol>{/if}
{:else if value && typeof value === "object"}
  <dl class="property-map">
    {#each Object.entries(value) as [name, item]}<dt>{name}</dt>
      <dd><PropertyValue value={item} /></dd>{/each}
  </dl>
{:else}{text(value)}{/if}

<style>
  .property-list {
    margin: 0;
    padding-left: 20px;
  }
  .property-map {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 2px 12px;
    margin: 0;
  }
  .property-map dd {
    margin: 0;
  }
  .property-map dt {
    color: var(--muted);
  }
</style>
