<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  // What depth shows on the 3D map, the same on every page that draws it: akm's own place by likeness in meaning, or
  // one recorded figure in three bands inside each group, which Reverse turns back to front. The page holds the choice.
  import { LENSES, type Lens, type Overview } from "./library-overview";

  let {
    o,
    lens,
    flip,
    onLens,
    onFlip,
  }: {
    o: Overview;
    lens: Lens;
    flip: boolean;
    onLens: (id: Lens["id"]) => void;
    onFlip: () => void;
  } = $props();
</script>

<div class="depth-options">
  <label
    >Depth shows <select
      value={lens.id}
      title="What sits at the front and the back of each group"
      onchange={(event) => onLens(event.currentTarget.value as Lens["id"])}
      >{#each LENSES as l}{@const why = l.unavailable(o)}<option value={l.id} disabled={!!why} title={why}
          >{l.label}{why ? ` (${why.toLowerCase()})` : ""}</option
        >{/each}</select
    ></label
  >
  {#if lens.bands.length}<button
      class="btn-quiet"
      aria-pressed={flip}
      title="Bring the back of each group to the front"
      onclick={onFlip}>Reverse</button
    >{/if}
</div>

<style>
  .depth-options {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  label {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 13px;
    color: var(--muted);
  }
  button[aria-pressed="true"] {
    color: var(--text);
    background: var(--surface-2);
    font-weight: 600;
  }
</style>
