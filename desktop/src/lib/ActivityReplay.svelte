<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script module lang="ts">
  /** The drawing chosen this session: the replay opens in it again, and as tags until points are chosen. */
  let remembered: "tags" | "2d" | "3d" = "tags";
</script>

<script lang="ts">
  // A period of searches, reads and feedback, played back: a timeline of events by kind with a playhead, the library
  // mind map lighting up the tags each event touches (or, in 3D, the library's assets as points on the same 3D map the
  // Library uses, ringed as events touch them), and the events as a log. It opens at the end of the period with
  // every figure full; clicking or dragging the timeline moves the playhead.
  import { onDestroy } from "svelte";
  import { api } from "./client";
  import { FAMILIES } from "./graph-model";
  import { buildOverview, flatPlace, groupsOf, mindMap, type Overview, type OverviewPayload } from "./library-overview";
  import { searchHref } from "./library-model";
  import MindMap from "./MindMap.svelte";
  import SimilarityMap from "./SimilarityMap.svelte";
  import {
    advance,
    axisLabels,
    describe,
    KINDS,
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

  let period = $state<"24h" | "7d">("24h");
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
  /** The map drawn as the mind map of types and tags, or as points by meaning in one plane or in 3D; the choice is
   * kept for the session. */
  let drawing = $state(remembered);
  const draw = (choice: typeof remembered) => {
    drawing = remembered = choice;
  };
  const points = $derived(drawing !== "tags");
  const flat = $derived(drawing === "2d");

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
  const place = $derived(o ? (flat ? flatPlace(o) : o.place) : new Float32Array(0));
  /** A point's size is the events on its asset over the whole period, so it does not change as the replay plays. */
  const size = $derived.by(() => {
    const values = new Float32Array(o?.count ?? 0);
    for (const s of steps) if (s.node >= 0 && s.kind !== "hit") values[s.node]!++;
    return { label: "events in the period", values, largest: Math.max(0, ...values) };
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
  /** In 2D only what has been used so far is drawn, so assets and their groups appear as the replay reaches them. */
  const usedSoFarList = $derived([...lit].sort((a, b) => a - b));
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
  const playheadX = $derived(span ? ((clock - start) / span) * W : W);
</script>

<section class="replay" aria-label="Activity replay" aria-busy={loading}>
  <div class="replay-toolbar">
    <div class="now">
      <span class="muted small">Playhead</span>
      <strong>{range ? stampText(clock, span) : "–"}</strong>
    </div>
    {#if playing}<button class="btn-primary" onclick={pause}>Pause</button>{:else}<button
        class="btn-primary"
        onclick={play}
        disabled={!steps.length || loading}>{clock >= end ? "Play from start" : "Play"}</button
      >{/if}
    <label
      >Speed<select bind:value={speed}
        >{#each SPEEDS as option}<option value={option.value}>{option.label}</option>{/each}</select
      ></label
    >
    <label
      >Period<select bind:value={period}
        ><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option></select
      ></label
    >
    <label
      >Events by<select bind:value={everyone}
        ><option value={false}>You</option><option value={true}>Everyone: you, agents and automation</option></select
      ></label
    >
  </div>
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
    <div class="replay-body">
      <div class="replay-map">
        <div class="stage-tools">
          <div class="seg" role="group" aria-label="Map drawing">
            {#each [["tags", "Tags"], ["2d", "2D"], ["3d", "3D"]] as const as [id, name]}<button
                class="btn-quiet"
                aria-pressed={drawing === id}
                onclick={() => draw(id)}>{name}</button
              >{/each}
          </div>
          <h3>Where the events landed, by {points ? "meaning" : "type and tag"}</h3>
        </div>
        {#if points}
          {#if groups.length}
            <SimilarityMap
              {o}
              {place}
              {flat}
              {size}
              describe={(i) =>
                `${FAMILIES[o!.family[i]!]!.label}${lit.has(i) ? ", used so far" : ""} · ${eventsText(size.values[i]!) || "no events"} in the period`}
              scope={flat ? usedSoFarList : everyAsset}
              groups={flat ? groups.filter((g) => g.members.some((i) => lit.has(i))) : groups}
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
            ></SimilarityMap>
            <ul class="key" aria-label="Key to the 3D map">
              <li><span class="dot"></span>Used so far, in its type's colour</li>
              {#if !flat}<li><span class="dot faint"></span>Not used yet, faint</li>{/if}
              {#each PULSES as pulse}<li>
                  <span class="ring" style={`border-color:var(${pulse.token})`}></span>{pulse.label}, just now
                </li>{/each}
              {#each familiesShown as family}<li>
                  <span class="dot" style={`background:var(--map-${family.k + 1})`}></span>{family.label}
                </li>{/each}
            </ul>
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
          <div class="tags-frame">
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
          </div>
          {#if offMap}<p class="muted small">
              {offMap.toLocaleString()} events so far touched assets under none of the tags drawn, or no longer in the library.
            </p>{/if}
        {/if}
      </div>
      <aside class="replay-side">
        {#if picked >= 0 || chosen}
          {@const count = eventsText(chosenEvents.filter((s) => s.kind !== "hit").length) || "no events"}
          <header class="chosen-head">
            <div>
              <h2>{picked >= 0 ? o.path(picked) : chosen!.name}</h2>
              <p class="muted small">
                {picked >= 0
                  ? `${FAMILIES[o.family[picked]!]!.label} · ${count} so far`
                  : `${chosen!.kind} · ${chosen!.members.length.toLocaleString()} assets · ${count} so far`}
              </p>
            </div>
            <button
              class="btn-quiet"
              aria-label="Close"
              onclick={() => {
                picked = -1;
                selected = "";
              }}>✕</button
            >
          </header>
          {#if picked >= 0}<a class="btn btn-secondary" href={searchHref(new URLSearchParams(), o.ref[picked]!)}>Open</a
            >{/if}
          <section>
            <h3>Its events so far</h3>
            <ol class="log">
              {#each chosenEvents.slice(0, 20) as step}<li>
                  <span class="when muted small">{stampText(step.t, span)}</span>
                  <span class="what"
                    >{step.kind === "hit"
                      ? "returned by a search"
                      : step.kind === "show"
                        ? "read"
                        : step.kind === "feedback"
                          ? `${step.signal ?? ""} feedback`
                          : step.eventType}{#if picked < 0 && step.node >= 0}
                      · <a href={searchHref(new URLSearchParams(), o.ref[step.node]!)}>{o.path(step.node)}</a
                      >{/if}</span
                  >
                </li>{:else}<li class="muted">Nothing yet</li>{/each}
            </ol>
          </section>
        {:else}
          <div class="figures">
            <div><strong>{totals.events.toLocaleString()}</strong><span>events</span></div>
            <div><strong>{totals.shows.toLocaleString()}</strong><span>reads</span></div>
            {#if totals.searches}<div>
                <strong>{totals.searches.toLocaleString()}</strong><span>searches</span>
              </div>{/if}
            {#if totals.curates}<div><strong>{totals.curates.toLocaleString()}</strong><span>curates</span></div>{/if}
            {#if totals.foundNothing}<div class="bad">
                <strong>{totals.foundNothing.toLocaleString()}</strong><span>found nothing</span>
              </div>{/if}
            {#if totals.positive || totals.negative}<div>
                <strong>{totals.positive}</strong><span>positive,</span><strong>{totals.negative}</strong><span
                  >negative feedback</span
                >
              </div>{/if}
            <div><strong>{totals.used.size.toLocaleString()}</strong><span>assets used</span></div>
          </div>
          <section>
            <h3>Searched for, not found</h3>
            <ul class="log">
              {#each totals.misses.slice(0, 6) as [query, count]}<li>
                  <span class="what">{query}</span><span class="muted small count">×{count}</span>
                  <a class="small" href={`/library/search?${new URLSearchParams([["q", query]])}`}>Search again</a>
                  <a class="small" href="/library/files">Create</a>
                </li>{:else}<li class="muted">None so far</li>{/each}
            </ul>
          </section>
          <section>
            <h3>Most used so far</h3>
            <ol class="log">
              {#each mostUsed as row}<li>
                  <a href={searchHref(new URLSearchParams(), row.ref)}>{o.path(row.node)}</a>
                  <span class="muted small">×{row.count}</span>
                </li>{:else}<li class="muted">Nothing yet</li>{/each}
            </ol>
          </section>
          <section>
            <h3>Feedback given so far</h3>
            <ol class="log">
              {#each feedbackSoFar.slice(0, 12) as step}<li>
                  <span class="sign" data-signal={step.signal}>{step.signal === "negative" ? "−" : "+"}</span>
                  {#if step.ref}<a href={searchHref(new URLSearchParams(), step.ref)}
                      >{step.node >= 0 ? o.path(step.node) : step.ref}</a
                    >{:else}<span>an asset</span>{/if}
                  <span class="muted small">{stampText(step.t, span)}</span>
                </li>{:else}<li class="muted">None so far</li>{/each}
            </ol>
          </section>
          <section>
            <h3>Latest events</h3>
            <ol class="log">
              {#each recent as step}<li>
                  <span class="when muted small">{stampText(step.t, span)}</span>
                  <span class="kind" data-kind={step.kind === "search" && step.results === 0 ? "miss" : step.kind}
                  ></span>
                  <span class="what" title={describe(step)}>{describe(step)}</span>
                </li>{:else}<li class="muted">Nothing yet</li>{/each}
            </ol>
          </section>
        {/if}
        {#if cutNote}<p class="muted small">{cutNote}</p>{/if}
      </aside>
    </div>
    {#if !steps.length}<p>No searches, reads or feedback recorded in this period.</p>{/if}
    <div class="timeline">
      <ul class="kinds" aria-label="Timeline key">
        {#each KINDS.filter((k) => timeline.counts.some((bin) => bin[k.id])) as k}<li>
            <span class="swatch" style={`background:var(${k.token})`}></span>{k.label}
          </li>{/each}
      </ul>
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
      <div class="ticks"><span>{axis[0]}</span><span>{axis[1]}</span><span>{axis[2]}</span></div>
    </div>
  {/if}
</section>

<style>
  .replay-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 12px 16px;
    align-items: end;
    margin-bottom: 8px;
  }
  .replay-toolbar label {
    display: grid;
    gap: 4px;
    font-size: 12px;
    color: var(--muted);
  }
  .now {
    display: grid;
    min-inline-size: 11rem;
  }
  .now strong {
    font-size: 1.375rem;
    font-variant-numeric: tabular-nums;
  }
  .seg {
    display: flex;
    gap: 4px;
  }
  .seg button {
    min-block-size: 32px;
    min-inline-size: 44px;
  }
  .seg button[aria-pressed="true"] {
    color: var(--text);
    background: var(--surface-2);
    font-weight: 600;
  }
  .key {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 14px;
    margin: 0;
    padding: 6px 10px;
    list-style: none;
    font-size: var(--text-xs);
  }
  .key li {
    display: flex;
    gap: 6px;
    align-items: center;
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
    inline-size: 12px;
    block-size: 12px;
  }
  .figures {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 14px;
    font-size: 13px;
  }
  .figures div {
    display: flex;
    gap: 4px;
    align-items: baseline;
  }
  .figures strong {
    font-variant-numeric: tabular-nums;
  }
  .figures span {
    color: var(--muted);
  }
  .chosen-head {
    display: flex;
    gap: 8px;
    align-items: start;
  }
  .chosen-head div {
    flex: 1;
    min-inline-size: 0;
  }
  .chosen-head h2 {
    margin: 0 0 2px;
    font-size: 16px;
    overflow-wrap: anywhere;
  }
  .chosen-head p {
    margin: 0;
  }
  .figures .bad strong {
    color: var(--fail);
  }
  /* The timeline stays at the foot of the window, so the playhead is in view with the map whatever is scrolled. */
  .timeline {
    position: sticky;
    inset-block-end: 0;
    z-index: 4;
    padding: 8px 12px;
    border: 1px solid var(--border);
    background: var(--surface);
    margin-block-start: 12px;
  }
  .timeline svg {
    display: block;
    inline-size: 100%;
    block-size: 48px;
    cursor: ew-resize;
    touch-action: none;
  }
  .playhead {
    stroke: var(--text);
    stroke-width: 2;
    vector-effect: non-scaling-stroke;
  }
  .timeline input {
    inline-size: 100%;
    margin: 4px 0 0;
    accent-color: var(--accent);
  }
  .kinds {
    list-style: none;
    margin: 0 0 8px;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
    font-size: 13px;
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
  .replay-body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 22rem;
    gap: 24px;
    align-items: start;
  }
  .replay-map {
    position: relative;
    border: 1px solid var(--border);
    background: var(--surface);
    padding: 8px;
    min-inline-size: 0;
    /* The timeline and the map fit one window together. */
    --stage-size: max(280px, calc(100vh - 520px));
  }
  /* The drawing switch sits on the map; over the tags, which have no spare corner, it sits above them. */
  .stage-tools {
    display: flex;
    gap: 12px;
    align-items: center;
    margin-block-end: 6px;
  }
  .stage-tools h3 {
    margin: 0;
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
    font-size: 12px;
    color: var(--muted);
    margin: 0 0 6px;
  }
  .replay-side {
    display: grid;
    align-content: start;
    gap: 10px;
    min-inline-size: 0;
  }
  .replay-side section {
    margin: 0;
    padding: 0;
  }
  /* The tags are drawn in the frame the points have, so the timeline stays under them. */
  .tags-frame {
    max-block-size: calc(max(280px, 100vh - 520px) + 40px);
    overflow: auto;
  }
  /* Beside the map the lists scroll on their own, so the page, the map and the timeline stay put. */
  @media (min-width: 1401px) {
    .replay-side {
      max-block-size: calc(max(280px, 100vh - 520px) + 110px);
      overflow-y: auto;
    }
  }
  .log {
    list-style: none;
    margin: 0;
    padding: 0;
    font-size: 13px;
  }
  .log li {
    display: flex;
    gap: 8px;
    align-items: baseline;
    padding: 3px 0;
    border-bottom: 1px solid var(--border);
    min-inline-size: 0;
  }
  .log a,
  .what {
    overflow-wrap: anywhere;
    min-inline-size: 0;
  }
  /* A long curate query or ref takes two lines at most; the full text is its title. */
  .what {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }
  .when {
    flex: none;
    font-variant-numeric: tabular-nums;
  }
  .count {
    margin-inline-start: auto;
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
  @media (max-width: 1400px) {
    .replay-body {
      grid-template-columns: 1fr;
    }
  }
  @media (max-width: 1100px) {
    .figures {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }
</style>
