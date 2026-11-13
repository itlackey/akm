<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { onDestroy } from "svelte";
  import { api } from "./client";
  import GraphView from "./GraphView.svelte";
  import {
    type Arrangement,
    buildGraph,
    edgePairs,
    type GraphPayload,
    type LibraryGraph,
    legendRows,
    openingArrangement,
  } from "./graph-model";
  import { searchHref } from "./library-model";
  import {
    advance,
    axisLabels,
    describe,
    emitterAt,
    emitterRing,
    MAX_PULSES,
    PULSE_PX,
    PULSE_SECONDS,
    PULSE_TOKENS,
    playText,
    pulseOf,
    replayBins,
    replaySteps,
    replayState,
    type ReplayStep,
    SCRUB_STEP,
    SPEEDS,
    scaleText,
    scrubTime,
    stampText,
    totalsAt,
    truncationNote,
    type UsageEventRow,
    undrawn,
    undrawnText,
    usedList,
  } from "./replay-model";

  // biome-ignore lint/suspicious/noExplicitAny: the renderer is untyped presentation code.
  type View = any;
  let period = $state<"24h" | "7d">("24h");
  let graph = $state.raw<LibraryGraph | null>(null);
  let arrange = $state<Arrangement>("bundle");
  let steps = $state.raw<ReplayStep[]>([]);
  let range = $state<{ since: string; until: string } | null>(null);
  let truncated = $state(false);
  /** What the server said when it has nothing to replay: no index, or no usage history. */
  let unavailable = $state("");
  let error = $state("");
  let loading = $state(true);
  let data: Record<string, unknown> | null = $state.raw(null);
  /** The replay opens at the end of the period, with every figure full. */
  let clock = $state(0);
  let playing = $state(false);
  let speed = $state(1);
  let view: View;
  let colours: Uint8Array;
  let used: Uint8Array;
  let drawn: Uint8Array;
  let cursor = 0;
  let positions: Float32Array;
  let ring = emitterRing([], []);
  let unusedInk: number[] = [];
  let slots: number[][] = [];
  let pulseInk: Record<string, number[]> = {};
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const start = $derived(range ? Date.parse(range.since) : 0);
  const end = $derived(range ? Date.parse(range.until) : 0);
  const span = $derived(end - start);
  const bins = $derived(replayBins(steps, start, end));
  const totals = $derived(totalsAt(steps, clock));
  const axis = $derived(axisLabels(start, end));
  const mostUsed = $derived(usedList(steps, clock, 8));
  const notDrawn = $derived(graph ? undrawnText(undrawn(steps, graph, arrange), arrange) : "");
  const cutNote = $derived(truncationNote(truncated, steps[0]?.t));
  const types = $derived(graph ? legendRows(graph, "family") : []);
  const recent = $derived.by(() => {
    const out: ReplayStep[] = [];
    for (let i = steps.length - 1; i >= 0 && out.length < 8; i--)
      if (steps[i]!.t <= clock && steps[i]!.kind !== "hit") out.push(steps[i]!);
    return out;
  });

  /** The map is drawn once, from the library as the page first read it; a new Period reads only the events. */
  let graphOnce: Promise<LibraryGraph | null> | null = null;
  /** A new graph gets a new renderer: its buffers are sized and ordered for the graph it was made with. */
  let mapKey = $state(0);
  async function readGraph(): Promise<LibraryGraph | null> {
    const payload = await api<GraphPayload>("/graph");
    if (!payload.available) {
      unavailable = payload.note;
      return null;
    }
    const built = buildGraph(payload);
    arrange = openingArrangement(built);
    positions = Float32Array.from(arrange === "meaning" ? built.meaning! : built.byBundle);
    colours = new Uint8Array(built.count * 4);
    used = new Uint8Array(built.count);
    drawn = replayState(built, arrange, used);
    data = {
      count: built.count,
      pos: positions,
      color: colours,
      // Size means reads in the map; here every asset is the same size, so only the ring says "used".
      size: new Float32Array(built.count),
      edges: edgePairs(built, () => true),
      anchors: arrange === "bundle" ? built.bundleAnchors : [],
      label: (i: number) => built.name(i),
    };
    view = null;
    mapKey++;
    graph = built;
    return built;
  }

  /** The latest load: a response to an earlier one (an earlier Period) changes nothing. */
  let generation = 0;
  async function load() {
    const mine = ++generation;
    loading = true;
    error = "";
    pause();
    try {
      graphOnce ??= readGraph();
      const [built, events] = await Promise.all([
        graphOnce,
        api<{
          available: boolean;
          window: { since: string; until: string };
          truncated: boolean;
          events: UsageEventRow[];
        }>("/events", { since: period }),
      ]);
      if (mine !== generation) return;
      if (!built) return;
      unavailable =
        events.available === false ? "Usage events are not recorded here yet, so there is nothing to replay." : "";
      steps = replaySteps(events.events, built.index);
      range = events.window;
      truncated = events.truncated;
      seek(Date.parse(events.window.until));
    } catch (cause) {
      graphOnce = null;
      if (mine === generation) error = (cause as Error).message;
    } finally {
      if (mine === generation) loading = false;
    }
  }
  $effect(() => {
    void period;
    void load();
  });

  function readTokens(read: (token: string) => number[]) {
    slots = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => read(`--map-${n}`));
    unusedInk = read("--use-0");
    pulseInk = Object.fromEntries(Object.entries(PULSE_TOKENS).map(([kind, token]) => [kind, read(token)]));
    if (view) paint();
  }
  /** Used assets in their type's colour (and ringed by their state), the rest in the quietest mark. */
  function paint() {
    if (!graph || !view) return;
    for (let i = 0; i < graph.count; i++) {
      colours.set(used[i] ? slots[graph.family[i]!]! : unusedInk, i * 4);
      colours[i * 4 + 3] = 255;
    }
    view.setColors(colours);
  }
  function refresh() {
    if (!graph || !view) return;
    drawn = replayState(graph, arrange, used);
    view.setState(drawn);
    paint();
  }

  /** Move to `t`: the totals and the used assets are recomputed; nothing animates. */
  function seek(t: number) {
    clock = Math.max(start, Math.min(end, t));
    if (!graph) return;
    used.fill(0);
    for (cursor = 0; cursor < steps.length && steps[cursor]!.t <= clock; cursor++) {
      const step = steps[cursor]!;
      if (step.node >= 0 && step.kind !== "hit") used[step.node] = 1;
    }
    if (view) {
      view.particles = [];
      view.animating = false;
      refresh();
    }
  }

  /** Play one event on the map; true when it made an asset used for the first time. */
  function apply(step: ReplayStep): boolean {
    if (step.node < 0 || !graph || drawn[step.node] === 3) return false;
    const first = step.kind !== "hit" && !used[step.node];
    if (step.kind !== "hit") used[step.node] = 1;
    const pulse = pulseOf(step);
    // Reduced motion: no pulses, state changes snap.
    if (pulse && view && !reduced && view.particles.length < MAX_PULSES) {
      const at = Math.max(0, bins.actors.indexOf(step.actor));
      view.particles.push({
        fromPos: emitterAt(ring, at, bins.actors.length),
        to: step.node,
        t: 0,
        color: pulseInk[pulse.kind],
        size: pulse.size,
        arc: ring.arc,
      });
      view.animating = true;
      view.invalidate();
    }
    return first;
  }

  function ready(next: View) {
    view = next;
    view.autoRotate = false;
    if (arrange === "bundle") view.setFlat(true);
    view.edgeScale = 0.45;
    refresh();
    // Frame the drawn points, and open already framed rather than flying in from the default camera.
    view.fit();
    view.cam.dist = view.goal.dist;
    Object.assign(view.cam, { tx: view.goal.tx, ty: view.goal.ty, tz: view.goal.tz });
    ring = emitterRing(positions, drawn);
    view.onFrame = (dt: number) => {
      for (const p of view.particles) p.t += dt / 1000 / PULSE_SECONDS;
      view.particles = view.particles.filter((p: { t: number }) => p.t < 1);
      if (!view.particles.length) view.animating = false;
    };
    view.animating = false;
    seek(clock);
  }

  // The clock has its own frames, so playback works without WebGL: the figures, ticker and timeline still move.
  let ticking = 0;
  let lastTick = 0;
  function tick(now: number) {
    const dt = Math.min(64, now - lastTick);
    lastTick = now;
    clock = advance(clock, dt, start, end, speed);
    let lit = false;
    while (cursor < steps.length && steps[cursor]!.t <= clock) lit = apply(steps[cursor++]!) || lit;
    if (lit) refresh();
    if (clock >= end) playing = false;
    ticking = playing ? requestAnimationFrame(tick) : 0;
  }
  /** Play always starts from the beginning when the clock is at the end, which is where the replay opens. */
  function play() {
    if (clock >= end) seek(start);
    playing = true;
    cancelAnimationFrame(ticking);
    lastTick = performance.now();
    ticking = requestAnimationFrame(tick);
  }
  function pause() {
    playing = false;
    cancelAnimationFrame(ticking);
  }
  onDestroy(() => {
    pause();
    view = null;
  });
</script>

<section class="replay" aria-label="Activity replay" aria-busy={loading}>
  <div class="replay-toolbar">
    <p class="muted small">
      Searches, reads and feedback, played over the library map. Each row of the timeline is who made them: the agent
      harness when akm recorded it, else the event's source. Every source is shown, including scheduled tasks and
      Improve.
    </p>
    <span class="grow"></span>
    <label
      >Period<select bind:value={period}
        ><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option></select
      ></label
    >
    {#if playing}<button class="btn-secondary" onclick={pause}>Pause</button>{:else}<button
        class="btn-secondary"
        onclick={play}
        disabled={!steps.length || loading}>Play</button
      >{/if}
    <label
      >Speed<select bind:value={speed}
        >{#each SPEEDS as option}<option value={option.value}>{option.label}</option>{/each}</select
      ></label
    >
  </div>
  <p class="muted small play-time">
    {playText(speed)}. It opens at the end of the period, with every figure full; Play starts again from the beginning.
  </p>
  {#if error}<div class="notice notice-warn" role="alert">
      {error}<button
        class="btn-secondary"
        onclick={() => {
          graphOnce = null;
          void load();
        }}>Retry</button
      >
    </div>{/if}
  {#if loading}<p class="muted" role="status">{graph ? "Loading events…" : "Loading activity…"}</p>{/if}
  {#if unavailable && !loading}<div class="notice" role="status">{unavailable}</div>{/if}
  {#if graph && range && !unavailable}
    <div class="replay-body">
      <div class="replay-left">
        <div class="replay-map">
          {#if data}{#key mapKey}<GraphView
                {data}
                label="The library map. Assets used so far in the period are ringed and in colour; pulses fly to an asset as it is searched, read and given feedback. The panel beside it lists the same events."
                onReady={ready}
                onTheme={readTokens}
                fallback="This view needs WebGL 2, which this window does not have. The figures, the latest events and the timeline below still play."
              />{/key}{/if}
        </div>
        <ul class="replay-key" aria-label="Key">
          <li>
            <span class="mark used" style="--core: var(--map-1)"></span>Used so far in this period: ringed, in its
            type's colour
          </li>
          <li><span class="mark unused"></span>Not used yet: faint</li>
          <li class="pulses-title muted">Pulses fly to an asset when:</li>
          <li>
            <span
              class="dot"
              style={`background:var(--pulse-read);inline-size:${PULSE_PX.read}px;block-size:${PULSE_PX.read}px`}
            ></span>it is read
          </li>
          <li>
            <span
              class="dot"
              style={`background:var(--pulse-hit);inline-size:${PULSE_PX.hit}px;block-size:${PULSE_PX.hit}px`}
            ></span>a search returns it (a hit: it does not count as used)
          </li>
          <li>
            <span
              class="dot"
              style={`background:var(--pulse-up);inline-size:${PULSE_PX.feedback}px;block-size:${PULSE_PX.feedback}px`}
            ></span>it gets positive feedback
          </li>
          <li>
            <span
              class="dot"
              style={`background:var(--pulse-down);inline-size:${PULSE_PX.feedback}px;block-size:${PULSE_PX.feedback}px`}
            ></span>it gets negative feedback
          </li>
          <li class="muted small">
            Every point is the same size. Other events (curate and the like) have no pulse; the latest list names them.
          </li>
          <li class="types muted small">
            Type colours:
            {#each types as row}<span class="type"
                ><span class="dot" style={`background:var(--map-${row.slot + 1})`}></span>{row.label}</span
              >{/each}
          </li>
        </ul>
      </div>
      <aside class="replay-side">
        <div class="replay-stats">
          <div><strong>{totals.searches}</strong><span>searches</span></div>
          <div><strong>{totals.foundNothing}</strong><span>found nothing</span></div>
          <div><strong>{totals.shows}</strong><span>reads</span></div>
          <div><strong>{totals.positive}</strong><span>positive</span></div>
          <div><strong>{totals.negative}</strong><span>negative</span></div>
          <div><strong>{totals.others}</strong><span>other events</span></div>
          <div><strong>{totals.used.size}</strong><span>assets used</span></div>
          <div><strong>{totals.events}</strong><span>events in all</span></div>
        </div>
        {#if notDrawn}<p class="muted small">{notDrawn}</p>{/if}
        <section>
          <h3>Used in this period</h3>
          <ol class="ticker">
            {#each mostUsed as row}<li>
                <a href={searchHref(new URLSearchParams(), row.ref)}>{graph.name(row.node)}</a>
                <span class="muted small">×{row.count}</span>
              </li>{:else}<li class="muted">Nothing yet</li>{/each}
          </ol>
          <p class="muted small">The eight assets with the most events so far; search hits are not counted.</p>
        </section>
        <section>
          <h3>Latest at {stampText(clock, span)}</h3>
          <ol class="ticker">
            {#each recent as step}<li>
                <span class="muted small">{stampText(step.t, span)}</span> <span class="who">{step.actor}</span>
                {describe(step)}
              </li>{:else}<li class="muted">Nothing yet</li>{/each}
          </ol>
        </section>
        <section>
          <h3>Searches that found nothing</h3>
          <ul class="ticker">
            {#each totals.misses.slice(0, 6) as [query, count]}<li>
                {query} <span class="muted small">×{count}</span>
              </li>{:else}<li class="muted">None so far</li>{/each}
          </ul>
        </section>
        {#if cutNote}<p class="muted small">{cutNote}</p>{/if}
      </aside>
    </div>

    <div class="replay-timeline">
      <table class="lanes">
        <caption class="sr-only">Events per period slice, by who made them, busiest first</caption>
        <tbody>
          <tr class="scrub"
            ><th scope="row">Time</th><td
              ><input
                type="range"
                min={start}
                max={end}
                step={SCRUB_STEP}
                value={clock}
                aria-label="Time"
                aria-valuetext={stampText(clock, span)}
                oninput={(event) => seek(scrubTime(Number(event.currentTarget.value), start, end))}
              /></td
            ></tr
          >
          {#each bins.actors as actor}{@const counts = bins.counts.get(actor) ?? []}<tr
              ><th scope="row"
                ><span class="lane-name">{actor}</span><span class="muted small"
                  >{bins.totals.get(actor)} event{bins.totals.get(actor) === 1 ? "" : "s"}</span
                ></th
              ><td
                ><div class="bars">
                  {#each counts as n, b}<span
                      class:has={n > 0}
                      class:played={start + (b + 1) * bins.width <= clock}
                      style={`block-size:${(n / bins.max) * 100}%`}
                    ></span>{/each}
                </div></td
              ></tr
            >{/each}
          <tr class="misses"
            ><th scope="row"
              ><span class="lane-name">Found nothing</span><span class="muted small"
                >{bins.missTotal} search{bins.missTotal === 1 ? "" : "es"}</span
              ></th
            ><td
              ><div class="bars">
                {#each bins.misses as n, b}<span
                    class:has={n > 0}
                    class:played={start + (b + 1) * bins.width <= clock}
                    style={`block-size:${(n / bins.max) * 100}%`}
                  ></span>{/each}
              </div></td
            ></tr
          >
          <tr class="axis"
            ><th scope="row"><span class="sr-only">Time axis</span></th><td
              ><div class="ticks"><span>{axis[0]}</span><span>{axis[1]}</span><span>{axis[2]}</span></div></td
            ></tr
          >
        </tbody>
      </table>
      <p class="muted small">
        {scaleText(bins.max, bins.width)}; every lane uses that scale. Lanes run from the most events to the fewest,
        ties by name.
      </p>
      {#if !steps.length}<p>No searches, reads or feedback recorded in this period.</p>{/if}
    </div>
  {/if}
</section>

<style>
  .replay-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 12px 16px;
    align-items: end;
    margin-bottom: 12px;
  }
  .replay-toolbar p {
    max-inline-size: 40rem;
    margin: 0;
  }
  .replay-toolbar label {
    display: grid;
    gap: 4px;
    font-size: 12px;
    color: var(--muted);
  }
  .grow {
    flex: 1;
  }
  .replay-body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 20rem;
    gap: 16px;
    align-items: start;
  }
  .replay-map {
    position: relative;
    border: 1px solid var(--border);
    min-inline-size: 0;
    block-size: min(60vh, 680px);
    min-block-size: 380px;
  }
  .replay-key {
    list-style: none;
    margin: 8px 0 0;
    padding: 8px 10px;
    font-size: 13px;
    border: 1px solid var(--border);
    display: flex;
    flex-wrap: wrap;
    gap: 6px 18px;
    align-items: center;
  }
  .replay-key li {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .replay-key .types {
    flex-basis: 100%;
    flex-wrap: wrap;
    gap: 4px 14px;
  }
  .type {
    display: inline-flex;
    gap: 5px;
    align-items: center;
  }
  .dot {
    flex: none;
    inline-size: 10px;
    block-size: 10px;
    border-radius: 50%;
  }
  /* The two marks on the map: a used asset is a coloured point inside a ring, an unused one a faint point. */
  .mark {
    flex: none;
    inline-size: 10px;
    block-size: 10px;
    border-radius: 50%;
  }
  .mark.used {
    background: var(--core);
    outline: 1.5px solid var(--text);
    outline-offset: 1px;
    margin: 3px;
  }
  .mark.unused {
    background: var(--use-0);
    opacity: 0.4;
    margin: 3px;
  }
  .play-time {
    margin: 0 0 8px;
  }
  .replay-left {
    min-inline-size: 0;
  }
  .replay-side {
    max-block-size: min(85vh, 780px);
    overflow: auto;
    display: grid;
    align-content: start;
    gap: 16px;
    min-inline-size: 0;
  }
  .replay-side h3 {
    font-size: 12px;
    color: var(--muted);
    margin: 0 0 6px;
  }
  .replay-stats {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
  }
  .replay-stats div {
    display: grid;
  }
  .replay-stats strong {
    font-size: 1.25rem;
    font-variant-numeric: tabular-nums;
  }
  .replay-stats span {
    font-size: 12px;
    color: var(--muted);
  }
  .ticker {
    list-style: none;
    margin: 0;
    padding: 0;
    font-size: 13px;
  }
  .ticker li {
    padding: 3px 0;
    border-bottom: 1px solid var(--border);
    overflow-wrap: anywhere;
  }
  .who {
    font-weight: 600;
  }
  .replay-timeline {
    margin-top: 12px;
  }
  .lanes {
    inline-size: 100%;
    border-collapse: collapse;
    table-layout: fixed;
  }
  .lanes .scrub th,
  .lanes .scrub td {
    vertical-align: middle;
  }
  .lanes th {
    inline-size: 11rem;
    text-align: start;
    font-weight: 500;
    font-size: 13px;
    padding: 2px 8px 2px 0;
    vertical-align: bottom;
  }
  .lane-name {
    display: block;
    overflow-wrap: anywhere;
  }
  .lanes .misses th .lane-name {
    color: var(--fail);
  }
  .bars {
    display: flex;
    align-items: end;
    gap: 1px;
    block-size: 32px;
    border-bottom: 1px solid var(--border);
  }
  .bars span {
    flex: 1;
    min-block-size: 0;
    background: var(--text);
    opacity: 0.3;
  }
  /* A slice with events always shows at least a hairline: a single event is small but not nothing. */
  .bars span.has {
    min-block-size: 2px;
  }
  .bars span.played {
    opacity: 0.85;
  }
  .misses .bars span {
    background: var(--fail);
  }
  .ticks {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    font-size: 12px;
    color: var(--muted);
  }
  .ticks span:nth-child(2) {
    text-align: center;
  }
  .ticks span:nth-child(3) {
    text-align: end;
  }
  /* The slider's thumb centre runs from one end of the bars to the other: the track is one thumb wider than the bars. */
  .scrub input {
    appearance: none;
    background: transparent;
    inline-size: calc(100% + 16px);
    margin: 0 -8px;
    block-size: 16px;
    cursor: pointer;
  }
  .scrub input::-webkit-slider-runnable-track {
    block-size: 4px;
    background: var(--border-strong);
    border-radius: 2px;
  }
  .scrub input::-moz-range-track {
    block-size: 4px;
    background: var(--border-strong);
    border-radius: 2px;
  }
  .scrub input::-webkit-slider-thumb {
    appearance: none;
    inline-size: 16px;
    block-size: 16px;
    margin-block-start: -6px;
    border-radius: 50%;
    background: var(--accent);
    border: 0;
  }
  .scrub input::-moz-range-thumb {
    inline-size: 16px;
    block-size: 16px;
    border-radius: 50%;
    background: var(--accent);
    border: 0;
  }
  .scrub td {
    overflow: visible;
  }
  @media (max-width: 900px) {
    .replay-body {
      grid-template-columns: 1fr;
      block-size: auto;
    }
    .replay-map {
      block-size: 50vh;
    }
    .replay-side {
      max-block-size: none;
      overflow: visible;
    }
  }
</style>
