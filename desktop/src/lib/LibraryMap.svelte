<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { onDestroy } from "svelte";
  import { api, date } from "./client";
  import GraphView from "./GraphView.svelte";
  import {
    buildGraph,
    colourSlot,
    edgePairs,
    FAMILIES,
    type GraphPayload,
    type LibraryGraph,
    linkLabel,
    linksOf,
  } from "./graph-model";
  import { filesHref } from "./library-files-model";
  import { searchHref } from "./library-model";
  import { workspace } from "./state/workspace.svelte";

  // biome-ignore lint/suspicious/noExplicitAny: the renderer is untyped presentation code.
  type View = any;
  let graph = $state.raw<LibraryGraph | null>(null);
  let note = $state("");
  let error = $state("");
  let colourBy = $state<"family" | "bundle" | "use">("family");
  let arrange = $state<"meaning" | "bundle">("bundle");
  let flat = $state(false);
  let lens = $state<"" | "never" | "outdated">("");
  let query = $state("");
  let hidden = $state<number[]>([]);
  let kindsOff = $state<number[]>([]);
  let selected = $state(-1);
  let shown = $state<"map" | "table">("map");
  let hover = $state<{ i: number; x: number; y: number } | null>(null);
  let frameMs = $state(0);
  let view: View;
  let data: Record<string, unknown> | null = $state.raw(null);
  let colours: Uint8Array;
  let positions: Float32Array;
  let slots: number[][] = [];
  let ramp: number[][] = [];
  let neutral: number[] = [];

  const open = (ref: string) => searchHref(new URLSearchParams(), ref);
  const name = (i: number) => graph?.name(i) ?? "";

  async function load() {
    error = "";
    try {
      const payload = await api<GraphPayload>("/graph");
      note = payload.note;
      if (!payload.available) return;
      const built = buildGraph(payload);
      arrange = built.meaning ? "meaning" : "bundle";
      colours = new Uint8Array(built.count * 4);
      positions = Float32Array.from(built.meaning ?? built.byBundle);
      data = {
        count: built.count,
        pos: positions,
        color: colours,
        size: built.size,
        edges: edgePairs(built, () => true),
        anchors: built.meaning ? [] : built.bundleAnchors,
        label: (i: number) => built.name(i),
      };
      graph = built;
    } catch (cause) {
      error = (cause as Error).message;
    }
  }
  void load();

  /** Colours from the tokens: eight slots, a one-hue ramp for use, and a neutral for "never shown". */
  function readTokens(read: (token: string) => number[]) {
    slots = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => read(`--map-${n}`));
    const low = read("--surface-2");
    const high = read("--map-1");
    const dark = read("--bg").reduce((a, b) => a + b, 0) < 384;
    ramp = [0.25, 0.5, 0.75, 1].map((t) => low.map((c, k) => Math.round(c + (high[k]! - c) * t)));
    if (!dark) ramp = ramp.map((c) => c.map((v) => Math.round(v * 0.8)));
    neutral = read("--border-strong");
    if (view) paint();
  }

  function paint() {
    if (!graph || !view) return;
    const outdated = lens === "outdated";
    for (let i = 0; i < graph.count; i++) {
      const slot = colourSlot(graph, i, colourBy);
      let c: number[];
      if (outdated && graph.outdated[i]) c = slots[7]!;
      else if (slot >= 0) c = slots[slot]!;
      else if (!graph.shows[i]) c = neutral;
      else c = ramp[Math.min(3, Math.floor(Math.log2(1 + graph.shows[i]!) / 3))]!;
      colours.set(c, i * 4);
      colours[i * 4 + 3] = 225;
    }
    view.setColors(colours);
  }

  /** What is lit: a hidden group, the search, the highlight and the selection each narrow it. */
  function filter() {
    if (!graph || !view) return;
    const state = new Uint8Array(graph.count);
    const q = query.trim().toLowerCase();
    const narrowing = !!q || !!lens;
    const neighbours = new Set<number>();
    if (selected >= 0 && !narrowing)
      for (const group of linksOf(graph, selected)) for (const n of group.nodes) neighbours.add(n);
    for (let i = 0; i < graph.count; i++) {
      if (arrange === "meaning" && !graph.placed[i]) continue;
      if (colourBy !== "use" && hidden.includes(colourSlot(graph, i, colourBy))) continue;
      if (lens === "never" && graph.shows[i]) continue;
      if (lens === "outdated" && !graph.outdated[i]) continue;
      if (q && !graph.ref[i]!.toLowerCase().includes(q) && !graph.title[i]!.toLowerCase().includes(q)) continue;
      if (selected >= 0 && !narrowing && i !== selected && !neighbours.has(i)) continue;
      state[i] = narrowing ? 2 : 1;
    }
    if (selected >= 0) state[selected] = 2;
    view.setState(state);
  }
  const matches = $derived.by(() => {
    void [query, lens, hidden, colourBy, arrange];
    if (!graph) return [] as number[];
    const q = query.trim().toLowerCase();
    const out: number[] = [];
    for (let i = 0; i < graph.count; i++) {
      if (arrange === "meaning" && !graph.placed[i]) continue;
      if (colourBy !== "use" && hidden.includes(colourSlot(graph, i, colourBy))) continue;
      if (lens === "never" && graph.shows[i]) continue;
      if (lens === "outdated" && !graph.outdated[i]) continue;
      if (q && !graph.ref[i]!.toLowerCase().includes(q) && !graph.title[i]!.toLowerCase().includes(q)) continue;
      out.push(i);
    }
    const shows = graph.shows;
    return out.sort((a, b) => shows[b]! - shows[a]!);
  });

  /** The camera distance that shows every placed asset. */
  function fit(pos: Float32Array) {
    let reach = 0;
    for (let n = 0; n < pos.length; n += 3)
      reach = Math.max(reach, Math.hypot(pos[n]!, pos[n + 2]!), Math.abs(pos[n + 1]!));
    return Math.max(260, reach * 2.6);
  }

  function ready(next: View) {
    view = next;
    view.onPick = (i: number) => select(i);
    view.onHover = (i: number, at?: number[]) => {
      hover = i >= 0 && at ? { i, x: at[0]!, y: at[1]! } : null;
    };
    let total = 0;
    let frames = 0;
    view.onFrame = (dt: number) => {
      total += dt;
      if (++frames === 30) {
        frameMs = Math.round((total / 30) * 10) / 10;
        total = frames = 0;
      }
    };
    if (arrange === "bundle") {
      view.setFlat(true);
      flat = true;
    }
    view.goal.dist = view.cam.dist = fit(positions);
    paint();
    filter();
  }

  function select(i: number, fly = true) {
    selected = i;
    if (!view || !graph) return;
    view.select(i);
    if (i < 0) {
      view.setHighlightEdges(new Uint32Array(0));
      view.emphasis = [];
    } else {
      const pairs: number[] = [];
      for (let a = graph.offsets[i]!; a < graph.offsets[i + 1]!; a++) {
        const e = graph.adjLink[a]!;
        if (kindsOff.includes(graph.kind[e]!)) continue;
        pairs.push(graph.from[e]!, graph.to[e]!);
      }
      view.setHighlightEdges(Uint32Array.from(pairs));
      view.emphasis = [...new Set(pairs)].filter((n) => n !== i).slice(0, 14);
      if (fly) view.focus(i, Math.min(620, fit(positions) / 2));
    }
    filter();
  }

  function setArrange(next: "meaning" | "bundle") {
    if (!graph || !view || next === arrange) return;
    arrange = next;
    const start = Float32Array.from(positions);
    const target = next === "meaning" && graph.meaning ? graph.meaning : graph.byBundle;
    (data as { anchors: unknown }).anchors = next === "bundle" ? graph.bundleAnchors : [];
    flat = next === "bundle";
    view.setFlat(flat);
    view.home();
    view.goal.dist = fit(target);
    const began = performance.now();
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const step = (now: number) => {
      const t = reduce ? 1 : Math.min(1, (now - began) / 1000);
      const k = t * t * (3 - 2 * t);
      for (let n = 0; n < positions.length; n++) positions[n] = start[n]! + (target[n]! - start[n]!) * k;
      view.setPositions(positions);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    filter();
  }

  function toggleKind(k: number) {
    kindsOff = kindsOff.includes(k) ? kindsOff.filter((x) => x !== k) : [...kindsOff, k];
    if (graph && view) view.setEdges(edgePairs(graph, (kind) => !kindsOff.includes(kind)));
    select(selected, false);
  }
  function toggleGroup(slot: number, only: boolean) {
    const all = [0, 1, 2, 3, 4, 5, 6, 7];
    hidden = only
      ? all.filter((s) => s !== slot)
      : hidden.includes(slot)
        ? hidden.filter((s) => s !== slot)
        : [...hidden, slot];
  }

  $effect(() => {
    void [colourBy, lens];
    paint();
  });
  $effect(() => {
    void [query, lens, hidden, colourBy];
    filter();
  });

  const legend = $derived.by(() => {
    if (!graph || colourBy === "use") return [];
    const counts = new Array(8).fill(0);
    for (let i = 0; i < graph.count; i++) counts[colourSlot(graph, i, colourBy)]++;
    const labels =
      colourBy === "family"
        ? FAMILIES.map((family) => family.label)
        : [...graph.bundles.slice(0, 7), graph.bundles.length > 8 ? "Other bundles" : (graph.bundles[7] ?? "")];
    return labels.map((label, slot) => ({ label, slot, count: counts[slot] })).filter((row) => row.count);
  });
  const kindCounts = $derived.by(() => {
    if (!graph) return [];
    const counts = new Array(graph.kinds.length).fill(0);
    for (const k of graph.kind) counts[k]++;
    return graph.kinds.map((kind, k) => ({ k, label: linkLabel(kind), count: counts[k] }));
  });
  const unplaced = $derived(graph?.meaning ? graph.count - graph.placed.reduce((a, b) => a + b, 0) : 0);
  const detail = $derived(graph && selected >= 0 ? linksOf(graph, selected) : []);
  onDestroy(() => {
    view = null;
  });
</script>

<nav class="library-views" aria-label="Library views" data-sveltekit-reset="false">
  <a href="/library/search">Search</a>
  <a
    href={filesHref({
      bundle:
        workspace.bundles.find((bundle) => bundle.default)?.name ??
        workspace.bundles.find((bundle) => bundle.enabled)?.name ??
        "",
      path: "",
    })}>Files</a
  >
  <a href="/library/map" aria-current="page">Map</a>
</nav>
<div class="map-page">
  <div class="map-toolbar">
    <h1>Library map</h1>
    <input type="search" bind:value={query} placeholder="Find an asset" aria-label="Find an asset" />
    {#if query || lens}<span class="muted small" role="status">{matches.length} of {graph?.count ?? 0}</span>{/if}
    <span class="grow"></span>
    <label
      >Colour<select bind:value={colourBy} onchange={() => (hidden = [])}
        ><option value="family">Type</option><option value="bundle">Bundle</option><option value="use">Use</option
        ></select
      ></label
    >
    <label
      >Arrange<select
        value={arrange}
        onchange={(event) => setArrange(event.currentTarget.value as "meaning" | "bundle")}
        ><option value="meaning" disabled={!graph?.meaning}>By meaning</option><option value="bundle">By bundle</option
        ></select
      ></label
    >
    <label
      >Highlight<select bind:value={lens}
        ><option value="">Nothing</option><option value="never">Never shown</option><option value="outdated"
          >Superseded or contradicted</option
        ></select
      ></label
    >
    <div class="chart-views" role="group" aria-label="Map view">
      <button class="btn-quiet" aria-pressed={shown === "map"} onclick={() => (shown = "map")}>Map</button><button
        class="btn-quiet"
        aria-pressed={shown === "table"}
        onclick={() => (shown = "table")}>Table</button
      >
    </div>
  </div>
  {#if error}<div class="notice notice-warn" role="alert">
      {error}<button class="btn-secondary" onclick={load}>Retry</button>
    </div>{/if}
  {#if graph === null && !error}<p class="muted" role="status">{note || "Loading the library…"}</p>{/if}
  {#if graph}
    <div class="map-body">
      <div class="map-stage" hidden={shown !== "map"}>
        {#if data}<GraphView
            {data}
            label={`Map of ${graph.count} assets and their links. Arrow keys turn or pan it, plus and minus zoom; Table lists the same assets.`}
            onReady={ready}
            onTheme={readTokens}
          />{/if}
        <div class="map-legend">
          {#if colourBy === "use"}<h3>Times shown to an agent</h3>
            <div class="ramp" aria-hidden="true"></div>
            <p class="muted small">Grey: never shown.</p>
          {:else}<h3>{colourBy === "family" ? "Asset type" : "Bundle"}</h3>
            <ul>
              {#each legend as row}<li>
                  <button
                    aria-pressed={!hidden.includes(row.slot)}
                    title="Show or hide. Alt-click shows only this group."
                    onclick={(event) => toggleGroup(row.slot, event.altKey)}
                    ><span class="swatch" style={`background:var(--map-${row.slot + 1})`}></span>{row.label}<span
                      class="count">{row.count}</span
                    ></button
                  >
                </li>{/each}
            </ul>{/if}
          <p class="muted small">Size is how often an asset is shown.</p>
          {#if arrange === "meaning" && unplaced}<p class="muted small">
              {unplaced} assets have no stored embedding and are not on this arrangement.
            </p>{/if}
        </div>
        <p class="map-hint muted small">Drag to turn · Shift-drag to pan · Scroll to zoom · Click an asset</p>
        {#if hover}<div class="map-tip" style={`left:${hover.x + 14}px;top:${hover.y + 14}px`}>
            <strong>{name(hover.i)}</strong>
            <span class="muted small"
              >{graph.types[graph.type[hover.i]!]} · {graph.bundles[graph.bundle[hover.i]!]} · shown {graph.shows[
                hover.i
              ]} times</span
            >
          </div>{/if}
      </div>
      {#if shown === "table"}<div class="table-wrap map-table">
          <table>
            <caption
              >{matches.length > 200 ? `The 200 most shown of ${matches.length} assets` : `${matches.length} assets`},
              most shown first</caption
            >
            <thead><tr><th>Asset</th><th>Type</th><th>Bundle</th><th>Shown</th><th>Links</th></tr></thead>
            <tbody
              >{#each matches.slice(0, 200) as i}<tr
                  ><th><a href={open(graph.ref[i]!)}>{name(i)}</a></th><td>{graph.types[graph.type[i]!]}</td><td
                    >{graph.bundles[graph.bundle[i]!]}</td
                  ><td>{graph.shows[i]}</td><td>{graph.offsets[i + 1]! - graph.offsets[i]!}</td></tr
                >{/each}</tbody
            >
          </table>
        </div>{/if}
      <aside class="map-side">
        <div class="map-stats">
          <div><strong>{graph.count}</strong><span>assets</span></div>
          <div><strong>{graph.from.length}</strong><span>links</span></div>
          {#if frameMs && shown === "map"}<div><strong>{frameMs}</strong><span>ms per frame</span></div>{/if}
        </div>
        {#if selected >= 0}<section aria-live="polite">
            <h2>{name(selected)}</h2>
            <p class="mono small wrap">{graph.ref[selected]}</p>
            <dl class="map-facts">
              <dt>Type</dt>
              <dd>{graph.types[graph.type[selected]!]}</dd>
              <dt>Bundle</dt>
              <dd>{graph.bundles[graph.bundle[selected]!]}</dd>
              <dt>Shown</dt>
              <dd>{graph.shows[selected]} times</dd>
              <dt>In results</dt>
              <dd>{graph.searches[selected]} searches</dd>
            </dl>
            <p class="actions">
              <a class="btn-secondary" href={open(graph.ref[selected]!)}>Open in Library</a><button
                class="btn-quiet"
                onclick={() => select(-1)}>Clear</button
              >
            </p>
            {#each detail as group}<h3>{group.outgoing ? "Links to" : "Linked from"} · {linkLabel(group.kind)}</h3>
              <ul class="map-links">
                {#each group.nodes.slice(0, 12) as n}<li>
                    <button class="btn-quiet" onclick={() => select(n)}>{name(n)}</button>
                  </li>{/each}
              </ul>
              {#if group.nodes.length > 12}<p class="muted small">and {group.nodes.length - 12} more</p>{/if}
            {:else}<p class="muted small">No recorded links.</p>{/each}
          </section>{:else}<section>
            <h2>Most shown</h2>
            <ul class="map-links">
              {#each matches.slice(0, 8) as i}<li>
                  <button class="btn-quiet" onclick={() => select(i)}>{name(i)}</button><span class="muted small"
                    >{graph.shows[i]}</span
                  >
                </li>{/each}
            </ul>
            <p class="muted small">{note}</p>
          </section>{/if}
        <section>
          <h3>Link kinds</h3>
          {#each kindCounts as row}<label class="kind"
              ><input
                type="checkbox"
                checked={!kindsOff.includes(row.k)}
                onchange={() => toggleKind(row.k)}
              />{row.label}<span class="count">{row.count}</span></label
            >{:else}<p class="muted small">No links between indexed assets.</p>{/each}
        </section>
      </aside>
    </div>
  {/if}
</div>

<style>
  .library-views {
    display: flex;
    gap: 24px;
    padding: 0 24px;
    border-bottom: 1px solid var(--border);
    min-height: 44px;
  }
  .library-views a {
    display: flex;
    align-items: center;
    border-bottom: 2px solid transparent;
    color: var(--muted);
    text-decoration: none;
    font-size: 13px;
  }
  .library-views a[aria-current] {
    color: var(--accent);
    border-color: var(--accent);
    font-weight: 600;
  }
  .map-page {
    padding: 16px 24px 24px;
  }
  .map-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 12px 16px;
    align-items: end;
    margin-bottom: 12px;
  }
  .map-toolbar h1 {
    margin: 0;
  }
  .map-toolbar label {
    display: grid;
    gap: 4px;
    font-size: 12px;
    color: var(--muted);
  }
  .grow {
    flex: 1;
  }
  .chart-views {
    display: flex;
    gap: 4px;
  }
  .chart-views button[aria-pressed="true"] {
    color: var(--text);
    background: var(--surface-2);
  }
  .map-body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 20rem;
    gap: 16px;
    block-size: min(72vh, 860px);
    min-block-size: 420px;
  }
  .map-stage {
    position: relative;
    border: 1px solid var(--border);
    background: var(--bg);
    min-inline-size: 0;
  }
  .map-stage[hidden] {
    display: none;
  }
  .map-table {
    overflow: auto;
    min-inline-size: 0;
  }
  .map-legend {
    position: absolute;
    inset-block-start: 12px;
    inset-inline-start: 12px;
    max-block-size: calc(100% - 64px);
    overflow: auto;
    inline-size: 15rem;
    padding: 10px 12px;
    background: color-mix(in srgb, var(--surface) 88%, transparent);
    border: 1px solid var(--border);
  }
  .map-legend h3,
  .map-side h3 {
    font-size: 12px;
    color: var(--muted);
    margin: 0 0 6px;
  }
  .map-legend ul,
  .map-links {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .map-legend button {
    display: flex;
    gap: 8px;
    align-items: center;
    inline-size: 100%;
    border: 0;
    background: none;
    padding: 2px 4px;
    text-align: start;
    font-size: 13px;
    color: var(--text);
    min-block-size: 24px;
  }
  .map-legend button[aria-pressed="false"] {
    opacity: 0.45;
  }
  .swatch {
    inline-size: 10px;
    block-size: 10px;
    border-radius: 50%;
    flex: none;
  }
  .count {
    margin-inline-start: auto;
    color: var(--muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .ramp {
    block-size: 10px;
    background: linear-gradient(90deg, var(--surface-2), var(--map-1));
  }
  .map-hint {
    position: absolute;
    inset-block-end: 8px;
    inset-inline-start: 12px;
    margin: 0;
    padding: 4px 8px;
    background: color-mix(in srgb, var(--surface) 88%, transparent);
  }
  .map-tip {
    position: absolute;
    z-index: 2;
    pointer-events: none;
    display: grid;
    gap: 2px;
    max-inline-size: 22rem;
    padding: 6px 10px;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    box-shadow: var(--shadow-float);
    font-size: 13px;
  }
  .map-side {
    overflow: auto;
    display: grid;
    align-content: start;
    gap: 16px;
    min-inline-size: 0;
  }
  .map-side h2 {
    font-size: 1rem;
    margin: 0;
    overflow-wrap: anywhere;
  }
  .map-stats {
    display: flex;
    gap: 20px;
  }
  .map-stats div {
    display: grid;
  }
  .map-stats strong {
    font-size: 1.25rem;
    font-variant-numeric: tabular-nums;
  }
  .map-stats span {
    font-size: 12px;
    color: var(--muted);
  }
  .map-facts {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 12px;
    font-size: 13px;
    margin: 8px 0;
  }
  .map-facts dt {
    color: var(--muted);
  }
  .map-facts dd {
    margin: 0;
  }
  .actions {
    display: flex;
    gap: 8px;
  }
  .map-links li {
    display: flex;
    align-items: baseline;
    gap: 8px;
    border-bottom: 1px solid var(--border);
  }
  .map-links button {
    text-align: start;
    overflow-wrap: anywhere;
    color: var(--link);
  }
  .kind {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 13px;
  }
  @media (max-width: 900px) {
    .map-body {
      grid-template-columns: 1fr;
      block-size: auto;
    }
    .map-stage {
      block-size: 60vh;
    }
  }
</style>
