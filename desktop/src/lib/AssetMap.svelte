<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { assetMap, fit, type MapGroup } from "./asset-map-model";
  let {
    ref,
    connections,
    similar = [],
    href,
  }: {
    ref: string;
    connections: Array<{ direction: string; kind: string; refs: string[]; total: number }>;
    similar?: Array<{ ref: string; title: string; cosine: number }>;
    href: (ref: string) => string;
  } = $props();
  let available = $state(720);
  // The library map opens with this asset selected, and lists every link of it.
  const mapHref = $derived(`/library/map?select=${encodeURIComponent(ref)}`);
  const map = $derived(assetMap(connections, similar, ref));
  // The drawing never gets narrower than it can be read at; a narrow panel scrolls it sideways.
  const width = $derived(Math.max(available, 640));
  // Room above the rows for the two column headings.
  const PAD = 36;
  const box = $derived(Math.min(200, width * 0.26));
  const reach = $derived(Math.min(90, width * 0.09));
  const leftEdge = $derived(width / 2 - box / 2);
  const rightEdge = $derived(width / 2 + box / 2);
  // Characters that fit beside the middle box at this width, at about 6.6px each.
  const room = $derived(Math.floor((leftEdge - reach - 8) / 6.6));
  const height = $derived(map.height + PAD + 12);
  const centre = $derived(map.centre + PAD);
  /** A curve from a row's label to the side of the middle box. */
  const curve = (y: number, side: "left" | "right") => {
    const from = side === "left" ? leftEdge - reach : rightEdge + reach;
    const to = side === "left" ? leftEdge : rightEdge;
    const mid = (from + to) / 2;
    return `M ${from} ${y + PAD} C ${mid} ${y + PAD}, ${mid} ${centre}, ${to} ${centre}`;
  };
  /** The arrow points at what is linked to: the middle for a link from the left, the row for a link to the right. */
  const arrow = (group: MapGroup, side: "left" | "right") =>
    group.inferred
      ? {}
      : side === "left"
        ? { "marker-end": "url(#asset-map-arrow)" }
        : { "marker-start": "url(#asset-map-arrow)" };
</script>

<div class="asset-map" bind:clientWidth={available}>
  <svg {width} {height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={`Links of ${ref}`}>
    <defs
      ><marker
        id="asset-map-arrow"
        viewBox="0 0 8 8"
        refX="7"
        refY="4"
        markerWidth="7"
        markerHeight="7"
        orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z" /></marker
      ></defs
    >
    {#each [["left", map.left], ["right", map.right]] as const as [side, groups]}
      {@const x = side === "left" ? leftEdge - reach - 6 : rightEdge + reach + 6}
      {@const anchor = side === "left" ? "end" : "start"}
      {@const heading = side === "left" ? map.leftHeading : map.rightHeading}
      {#if heading}<text class="column" {x} y="14" text-anchor={anchor}>{heading}</text>{/if}
      {#each groups as group}
        <text class="group" {x} y={group.y + PAD} text-anchor={anchor}>{group.title}</text>
        {#each group.links as link}
          <path
            class="line"
            class:inferred={group.inferred}
            class:missing={group.missing}
            d={curve(link.y, side)}
            {...arrow(group, side)}
            aria-hidden="true"
          />
          {#if group.missing}<text class="label missing" {x} y={link.y + PAD} text-anchor={anchor}
              ><title>{link.ref}</title>{fit(link.label, room)}</text
            >{:else}<a href={href(link.ref)} aria-label={`${group.title}: ${link.ref}`}
              ><title>{link.ref}{link.note ? ` · ${link.note}` : ""}</title><text
                class="label"
                {x}
                y={link.y + PAD}
                text-anchor={anchor}>{fit(link.label, room)}</text
              ></a
            >{/if}
        {/each}
        {#if group.more}<a href={mapHref} aria-label={`${group.more} more links of ${ref}: see them on the library map`}
            ><text class="more" {x} y={group.moreY + PAD} text-anchor={anchor}
              >and {group.more} more: see every link on the library map</text
            ></a
          >{/if}
      {/each}
    {/each}
    <rect class="self" x={leftEdge} y={centre - 18} width={box} height="36" rx="2" />
    <text class="self-label" x={width / 2} y={centre} text-anchor="middle"
      ><title>{ref}</title>{fit(ref.split("//").at(-1) ?? ref, Math.floor((box - 16) / 6.8))}</text
    >
  </svg>
  {#if map.similarLeftOut}<p class="muted small left-out">
      {map.similarLeftOut} similar {map.similarLeftOut === 1 ? "asset" : "assets"} left out: already shown as {map.similarLeftOut ===
      1
        ? "a link"
        : "links"}.
    </p>{/if}
</div>

<style>
  .asset-map {
    overflow-x: auto;
  }
  svg {
    display: block;
  }
  text {
    font-size: 12px;
    dominant-baseline: central;
    fill: var(--text);
  }
  .column,
  .group,
  .more {
    fill: var(--muted);
  }
  a .more {
    fill: var(--link);
  }
  a:hover .more,
  a:focus-visible .more {
    text-decoration: underline;
  }
  .column,
  .group {
    font-weight: 600;
  }
  .column {
    fill: var(--text);
  }
  a .label {
    fill: var(--link);
  }
  a:hover .label,
  a:focus-visible .label {
    text-decoration: underline;
  }
  a:focus-visible {
    outline: 2px solid var(--link);
    outline-offset: 2px;
  }
  .label.missing {
    fill: var(--muted);
  }
  .line {
    fill: none;
    stroke: var(--border-strong);
    stroke-width: 1.25;
  }
  /* Similarity is not a recorded link, and a missing target is a link to nothing: both are dashed. */
  .line.inferred,
  .line.missing {
    stroke-dasharray: 4 4;
  }
  marker path {
    fill: var(--border-strong);
  }
  .self {
    fill: var(--accent-bg);
    stroke: var(--accent);
  }
  .self-label {
    font-weight: 600;
  }
</style>
