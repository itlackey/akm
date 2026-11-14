<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  // Owns a deck.gl canvas (`ui/deck-stage.js`) for the life of the component: what to draw comes from the page.
  import { onDestroy, onMount } from "svelte";
  import { createDeckStage } from "./ui/deck-stage.js";

  export type Label = { position: number[]; text: string; priority: number; size?: number };
  let {
    layers,
    labels = [],
    three = false,
    frame,
    label,
    ink,
    paper,
    tooltip,
    fallback = "This view needs WebGL, which this window does not have. The lists beside it give the same figures.",
  }: {
    layers: unknown[];
    labels?: Label[];
    three?: boolean;
    /** What the camera frames: the centre and radius of what is drawn. A new value frames it again. */
    frame: { centre: number[]; radius: number };
    label: string;
    ink: number[];
    paper: number[];
    // biome-ignore lint/suspicious/noExplicitAny: deck.gl's picking info.
    tooltip: (info: any) => string | null;
    fallback?: string;
  } = $props();

  let host: HTMLDivElement;
  let failed = $state("");
  // biome-ignore lint/suspicious/noExplicitAny: the untyped stage.
  let stage: any = $state(null);

  onMount(() => {
    try {
      stage = createDeckStage({
        host,
        three,
        tooltip: (info: unknown) => tooltip(info),
        onError: (error: Error) => (failed = `${fallback} (${error.message})`),
      });
    } catch {
      failed = fallback;
    }
  });
  onDestroy(() => stage?.destroy());

  $effect(() => {
    stage?.draw(layers, labels, { ink, paper });
  });
  // Flat or 3D, or something new to frame: frame it (animated within one view, at once when the view changes).
  let shown: boolean | null = null;
  $effect(() => {
    const box = frame;
    if (!stage) return;
    const changed = shown !== three;
    shown = three;
    stage.setThree(three);
    stage.frame(box, changed ? 0 : 600);
  });
</script>

<div class="deck-stage" bind:this={host} role="img" aria-label={label}>
  {#if failed}<p class="notice notice-warn">{failed}</p>{/if}
</div>

<style>
  .deck-stage {
    position: absolute;
    inset: 0;
    overflow: hidden;
  }
  .notice {
    position: absolute;
    inset-inline: 12px;
    inset-block-start: 12px;
    margin: 0;
  }
</style>
