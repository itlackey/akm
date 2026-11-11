<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { onDestroy } from "svelte";
  import { api } from "./client";
  import GraphView from "./GraphView.svelte";
  import { buildGraph, edgePairs, type GraphPayload, type LibraryGraph } from "./graph-model";
  import { replayBins, replaySteps, type ReplayStep, totalsAt, type UsageEventRow } from "./replay-model";

  // biome-ignore lint/suspicious/noExplicitAny: the renderer is untyped presentation code.
  type View = any;
  let period = $state<"24h" | "7d">("24h");
  let graph = $state.raw<LibraryGraph | null>(null);
  let steps = $state.raw<ReplayStep[]>([]);
  let range = $state<{ since: string; until: string } | null>(null);
  let truncated = $state(false);
  let error = $state("");
  let loading = $state(true);
  let data: Record<string, unknown> | null = $state.raw(null);
  let clock = $state(0);
  let playing = $state(false);
  let speed = $state(1);
  let view: View;
  let colours: Uint8Array;
  let lit: Float32Array;
  let litState: Uint8Array;
  let used: Uint8Array;
  let cursor = 0;
  let ink: Record<string, number[]> = {};
  let slots: number[][] = [];
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const start = $derived(range ? Date.parse(range.since) : 0);
  const end = $derived(range ? Date.parse(range.until) : 0);
  const bins = $derived(replayBins(steps, start, end));
  const totals = $derived(totalsAt(steps, clock));
  const recent = $derived.by(() => {
    const out: ReplayStep[] = [];
    for (let i = steps.length - 1; i >= 0 && out.length < 8; i--)
      if (steps[i]!.t <= clock && steps[i]!.kind !== "hit") out.push(steps[i]!);
    return out;
  });

  async function load() {
    loading = true;
    error = "";
    pause();
    try {
      const [payload, events] = await Promise.all([
        api<GraphPayload>("/graph"),
        api<{ window: { since: string; until: string }; truncated: boolean; events: UsageEventRow[] }>("/events", {
          since: period,
        }),
      ]);
      const built = buildGraph(payload);
      steps = replaySteps(events.events, built.index);
      range = events.window;
      truncated = events.truncated;
      colours = new Uint8Array(built.count * 4);
      lit = new Float32Array(built.count);
      litState = new Uint8Array(built.count).fill(1);
      used = new Uint8Array(built.count);
      if (!data || !graph || graph.count !== built.count) {
        const meaning = built.meaning;
        data = {
          count: built.count,
          pos: Float32Array.from(meaning ?? built.byBundle),
          color: colours,
          size: built.size,
          edges: edgePairs(built, () => true),
          anchors: [],
          label: (i: number) => built.name(i),
        };
      }
      graph = built;
      seek(reduced ? Date.parse(events.window.until) : Date.parse(events.window.since));
    } catch (cause) {
      error = (cause as Error).message;
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    void period;
    void load();
  });

  function readTokens(read: (token: string) => number[]) {
    slots = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => read(`--map-${n}`));
    ink = { shown: read("--map-1"), positive: read("--ok"), negative: read("--fail"), dim: read("--border-strong") };
    if (view) paint();
  }
  function paint() {
    if (!graph || !view) return;
    for (let i = 0; i < graph.count; i++) {
      colours.set(used[i] ? slots[graph.family[i]!]! : ink.dim!, i * 4);
      colours[i * 4 + 3] = used[i] ? 240 : 70;
    }
    view.setColors(colours);
  }

  /** Move to `t`: the totals and the lit assets are recomputed; nothing animates. */
  function seek(t: number) {
    clock = Math.max(start, Math.min(end, t));
    if (!graph) return;
    used.fill(0);
    lit.fill(0);
    litState.fill(1);
    for (cursor = 0; cursor < steps.length && steps[cursor]!.t <= clock; cursor++) {
      const step = steps[cursor]!;
      if (step.node >= 0 && step.kind !== "hit") used[step.node] = 1;
    }
    if (view) {
      view.particles = [];
      view.setState(litState);
      paint();
    }
  }

  /** An emitter per actor, on a ring above the map, so each pulse shows who made it. */
  function emitter(actor: string): number[] {
    const at = Math.max(0, bins.actors.indexOf(actor));
    const angle = (at / Math.max(1, bins.actors.length)) * Math.PI * 2;
    const reach = graph?.meaning ? 1100 : 1500;
    return [Math.cos(angle) * reach, 420, Math.sin(angle) * reach];
  }
  function apply(step: ReplayStep) {
    if (step.node < 0 || !view) return;
    lit[step.node] = 1;
    litState[step.node] = 2;
    if (step.kind === "hit") return;
    if (!used[step.node]) {
      used[step.node] = 1;
      colours.set(slots[graph!.family[step.node]!]!, step.node * 4);
      colours[step.node * 4 + 3] = 240;
      view.setColors(colours);
    }
    const colour =
      step.kind === "feedback"
        ? step.signal === "negative"
          ? ink.negative
          : ink.positive
        : step.kind === "show"
          ? ink.shown
          : null;
    if (colour && view.particles.length < 600)
      view.particles.push({
        fromPos: emitter(step.actor),
        to: step.node,
        t: 0,
        color: colour,
        size: step.kind === "feedback" ? 20 : 14,
        arc: 120,
      });
  }

  function ready(next: View) {
    view = next;
    view.autoRotate = false;
    let reach = 0;
    const pos = (data as { pos: Float32Array }).pos;
    for (let n = 0; n < pos.length; n += 3) reach = Math.max(reach, Math.hypot(pos[n]!, pos[n + 2]!));
    view.goal.dist = view.cam.dist = Math.max(300, reach * 2.8);
    view.edgeScale = 0.45;
    view.onFrame = (dt: number) => {
      const s = dt / 1000;
      for (const p of view.particles) p.t += s / 0.9;
      view.particles = view.particles.filter((p: { t: number }) => p.t < 1);
      let changed = false;
      for (let i = 0; i < lit.length; i++)
        if (lit[i]! > 0) {
          lit[i]! -= s / 1.6;
          if (lit[i]! <= 0) litState[i] = 1;
          changed = true;
        }
      if (playing) {
        // One played minute per real second at speed 1, so a day takes 24 minutes; speed multiplies it.
        clock = Math.min(end, clock + dt * 60 * speed * (period === "7d" ? 7 : 1));
        while (cursor < steps.length && steps[cursor]!.t <= clock) {
          apply(steps[cursor++]!);
          changed = true;
        }
        if (clock >= end) playing = false;
      }
      if (changed) view.setState(litState);
    };
    paint();
  }

  function play() {
    if (clock >= end) seek(start);
    playing = true;
  }
  function pause() {
    playing = false;
  }
  const hhmm = (t: number) =>
    new Date(t).toLocaleString(
      undefined,
      period === "7d"
        ? { weekday: "short", hour: "2-digit", minute: "2-digit" }
        : { hour: "2-digit", minute: "2-digit" },
    );
  const describe = (step: ReplayStep) =>
    step.kind === "search"
      ? step.results === 0
        ? `searched “${step.query ?? ""}”, found nothing`
        : `searched “${step.query ?? ""}”${step.results === undefined ? "" : `, ${step.results} result${step.results === 1 ? "" : "s"}`}`
      : step.kind === "show"
        ? `read ${step.ref ?? "an asset"}`
        : step.kind === "feedback"
          ? `${step.signal ?? ""} feedback on ${step.ref ?? "an asset"}`
          : `${step.ref ?? ""}`;
  onDestroy(() => {
    playing = false;
    view = null;
  });
</script>

<section class="replay" aria-label="Activity replay">
  <div class="replay-toolbar">
    <p class="muted small">
      Searches, reads and feedback, played over the library map. Each row of the timeline is who made them: the agent
      harness when akm recorded it, else the event's source.
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
        disabled={!steps.length}>Play</button
      >{/if}
    <label
      >Speed<select bind:value={speed}
        ><option value={1}>Normal</option><option value={4}>Fast</option><option value={16}>Fastest</option></select
      ></label
    >
  </div>
  {#if error}<div class="notice notice-warn" role="alert">
      {error}<button class="btn-secondary" onclick={load}>Retry</button>
    </div>{/if}
  {#if loading && !graph}<p class="muted" role="status">Loading activity…</p>{/if}
  {#if graph && range}
    <div class="replay-body">
      <div class="replay-map">
        {#if data}<GraphView
            {data}
            label="The library map. Assets light up as they are searched, read and given feedback. The panel beside it lists the same events."
            onReady={ready}
            onTheme={readTokens}
          />{/if}
        <ul class="replay-key">
          <li><span class="dot" style="background:var(--map-1)"></span>Asset read</li>
          <li><span class="dot" style="background:var(--ok)"></span>Positive feedback</li>
          <li><span class="dot" style="background:var(--fail)"></span>Negative feedback</li>
          <li class="muted">Assets stay lit once used in the period.</li>
        </ul>
      </div>
      <aside class="replay-side">
        <div class="replay-stats">
          <div><strong>{totals.searches}</strong><span>searches</span></div>
          <div><strong>{totals.foundNothing}</strong><span>found nothing</span></div>
          <div><strong>{totals.shows}</strong><span>reads</span></div>
          <div><strong>{totals.used.size}</strong><span>assets used</span></div>
          <div><strong>{totals.positive}</strong><span>positive</span></div>
          <div><strong>{totals.negative}</strong><span>negative</span></div>
        </div>
        <section>
          <h3>Latest at {hhmm(clock)}</h3>
          <ol class="ticker">
            {#each recent as step}<li>
                <span class="muted small">{hhmm(step.t)}</span> <span class="who">{step.actor}</span>
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
        {#if truncated}<p class="muted small">
            This period held more than 20,000 events; the replay has the first 20,000.
          </p>{/if}
      </aside>
    </div>
    <div class="replay-timeline">
      <label class="scrub"
        ><span class="sr-only">Time</span><input
          type="range"
          min={start}
          max={end}
          step={60000}
          value={clock}
          aria-valuetext={hhmm(clock)}
          oninput={(event) => seek(Number(event.currentTarget.value))}
        /></label
      >
      <table class="lanes">
        <caption class="sr-only">Events per period slice, by who made them</caption>
        <tbody>
          {#each bins.actors as actor}{@const counts = bins.counts.get(actor) ?? []}{@const max = Math.max(
              1,
              ...counts,
            )}<tr
              ><th scope="row">{actor}</th><td
                ><div class="bars" aria-label={`${counts.reduce((a, b) => a + b, 0)} events`}>
                  {#each counts as n, b}<span
                      class:played={start + (b + 1) * bins.width <= clock}
                      style={`block-size:${n ? Math.max(8, (n / max) * 100) : 0}%`}
                    ></span>{/each}
                </div></td
              ></tr
            >{/each}
          <tr class="misses"
            ><th scope="row">Found nothing</th><td
              ><div class="bars">
                {#each bins.misses as n, b}<span
                    class:played={start + (b + 1) * bins.width <= clock}
                    style={`block-size:${n ? Math.max(8, (n / Math.max(1, ...bins.misses)) * 100) : 0}%`}
                  ></span>{/each}
              </div></td
            ></tr
          >
        </tbody>
      </table>
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
    block-size: min(60vh, 680px);
    min-block-size: 380px;
  }
  .replay-map {
    position: relative;
    border: 1px solid var(--border);
    min-inline-size: 0;
  }
  .replay-key {
    position: absolute;
    inset-block-start: 10px;
    inset-inline-start: 10px;
    list-style: none;
    margin: 0;
    padding: 8px 10px;
    font-size: 13px;
    background: color-mix(in srgb, var(--surface) 88%, transparent);
    border: 1px solid var(--border);
  }
  .replay-key li {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .dot {
    inline-size: 10px;
    block-size: 10px;
    border-radius: 50%;
  }
  .replay-side {
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
  .scrub input {
    inline-size: calc(100% - 11rem);
    margin-inline-start: 11rem;
    accent-color: var(--accent);
  }
  .lanes {
    inline-size: 100%;
    border-collapse: collapse;
  }
  .lanes th {
    inline-size: 11rem;
    text-align: start;
    font-weight: 500;
    font-size: 13px;
    padding: 2px 8px 2px 0;
  }
  .lanes .misses th {
    color: var(--fail);
  }
  .bars {
    display: flex;
    align-items: end;
    gap: 1px;
    block-size: 26px;
    border-bottom: 1px solid var(--border);
  }
  .bars span {
    flex: 1;
    background: var(--text);
    opacity: 0.3;
  }
  .bars span.played {
    opacity: 0.85;
  }
  .misses .bars span {
    background: var(--fail);
  }
  @media (max-width: 900px) {
    .replay-body {
      grid-template-columns: 1fr;
      block-size: auto;
    }
    .replay-map {
      block-size: 50vh;
    }
  }
</style>
