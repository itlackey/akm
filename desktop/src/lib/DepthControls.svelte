<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  // What the 3D map's depth shows, the same controls on every page that draws it: the lens (one recorded variable, or
  // akm's own place), Flip to bring the back of each group to the front, Flatten to draw the same points in one plane,
  // and Face front to turn the view back to where front is toward the viewer. The page holds the choices.
  import { LENSES, type Lens, type Overview } from "./library-overview";

  let {
    o,
    lens,
    flip,
    flat,
    onLens,
    onFlip,
    onFlat,
    onFront,
  }: {
    o: Overview;
    lens: Lens;
    flip: boolean;
    flat: boolean;
    onLens: (id: Lens["id"]) => void;
    onFlip: () => void;
    onFlat: () => void;
    onFront: () => void;
  } = $props();
</script>

<div class="depth-controls" role="group" aria-label="Map depth">
  <label
    >Depth <select
      value={lens.id}
      disabled={flat}
      title={flat ? "Depth is off while flattened" : "What sits at the front and the back of each group"}
      onchange={(event) => onLens(event.currentTarget.value as Lens["id"])}
      >{#each LENSES as l}{@const why = l.unavailable(o)}<option value={l.id} disabled={!!why} title={why}
          >{l.label}{why ? ` (${why.toLowerCase()})` : ""}</option
        >{/each}</select
    ></label
  >
  <button
    class="btn-quiet"
    aria-pressed={flip}
    disabled={flat || !lens.bands.length}
    title={flat
      ? "Depth is off while flattened"
      : lens.bands.length
        ? "Bring the back of each group to the front"
        : "Likeness in meaning has no front or back to flip"}
    onclick={onFlip}>Flip</button
  >
  <button
    class="btn-quiet"
    aria-pressed={flat}
    title="Draw the same points in one plane: every asset keeps its place left to right and up and down"
    onclick={onFlat}>Flatten</button
  >
  <button class="btn-quiet" title="Turn the view to face the front; the zoom and the selection stay" onclick={onFront}
    >Face front</button
  >
</div>

<style>
  .depth-controls {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 8px;
    align-items: center;
    margin-block-end: 8px;
  }
  label {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-inline-end: 4px;
    font-size: 13px;
    color: var(--muted);
  }
  button[aria-pressed="true"] {
    color: var(--text);
    background: var(--surface-2);
    font-weight: 600;
  }
</style>
