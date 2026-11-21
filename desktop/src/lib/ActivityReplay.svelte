<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script module lang="ts">
  /** The drawing chosen this session: the replay opens in it again, and in 2D until 3D is chosen. */
  let remembered: "2d" | "3d" = "2d";
  /** Whether the panel beside the map is open, kept the same way. */
  let sideRemembered = true;
</script>

<script lang="ts">
  // A period of searches, reads and feedback, played back: a timeline of events by kind with a playhead, the library
  // mind map lighting up the tags each event touches (or, in 3D, the library's assets as points on the same 3D map the
  // Library uses, ringed as events touch them), and the events as a log. It opens at the end of the period with
  // every figure full; clicking or dragging the timeline moves the playhead.
  import Icon from "./Icon.svelte";
  import { onDestroy } from "svelte";
  import { api } from "./client";
  import { FAMILIES } from "./graph-model";
  import { buildOverview, groupsOf, mindMap, type Overview, type OverviewPayload } from "./library-overview";
  import { searchHref } from "./library-model";
  import MindMap from "./MindMap.svelte";
  import SimilarityMap from "./SimilarityMap.svelte";
  import {
    advance,
    axisLabels,
    describe,
    KINDS,
    playText,
    kindBins,
    PULSES,
    pulsesAt,
    REPLAY_SECONDS,
    replaySteps,
    type ReplayStep,
    SCRUB_STEP,
    SPEEDS,
    scrubTime,
    stampText,
    stepsOf,
    totalsAt,
    truncationNote,
    type UsageEventRow,
    unplacedEvents,
    usedList,
  } from "./replay-model";

  /** The periods offered, each a duration `activity.events` takes as `since`. */
  const PERIODS = [
    ["1h", "Last hour"],
    ["6h", "Last 6 hours"],
    ["24h", "Last 24 hours"],
    ["3d", "Last 3 days"],
    ["7d", "Last 7 days"],
    ["30d", "Last 30 days"],
  ] as const;
  let period = $state<(typeof PERIODS)[number][0]>("24h");
  let o = $state.raw<Overview | null>(null);
  let allSteps = $state.raw<ReplayStep[]>([]);
  /** Whose events play: yours, as Usage counts them, or every source including agents, improve and tasks. */
  let everyone = $state(false);
  const steps = $derived(stepsOf(allSteps, everyone));
  let range = $state<{ since: string; until: string } | null>(null);
  let truncated = $state(false);
  /** What the server said when it has nothing to replay: no index, or no usage history. */
  let unavailable = $state("");
  let error = $state("");
  let loading = $state(true);
  /** The replay opens at the end of the period, with every figure full. */
  let clock = $state(0);
  let playing = $state(false);
  let speed = $state(1);
  let selected = $state("");
  /** The map drawn in 2D, as the mind map of types and tags, or in 3D, as points by meaning; the choice is kept for
   * the session. */
  let drawing = $state(remembered);
  /** The panel beside the map folds away, to give the map the whole window. */
  let sideOpen = $state(sideRemembered);
  const draw = (choice: typeof remembered) => {
    drawing = remembered = choice;
  };
  const points = $derived(drawing === "3d");

  const start = $derived(range ? Date.parse(range.since) : 0);
  const end = $derived(range ? Date.parse(range.until) : 0);
  const span = $derived(end - start);
  const totals = $derived(totalsAt(steps, clock));
  const axis = $derived(axisLabels(start, end));
  const timeline = $derived(kindBins(steps, start, end));
  const mostUsed = $derived(usedList(steps, clock, 5));
  const cutNote = $derived(truncationNote(truncated, allSteps[0]?.t));
  const recent = $derived.by(() => {
    const out: ReplayStep[] = [];
    for (let i = steps.length - 1; i >= 0 && out.length < 14; i--)
      if (steps[i]!.t <= clock && steps[i]!.kind !== "hit") out.push(steps[i]!);
    return out;
  });

  // ---- The mind map of the assets the period's events touched, its bars counting the events on each type and tag ----
  const touched = $derived(new Set(steps.filter((s) => s.node >= 0 && s.kind !== "hit").map((s) => s.node)));
  const branches = $derived(
    o
      ? mindMap(
          o,
          30,
          [...touched].sort((a, b) => a - b),
        )
      : [],
  );
  /** The types and tags each asset is under on the map. */
  const keysOf = $derived.by(() => {
    const keys = new Map<number, string[]>();
    for (const b of branches)
      for (const k of [b.key, ...b.leaves.map((l) => l.key)])
        for (const i of k === b.key ? b.members : b.leaves.find((l) => l.key === k)!.members) {
          if (!keys.has(i)) keys.set(i, []);
          keys.get(i)!.push(k);
        }
    return keys;
  });
  /** Events so far on each type and tag (search hits are part of their search, not counted). */
  function countsAt(t: number) {
    const counts = new Map<string, number>();
    for (const step of steps) {
      if (step.t > t) break;
      if (step.node < 0 || step.kind === "hit") continue;
      for (const k of keysOf.get(step.node) ?? []) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return counts;
  }
  const counts = $derived(countsAt(clock));
  /** The bars share the scale of the busiest tag over the whole period, so they grow as it plays. */
  const most = $derived.by(() => {
    const full = countsAt(end);
    return Math.max(1, ...branches.flatMap((b) => b.leaves.map((l) => full.get(l.key) ?? 0)));
  });
  const eventsText = (n: number) => (n ? `${n.toLocaleString()} event${n === 1 ? "" : "s"}` : "");
  const offMap = $derived(
    steps.filter((s) => s.t <= clock && s.kind !== "hit" && s.ref && (s.node < 0 || !keysOf.has(s.node))).length,
  );

  // ---- The 3D map: every asset with a group by meaning is a point; used so far in full colour, the rest faint ----
  const everyAsset = $derived(o ? o.ref.map((_, i) => i) : []);
  const groups = $derived(o ? groupsOf(o, everyAsset) : []);
  const place = $derived(o ? o.place : new Float32Array(0));
  /** A point's size is the events on its asset over the whole period, so it does not change as the replay plays. */
  const size = $derived.by(() => {
    const values = new Float32Array(o?.count ?? 0);
    for (const s of steps) if (s.node >= 0 && s.kind !== "hit") values[s.node]!++;
    return { label: "events in the period", values, largest: values.reduce((most, v) => Math.max(most, v), 0) };
  });
  /** The asset chosen on the points, or -1; what is chosen replaces the lists beside the map with its own events. */
  let picked = $state(-1);
  /** The type, tag or group by meaning chosen, with its assets; an asset chosen on the points comes first. */
  const chosen = $derived.by(() => {
    if (picked >= 0) return null;
    const group = groups.find((g) => g.key === selected);
    if (group) return { name: group.label, kind: "Group by meaning", members: group.members };
    for (const b of branches) {
      if (b.key === selected) return { name: b.label, kind: "Asset type", members: b.members };
      const leaf = b.leaves.find((l) => l.key === selected);
      if (leaf) return { name: leaf.label, kind: `Tag in ${b.label}`, members: leaf.members };
    }
    return null;
  });
  /** The events so far on the chosen asset, or on the assets of what is chosen, the latest first. */
  const chosenEvents = $derived.by(() => {
    const members = picked >= 0 ? new Set([picked]) : chosen ? new Set(chosen.members) : null;
    return members ? steps.filter((s) => s.t <= clock && members.has(s.node)).reverse() : [];
  });
  const choose = (key: string) => {
    picked = -1;
    selected = selected === key ? "" : key;
  };
  /** The feedback given so far, the latest first. */
  const feedbackSoFar = $derived(steps.filter((s) => s.kind === "feedback" && s.t <= clock).reverse());
  /** The type colour of an asset: one of the map's eight families. */
  const colourOf = (i: number) => `--map-${o!.family[i]! + 1}`;
  /** The assets used so far, the same set while no new asset is used, so the points are redrawn only when one is. */
  let usedSoFar: { steps: ReplayStep[]; set: Set<number> } = { steps: [], set: new Set() };
  const lit = $derived.by(() => {
    const used = totals.used;
    if (usedSoFar.steps !== steps || usedSoFar.set.size !== used.size) usedSoFar = { steps, set: new Set(used) };
    return usedSoFar.set;
  });
  /** A pulse stays on an asset for 0.75 seconds of playing, at the speed chosen. */
  const pulseWindow = $derived((750 * speed * span) / (REPLAY_SECONDS * 1000));
  const pulses = $derived(
    points
      ? pulsesAt(steps, clock, pulseWindow).map((p) => ({
          i: p.node,
          token: PULSES.find((k) => k.id === p.pulse)!.token,
        }))
      : [],
  );
  const unplaced = $derived(points && o ? unplacedEvents(steps, clock, (node) => o!.group[node]! >= 0) : null);
  /** The families of the assets on the map, for its key. */
  const familiesShown = $derived(
    o
      ? FAMILIES.map((family, k) => ({ ...family, k })).filter((f) =>
          groups.some((g) => g.members.some((i) => o!.family[i] === f.k)),
        )
      : [],
  );

  /** The latest load: a response to an earlier one (an earlier Period) changes nothing. */
  let generation = 0;
  let overviewOnce: Promise<Overview | null> | null = null;
  async function readOverview(): Promise<Overview | null> {
    const payload = await api<OverviewPayload>("/graph");
    if (!payload.available) {
      unavailable = payload.note;
      return null;
    }
    return buildOverview(payload);
  }
  async function load() {
    const mine = ++generation;
    loading = true;
    error = "";
    pause();
    try {
      overviewOnce ??= readOverview();
      const [built, events] = await Promise.all([
        overviewOnce,
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
      o = built;
      allSteps = replaySteps(events.events, new Map(built.ref.map((ref, i) => [ref, i])));
      range = events.window;
      truncated = events.truncated;
      clock = Date.parse(events.window.until);
    } catch (cause) {
      overviewOnce = null;
      if (mine === generation) error = (cause as Error).message;
    } finally {
      if (mine === generation) loading = false;
    }
  }
  $effect(() => {
    void period;
    void load();
  });

  function seek(t: number) {
    clock = Math.max(start, Math.min(end, t));
  }
  let ticking = 0;
  let lastTick = 0;
  function tick(now: number) {
    const dt = Math.min(64, now - lastTick);
    lastTick = now;
    clock = advance(clock, dt, start, end, speed);
    if (clock >= end) playing = false;
    ticking = playing ? requestAnimationFrame(tick) : 0;
  }
  /** Play starts from the beginning when the playhead is at the end, which is where the replay opens. */
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
  onDestroy(pause);

  // ---- The timeline: click or drag to move the playhead ----
  const W = 960;
  const H = 120;
  let dragging = false;
  function seekAt(event: PointerEvent) {
    const box = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
    pause();
    seek(start + ((event.clientX - box.left) / box.width) * span);
  }
  /** The rings in the key, in a word each: a ring marks the asset of the event the playhead is on. */
  const RING_NAMES = { read: "Read", hit: "Search result", up: "Liked", down: "Disliked" } as const;
  /** A list in the panel shows its first few rows, so the panel ends above the timeline; Show all opens it. */
  const SHORT = 4;
  let opened = $state<Record<string, boolean>>({});
  const capped = <T,>(list: readonly T[], id: string) => (opened[id] ? list : list.slice(0, SHORT));
  const playheadX = $derived(span ? ((clock - start) / span) * W : W);
</script>

{#snippet more(total: number, id: string)}{#if total > SHORT}<button
      class="link"
      onclick={() => (opened = { ...opened, [id]: !opened[id] })}
      >{opened[id] ? "Show fewer" : `Show all ${total.toLocaleString()}`}</button
    >{/if}{/snippet}
<section class="replay" aria-label="Activity replay" aria-busy={loading}>
  {#if error}<div class="notice notice-warn" role="alert">
      {error}<button
        class="btn-secondary"
        onclick={() => {
          overviewOnce = null;
          void load();
        }}>Retry</button
      >
    </div>{/if}
  {#if loading}<p class="muted" role="status">Loading activity…</p>{/if}
  {#if unavailable && !loading}<div class="notice" role="status">{unavailable}</div>{/if}
  {#if o && range && !unavailable}
    <div class="replay-body" class:alone={!sideOpen}>
      <div class="replay-map">
        <button
          class="panel-toggle"
          aria-expanded={sideOpen}
          aria-label={sideOpen ? "Hide panel" : "Show panel"}
          title={sideOpen ? "Hide panel" : "Show panel"}
          onclick={() => (sideOpen = sideRemembered = !sideOpen)}><Icon name="panel-right" size={16} /></button
        >
        <div class="stage-tools">
          <div class="views" role="group" aria-label="Map drawing">
            {#each [["2d", "2D"], ["3d", "3D"]] as const as [id, name]}<button
                class="btn-quiet"
                aria-pressed={drawing === id}
                onclick={() => draw(id)}>{name}</button
              >{/each}
          </div>
          <select class="period" aria-label="Period" bind:value={period}
            >{#each PERIODS as [value, name]}<option {value}>{name}</option>{/each}</select
          >
          <select class="whose" aria-label="Events by" bind:value={everyone}
            ><option value={false}>Your events</option><option value={true}
              >Everyone's events (you, agents, automation)</option
            ></select
          >
        </div>
        {#if points}
          {#if groups.length}
            <SimilarityMap
              {o}
              {place}
              {size}
              describe={(i) =>
                `${FAMILIES[o!.family[i]!]!.label}${lit.has(i) ? ", used so far" : ""} · ${eventsText(size.values[i]!) || "no events"} in the period`}
              scope={everyAsset}
              {groups}
              {colourOf}
              {lit}
              {picked}
              {selected}
              onPick={(i) => {
                selected = "";
                picked = picked === i ? -1 : i;
              }}
              onGroup={choose}
              emphasis={pulses}
              label="The library's assets as points, in groups by meaning, groups alike in meaning near each other. An asset used so far is in its type's colour, the rest are faint, and an asset an event has just touched is ringed. The log beside it lists the same events."
            >
              {#snippet legend()}
                <ul class="key" aria-label="Key to the 3D map">
                  <li class="cap">Used, by type:</li>
                  {#each familiesShown as family}<li>
                      <span class="dot" style={`background:var(--map-${family.k + 1})`}></span>{family.label}
                    </li>{/each}
                  <li><span class="dot faint"></span>Not used yet</li>
                  <li class="cap">Ring = current event:</li>
                  {#each PULSES as pulse}<li>
                      <span class="ring" style={`border-color:var(${pulse.token})`}></span>{RING_NAMES[pulse.id]}
                    </li>{/each}
                </ul>
              {/snippet}
            </SimilarityMap>
            {#if unplaced && (unplaced.notOnMap || unplaced.notListed)}<p class="muted small" role="status">
                {#if unplaced.notOnMap}{unplaced.notOnMap.toLocaleString()}
                  {unplaced.notOnMap === 1 ? "event" : "events"} so far touched assets with no place on this map (no group
                  by meaning: not embedded, or added since the last index build).{/if}
                {#if unplaced.notListed}{unplaced.notListed.toLocaleString()}
                  {unplaced.notListed === 1 ? "event" : "events"} so far touched assets the index no longer lists.{/if}
              </p>{/if}{:else}<p class="notice">
              No stored embeddings, so assets cannot be placed by meaning and the 3D map cannot be drawn: {steps
                .filter((s) => s.t <= clock && s.kind !== "hit" && s.ref)
                .length.toLocaleString()} events so far touched assets. Build the index with embeddings, or use Tags.
            </p>{/if}
        {:else}
          <MindMap
            {branches}
            rootLabel="Library"
            rootFigure={eventsText(branches.reduce((sum, b) => sum + (counts.get(b.key) ?? 0), 0))}
            figure={(_, key) => eventsText(counts.get(key) ?? 0)}
            bar={(_, key) => [{ n: counts.get(key) ?? 0, token: "--accent" }]}
            scale={most}
            {selected}
            appeared={(key) => (counts.get(key) ?? 0) > 0}
            onSelect={choose}
            pulse={playing ? counts : null}
            label="The library mind map: its asset types and the tags their assets carry most, each with the number of events on it so far. The log beside it lists the same events."
          />
          {#if offMap}<p class="muted small">
              {offMap.toLocaleString()} events so far touched assets under none of the tags drawn, or no longer in the library.
            </p>{/if}
        {/if}
      </div>
      {#if sideOpen}<aside class="replay-side" aria-label="Details">
          {#if picked >= 0 || chosen}
            {@const count = eventsText(chosenEvents.filter((s) => s.kind !== "hit").length) || "no events"}
            <header class="panel-head">
              <div>
                <h2>{picked >= 0 ? o.path(picked) : chosen!.name}</h2>
                <p>
                  {picked >= 0
                    ? `${FAMILIES[o.family[picked]!]!.label} · ${count}`
                    : `${chosen!.kind} · ${chosen!.members.length.toLocaleString()} assets · ${count}`}
                </p>
              </div>
              {#if picked >= 0}<a class="btn btn-secondary" href={searchHref(new URLSearchParams(), o.ref[picked]!)}
                  >Open</a
                >{/if}
              <button
                class="icon-btn"
                aria-label="Close"
                title="Back to the lists"
                onclick={() => {
                  picked = -1;
                  selected = "";
                }}><Icon name="close" size={14} /></button
              >
            </header>
            <section>
              <h3>Events <span>When</span></h3>
              <ol class="rows">
                {#each capped(chosenEvents, "chosen") as step}<li>
                    <span class="what"
                      >{step.kind === "hit"
                        ? "returned by a search"
                        : step.kind === "show"
                          ? "read"
                          : step.kind === "feedback"
                            ? `${step.signal ?? ""} feedback`
                            : step.eventType}{#if picked < 0 && step.node >= 0}{" · "}<a
                          href={searchHref(new URLSearchParams(), o.ref[step.node]!)}>{o.path(step.node)}</a
                        >{/if}</span
                    >
                    <span class="fig">{stampText(step.t, span)}</span>
                  </li>{:else}<li class="muted">None</li>{/each}
              </ol>
              {@render more(chosenEvents.length, "chosen")}
            </section>
          {:else}
            {@const misses = totals.misses}
            {@const feedback = [
              ...feedbackSoFar.filter((s) => s.signal === "negative"),
              ...feedbackSoFar.filter((s) => s.signal !== "negative"),
            ]}
            <section>
              <h3>
                Searches that found nothing
                <span>{totals.foundNothing.toLocaleString()} of {totals.searches.toLocaleString()}</span>
              </h3>
              <ul class="rows">
                {#each capped(misses, "misses") as [query, count]}<li>
                    <span class="what" title={query}>{query}</span>
                    <a href={`/library/search?${new URLSearchParams([["q", query]])}`}>Search again</a>
                    <a href="/library/files">Create</a>
                    <span class="fig">{count}×</span>
                  </li>{:else}<li class="muted">None</li>{/each}
              </ul>
              {@render more(misses.length, "misses")}
            </section>
            <section>
              <h3>Feedback <span>{totals.negative} negative, {totals.positive} positive</span></h3>
              <ol class="rows">
                {#each capped(feedback, "feedback") as step}<li>
                    <span class="sign" data-signal={step.signal}>{step.signal === "negative" ? "−" : "+"}</span>
                    {#if step.ref}<a class="what" href={searchHref(new URLSearchParams(), step.ref)}
                        >{step.node >= 0 ? o.path(step.node) : step.ref}</a
                      >{:else}<span class="what">an asset</span>{/if}
                    <span class="fig">{stampText(step.t, span)}</span>
                  </li>{:else}<li class="muted">None</li>{/each}
              </ol>
              {@render more(feedback.length, "feedback")}
            </section>
            <section>
              <h3>Most used <span>Events</span></h3>
              <ol class="rows">
                {#each mostUsed as row}<li>
                    <a class="what" href={searchHref(new URLSearchParams(), row.ref)}>{o.path(row.node)}</a>
                    <span class="fig">{row.count}</span>
                  </li>{:else}<li class="muted">None</li>{/each}
              </ol>
            </section>
            <section>
              <h3>Latest events <span>When</span></h3>
              <ol class="rows">
                {#each capped(recent, "recent") as step}<li>
                    <span class="kind" data-kind={step.kind === "search" && step.results === 0 ? "miss" : step.kind}
                    ></span>
                    <span class="what" title={describe(step)}>{describe(step)}</span>
                    <span class="fig">{stampText(step.t, span)}</span>
                  </li>{:else}<li class="muted">None</li>{/each}
              </ol>
              {@render more(recent.length, "recent")}
            </section>
          {/if}
          {#if cutNote}<p class="muted note">{cutNote}</p>{/if}
        </aside>{/if}
    </div>
    {#if !steps.length}<p>No searches, reads or feedback recorded in this period.</p>{/if}
  {/if}
  <div class="timeline">
    <div class="transport">
      {#if playing}<button class="btn-primary" onclick={pause}>Pause</button>{:else}<button
          class="btn-primary"
          title={`${playText(speed)}. Click or drag the timeline to move the playhead.`}
          onclick={play}
          disabled={!steps.length || loading}>{clock >= end ? "Play from start" : "Play"}</button
        >{/if}
      <select aria-label="Speed" bind:value={speed}
        >{#each SPEEDS as option}<option value={option.value}>{option.label}</option>{/each}</select
      >
      <div class="now">
        <strong>{range ? stampText(clock, span) : "–"}</strong>
      </div>
    </div>
    {#if o && range && !unavailable}
      <div class="track">
        <div class="scrub">
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            aria-hidden="true"
            onpointerdown={(e) => {
              dragging = true;
              (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
              seekAt(e);
            }}
            onpointermove={(e) => dragging && seekAt(e)}
            onpointerup={() => (dragging = false)}
          >
            {#each timeline.counts as bin, b}
              {@const x = (b / timeline.counts.length) * W}
              {@const bw = W / timeline.counts.length - 1}
              {@const played = start + (b + 1) * timeline.width <= clock}
              {#each KINDS as k, n}
                {@const below = KINDS.slice(0, n).reduce((s, q) => s + bin[q.id], 0)}
                {#if bin[k.id]}<rect
                    {x}
                    y={H - ((below + bin[k.id]) / timeline.max) * (H - 4)}
                    width={bw}
                    height={(bin[k.id] / timeline.max) * (H - 4)}
                    style={`fill:var(${k.token});opacity:${played ? 1 : 0.35}`}
                  />{/if}
              {/each}
            {/each}
            <line class="playhead" x1={playheadX} x2={playheadX} y1="0" y2={H} />
          </svg>
          <input
            type="range"
            min={start}
            max={end}
            step={SCRUB_STEP}
            value={clock}
            aria-label="Playhead"
            aria-valuetext={stampText(clock, span)}
            oninput={(event) => {
              pause();
              seek(scrubTime(Number(event.currentTarget.value), start, end));
            }}
          />
        </div>
        <div class="ticks">
          <span>{axis[0]}</span>
          <ul class="kinds" aria-label="Timeline key">
            {#each KINDS.filter((k) => timeline.counts.some((bin) => bin[k.id])) as k}<li>
                <span class="swatch" style={`background:var(${k.token})`}></span>{k.label}
              </li>{/each}
            <li class="muted">Tallest bar = {timeline.max} events</li>
          </ul>
          <span>{axis[2]}</span>
        </div>
      </div>
    {/if}
  </div>
</section>

<style>
  .replay {
    margin-block-start: 0;
  }
  /* The timeline is one strip: Play, the speed and the playhead's time beside the bars they act on. */
  .transport {
    display: flex;
    gap: 8px;
    align-items: start;
  }
  .transport :global(button),
  .transport select,
  .stage-tools :global(button),
  .stage-tools select {
    block-size: 28px;
    min-block-size: 28px;
    padding-block: 0;
    font-size: var(--text-s);
    border-radius: 4px;
  }
  /* Wide enough for "Play" and "Pause" alike, so the row does not shift; "Play from start" takes what it needs. */
  .transport :global(button) {
    min-inline-size: 64px;
    padding-inline: 12px;
    white-space: nowrap;
  }
  .transport select {
    inline-size: 96px;
  }
  .stage-tools select {
    padding-inline-start: 8px;
  }
  .period {
    inline-size: 140px;
  }
  .whose {
    flex: 0 1 148px;
    min-inline-size: 104px;
  }
  .now {
    min-inline-size: 5.5rem;
    font-size: var(--text-s);
    font-variant-numeric: tabular-nums;
    line-height: 28px;
  }
  /* The bars stand beside the buttons; the slider and the dates run the strip's whole width under both. */
  .track {
    display: contents;
  }
  .scrub {
    min-inline-size: 0;
  }
  .views {
    display: flex;
    gap: 2px;
  }
  .views button {
    min-inline-size: 40px;
    padding: 0 10px;
  }
  .views button[aria-pressed="true"] {
    color: var(--text);
    background: var(--surface-2);
    font-weight: 600;
  }
  .key {
    display: grid;
    grid-template-columns: max-content max-content;
    gap: 0 20px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .key li {
    display: flex;
    gap: 6px;
    align-items: center;
    block-size: 20px;
    white-space: nowrap;
  }
  .key .cap {
    grid-column: 1 / -1;
    font-weight: 600;
  }
  .key .cap:not(:first-child) {
    margin-block-start: 6px;
  }
  .dot,
  .ring {
    flex: none;
    inline-size: 10px;
    block-size: 10px;
    border-radius: 50%;
  }
  .dot {
    background: var(--text);
  }
  .dot.faint {
    opacity: 0.25;
  }
  .ring {
    box-sizing: border-box;
    border: 2px solid;
  }
  /* The timeline stays at the foot of the window, so the playhead is in view with the map whatever is scrolled. */
  .timeline {
    position: sticky;
    inset-block-end: 0;
    z-index: 4;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 4px 12px;
    align-items: center;
    padding: 6px 12px;
    border: 1px solid var(--border);
    background: var(--surface);
    margin-block-start: 8px;
  }
  .timeline svg {
    display: block;
    inline-size: 100%;
    block-size: 28px;
    cursor: ew-resize;
    touch-action: none;
  }
  .playhead {
    stroke: var(--text);
    stroke-width: 2;
    vector-effect: non-scaling-stroke;
  }
  /* The slider lies along the foot of the bars it scrubs: the same playhead, for the keyboard. */
  .ticks {
    grid-column: 1 / -1;
  }
  .timeline input {
    display: block;
    inline-size: 100%;
    block-size: 12px;
    margin: 0;
    accent-color: var(--accent);
  }
  .kinds {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    gap: 4px 14px;
  }
  .kinds li {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .swatch {
    inline-size: 10px;
    block-size: 10px;
    border-radius: 2px;
    flex: none;
  }
  .ticks {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 0 8px;
    min-block-size: 16px;
    font-size: var(--text-xs);
    color: var(--muted);
  }
  .replay-body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 20rem;
    gap: var(--space-2);
    /* The timeline and the map fit one window together. */
    --stage-size: max(260px, calc(100vh - 224px));
    align-items: start;
  }
  .replay-body.alone {
    grid-template-columns: minmax(0, 1fr);
  }
  .replay-map {
    position: relative;
    border: 1px solid var(--border);
    background: var(--surface);
    min-inline-size: 0;
    min-block-size: calc(var(--stage-size) + 2px);
    display: flex;
    flex-direction: column;
  }
  /* The mind map stands in the middle of the room the points would fill. */
  .replay-map > :global(.mind-map) {
    margin-block: auto;
  }
  /* The drawing switch and what is replayed sit on the map; over the tags, which have no spare corner, above them.
     The row never wraps: it leaves the corner to the panel's button. */
  .stage-tools {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 4px 44px 4px 8px;
  }
  .replay-map:has(:global(.stage-3d)) .stage-tools {
    position: absolute;
    inset-block-start: 8px;
    inset-inline-start: 8px;
    z-index: 3;
    inline-size: fit-content;
    max-inline-size: calc(100% - 52px);
    padding: 3px;
    background: color-mix(in srgb, var(--surface) 94%, transparent);
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  /* The panel's button holds the map's top corner beside the panel, open or closed. */
  .panel-toggle {
    position: absolute;
    inset-block-start: 8px;
    inset-inline-end: 8px;
    z-index: 3;
    display: grid;
    place-items: center;
    inline-size: 28px;
    block-size: 28px;
    min-block-size: 28px;
    padding: 0;
    color: var(--muted);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    cursor: pointer;
  }
  .panel-toggle[aria-expanded="true"] {
    color: var(--text);
    background: var(--surface-2);
  }
  .panel-toggle:hover {
    color: var(--text);
    border-color: var(--border-strong);
  }
  .panel-toggle:focus-visible {
    box-shadow: var(--focus-halo);
  }
  .panel-toggle:active {
    background: var(--surface-sunk);
  }
  .sign {
    flex: none;
    inline-size: 1.25rem;
    font-weight: 700;
    text-align: center;
    color: var(--ok);
  }
  .sign[data-signal="negative"] {
    color: var(--fail);
  }
  h3 {
    font-size: var(--text-xs);
    color: var(--muted);
    margin: 0 0 6px;
  }
  /* The panel beside the map: one bordered column with a header, then sections of one-line rows. */
  /* It is as tall as the map at most, and scrolls inside that, so nothing of it lies under the timeline. */
  .replay-side {
    max-block-size: calc(var(--stage-size) + 2px);
    overflow-y: auto;
    min-inline-size: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
  }
  .panel-head {
    display: flex;
    gap: var(--space-2);
    align-items: start;
    min-block-size: 44px;
    padding: var(--space-2) var(--space-3);
  }
  .panel-head div {
    flex: 1;
    min-inline-size: 0;
  }
  .panel-head h2 {
    margin: 0;
    font-size: var(--text-m);
    font-weight: var(--weight-strong);
    overflow-wrap: anywhere;
  }
  .panel-head p {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }
  .panel-head .btn {
    min-block-size: 28px;
    padding: 2px 10px;
    font-size: var(--text-s);
  }
  .icon-btn {
    flex: none;
    display: grid;
    place-items: center;
    inline-size: 28px;
    block-size: 28px;
    min-block-size: 0;
    padding: 0;
    color: var(--muted);
    background: none;
    border: 1px solid transparent;
    border-radius: 4px;
    cursor: pointer;
  }
  .icon-btn:hover {
    color: var(--text);
    background: var(--surface-2);
  }
  .replay-side section {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    border-block-start: 1px solid var(--border);
  }
  .replay-side > section:first-child {
    border-block-start: 0;
  }
  .replay-side h3 {
    display: flex;
    justify-content: space-between;
    gap: var(--space-2);
    margin: 0 0 var(--space-1);
    font-size: var(--text-xs);
    font-weight: var(--weight-strong);
    letter-spacing: var(--tracking-caps);
    text-transform: uppercase;
    color: var(--muted);
  }
  .replay-side h3 span {
    font-weight: 400;
    letter-spacing: 0;
    text-transform: none;
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    font-size: var(--text-s);
  }
  .rows li {
    display: flex;
    gap: var(--space-2);
    align-items: baseline;
    padding: 2px 0;
    line-height: 20px;
    min-inline-size: 0;
  }
  .rows a {
    flex: none;
    color: var(--link);
    text-decoration: none;
  }
  .rows a:hover,
  .rows a:focus-visible {
    text-decoration: underline;
  }
  /* A row is one line: a long name or query is cut, and its title has the whole of it. */
  .rows .what {
    flex: 1 1 auto;
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fig {
    flex: none;
    margin-inline-start: auto;
    font-size: var(--text-xs);
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    text-align: end;
  }
  button.link {
    min-block-size: 0;
    margin-block-start: var(--space-1);
    padding: 0;
    font: inherit;
    font-size: var(--text-xs);
    color: var(--link);
    background: none;
    border: 0;
    cursor: pointer;
  }
  button.link:hover {
    text-decoration: underline;
  }
  .note {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    border-block-start: 1px solid var(--border);
    font-size: var(--text-xs);
  }
  .kind {
    flex: none;
    inline-size: 8px;
    block-size: 8px;
    border-radius: 50%;
    background: var(--border-strong);
    align-self: center;
  }
  .kind[data-kind="show"] {
    background: var(--use-2);
  }
  .kind[data-kind="search"] {
    background: var(--accent);
  }
  .kind[data-kind="curate"] {
    background: var(--use-1);
  }
  .kind[data-kind="miss"] {
    background: var(--fail);
  }
  .kind[data-kind="feedback"] {
    background: var(--ok);
  }
  /* The map needs about 1,000 px to be read at full size; below that the lists go under it. */
  @media (max-width: 1000px) {
    .replay-body {
      grid-template-columns: 1fr;
    }
  }
</style>
