<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  // The whole library in four views, each answering one question: Contents (what is in it), Use (what is read and
  // what is dead weight), Problems (what is wrong or duplicated) and Relations (how its parts depend on each other).
  // Every view shows the whole library; choosing a topic only opens its figures. The text beside each picture gives
  // the same figures.
  import { onDestroy, onMount } from "svelte";
  import { api } from "./client";
  import DeckStage, { type Label } from "./DeckStage.svelte";
  import { FAMILIES } from "./graph-model";
  import {
    assetLayout,
    buildOverview,
    firstProblem,
    groupLinks,
    makeUp,
    OLD_DAYS,
    type Overview,
    type OverviewPayload,
    PROBLEMS,
    RECENT_DAYS,
    rankFor,
    regionLayout,
    relationLayout,
    SPACING,
    tally,
    USE_CLASSES,
    VIEWS,
    type View,
  } from "./library-overview";
  import { filesHref } from "./library-files-model";
  import { searchHref } from "./library-model";
  import { workspace } from "./state/workspace.svelte";
  import { regionLayers, relationLayers } from "./ui/overview-layers.js";

  /** `?select=<ref>`: open the topic this asset belongs to. */
  let { select: wanted = "" }: { select?: string } = $props();

  type Misses = {
    searches: number;
    foundNothing: number;
    misses: Array<{ query: string; count: number; days: number; repeated: boolean }>;
  };
  let o = $state.raw<Overview | null>(null);
  let misses = $state.raw<Misses | null>(null);
  let error = $state("");
  let notice = $state("");
  let view = $state<View>("contents");
  let selected = $state(-1);
  let flat = $state(false);
  let probe: HTMLSpanElement;
  let colours = $state.raw<Record<string, number[]>>({});

  const open = (ref: string) => searchHref(new URLSearchParams(), ref);
  const pct = (part: number, whole: number) => (whole ? `${Math.round((100 * part) / whole)}%` : "–");
  const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

  async function load() {
    error = "";
    try {
      const payload = await api<OverviewPayload>("/graph");
      if (!payload.available) {
        notice = payload.note;
        return;
      }
      o = buildOverview(payload);
      if (wanted) {
        const i = o.ref.indexOf(wanted);
        if (i < 0) notice = `No asset “${wanted}” is in the library.`;
        else selected = o.groupOf[i]!;
      }
    } catch (cause) {
      error = (cause as Error).message;
    }
    api<Misses>("/search/misses")
      .then((m) => (misses = m))
      .catch(() => (misses = null));
  }
  void load();

  // ---- Colours, from the design tokens, read again when the appearance changes ----
  const TOKENS = [
    "--text",
    "--bg",
    "--surface",
    "--surface-2",
    "--border",
    "--border-strong",
    "--muted",
    "--accent",
    ...FAMILIES.map((_, k) => `--map-${k + 1}`),
    ...USE_CLASSES.map((u) => u.token),
    ...PROBLEMS.map((p) => p.token),
  ];
  function readColours() {
    if (!probe) return;
    const out: Record<string, number[]> = {};
    for (const token of new Set(TOKENS)) {
      probe.style.color = `var(${token})`;
      out[token] = (getComputedStyle(probe).color.match(/[\d.]+/g) ?? ["0", "0", "0"]).slice(0, 3).map(Number);
    }
    colours = out;
  }
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  const appearance = new MutationObserver(readColours);
  onMount(() => {
    readColours();
    scheme.addEventListener("change", readColours);
    appearance.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  });
  onDestroy(() => {
    scheme.removeEventListener("change", readColours);
    appearance.disconnect();
  });
  const c = (token: string, alpha = 255) => [...(colours[token] ?? [128, 128, 128]), alpha];

  // ---- Figures every view shares ----
  const links = $derived(o ? groupLinks(o) : null);
  const regions = $derived(o && links ? regionLayout(o, links.pairs) : []);
  const relation = $derived(o && links ? relationLayout(o, links.pairs) : []);
  const positions = $derived(o && regions.length ? assetLayout(o, regions, rankFor(o, view)) : new Float32Array(0));
  const all = $derived(o ? o.ref.map((_, i) => i) : []);
  const useCounts = $derived(
    o
      ? tally(
          all,
          (i) => o!.use[i],
          USE_CLASSES.map((u) => u.id),
        )
      : null,
  );
  const problemCounts = $derived(
    o
      ? tally(
          all,
          (i) => firstProblem(o!, i),
          PROBLEMS.map((p) => p.id),
        )
      : null,
  );
  const problemAssets = $derived(
    o ? Object.fromEntries(PROBLEMS.map((p) => [p.id, all.filter((i) => o!.problems[i]!.includes(p.id))])) : {},
  );
  const groupUse = (k: number) =>
    tally(
      o!.groups[k]!.members,
      (i) => o!.use[i],
      USE_CLASSES.map((u) => u.id),
    );
  const groupProblems = (k: number) => o!.groups[k]!.members.filter((i) => o!.problems[i]!.length > 0).length;
  const makeup = $derived(o ? makeUp(o) : null);
  const sinceText = $derived(o?.useSince ? new Date(o.useSince).toLocaleDateString() : "");

  /** The view's colour for one asset. */
  function assetColour(i: number): number[] {
    if (!o) return [0, 0, 0, 0];
    if (view === "use") {
      const u = o.use[i];
      return u ? c(USE_CLASSES.find((x) => x.id === u)!.token, u === "new" ? 200 : 235) : c("--muted", 120);
    }
    if (view === "problems") {
      const p = firstProblem(o, i);
      return p ? c(PROBLEMS.find((x) => x.id === p)!.token, 245) : c("--border-strong", 70);
    }
    return c(`--map-${o.family[i]! + 1}`, 230);
  }
  /** The figure a region's label carries in each view. */
  function regionFigure(k: number): string {
    const g = o!.groups[k]!;
    if (view === "use" && o!.useKnown) {
      const u = groupUse(k);
      return `${pct(u.unread + u.new, g.members.length)} unread`;
    }
    if (view === "problems") return plural(groupProblems(k), "problem");
    return g.members.length.toLocaleString();
  }

  // ---- Layers ----
  const regionView = $derived(view !== "relations");
  const frame = $derived.by(() => {
    if (!o) return { centre: [0, 0, 0], radius: 100 };
    const items = regionView ? regions.map((r) => ({ ...r, z: 0 })) : relation;
    if (!items.length) return { centre: [0, 0, 0], radius: 100 };
    const lo = [0, 1, 2].map((a) => Math.min(...items.map((r) => [r.x, r.y, r.z][a]! - r.radius)));
    const hi = [0, 1, 2].map((a) => Math.max(...items.map((r) => [r.x, r.y, r.z][a]! + r.radius)));
    const centre = lo.map((v, a) => (v + hi[a]!) / 2);
    const radius = Math.max(
      ...items.map((r) => Math.hypot(r.x - centre[0]!, r.y - centre[1]!, r.z - centre[2]!) + r.radius),
    );
    // Room for the labels above the top regions.
    return { centre, radius: radius + (regionView ? 24 : 0) };
  });

  /** Bumped when the colours change, so the layers recolour. */
  const key = $derived(JSON.stringify(colours["--text"] ?? []) + view);
  const layers = $derived.by(() => {
    if (!o || !colours["--text"]) return [];
    if (regionView)
      return regionLayers({
        count: o.count,
        regions,
        positions,
        dotRadius: SPACING * 0.36,
        assetColour,
        selected,
        paint: c,
        onGroup: toggleGroup,
        onAsset: (i: number) => toggleGroup(o!.groupOf[i]!),
        key,
      });
    const near = (k: number) =>
      selected < 0 ||
      k === selected ||
      links!.pairs.some((p) => (p.a === selected && p.b === k) || (p.b === selected && p.a === k));
    return relationLayers({
      nodes: relation,
      pairs: drawnPairs,
      alike: o.groups.flatMap((g, k) => g.related.slice(0, 1).map((r) => ({ a: k, b: r.group, cosine: r.cosine }))),
      nodeColour: (k: number) => c("--accent", near(k) ? 235 : 70),
      selected,
      paint: c,
      onGroup: toggleGroup,
      key,
    });
  });
  /**
   * The links drawn in Relations: each topic's strongest connection, and any other pair with at least a fifth of the
   * strongest pair's links. Every pair is in the list beside it.
   */
  const drawnPairs = $derived.by(() => {
    if (!links) return [];
    const most = links.pairs[0]?.count ?? 0;
    const strongest = new Set<string>();
    for (const [k] of o!.groups.entries()) {
      const p = links.pairs.find((x) => x.a === k || x.b === k);
      if (p) strongest.add(`${p.a}:${p.b}`);
    }
    return links.pairs.filter((p) => p.count >= most / 5 || strongest.has(`${p.a}:${p.b}`));
  });
  const stageLabels = $derived.by((): Label[] => {
    if (!o) return [];
    return o.groups.map((g, k) => {
      const text = `${g.label} · ${regionFigure(k)}`;
      if (regionView) {
        const r = regions[k]!;
        return { position: [r.x, r.y - r.radius, 0], text, priority: k === selected ? 1e9 : g.members.length };
      }
      const r = relation[k]!;
      return {
        position: [r.x, r.y + r.radius, r.z],
        text,
        priority: k === selected ? 1e9 : g.members.length,
      };
    });
  });

  // biome-ignore lint/suspicious/noExplicitAny: deck.gl picking info.
  function tooltip(info: any): string | null {
    if (!o || !info.layer) return null;
    const id = info.layer.id;
    if (id === "assets") {
      const i = info.index as number;
      const lines = [o.path(i), `${o.types[o.type[i]!]} · ${o.bundles[o.bundle[i]!]}`];
      if (o.useKnown) lines.push(`Shown ${o.shows[i]} times since ${sinceText}`);
      for (const p of o.problems[i]!) lines.push(PROBLEMS.find((x) => x.id === p)!.label);
      lines.push(`In: ${o.groups[o.groupOf[i]!]!.label}`);
      return lines.join("\n");
    }
    if (id === "regions" || id === "groups") {
      const g = o.groups[info.object as number]!;
      return `${g.label}\n${plural(g.members.length, "asset")}\n${g.terms.slice(0, 5).join(", ")}`;
    }
    if (id === "group-links") {
      const p = info.object as { a: number; b: number; count: number };
      return `${o.groups[p.a]!.label} ↔ ${o.groups[p.b]!.label}\n${plural(p.count, "declared link")}`;
    }
    if (id === "group-alike") {
      const p = info.object as { a: number; b: number; cosine: number };
      return `${o.groups[p.a]!.label} is most like ${o.groups[p.b]!.label}\ncontent cosine ${p.cosine.toFixed(2)}`;
    }
    return null;
  }

  let side = $state<HTMLElement>();
  function toggleGroup(k: number) {
    selected = selected === k ? -1 : k;
    // The topic's figures open at the top of the side panel: bring them into view.
    if (selected >= 0) side?.scrollTo({ top: 0 });
  }
  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape" && selected >= 0) selected = -1;
  }

  // ---- Text beside each view ----
  const groupRows = $derived.by(() => {
    if (!o) return [];
    const rows = o.groups.map((g, k) => {
      const u = groupUse(k);
      return {
        k,
        g,
        n: g.members.length,
        unread: u.unread,
        fresh: u.new,
        recent: u.recent,
        problems: groupProblems(k),
        inside: links!.inside[k],
        across: links!.across[k],
      };
    });
    if (view === "use")
      return rows.sort((a, b) => (b.unread + b.fresh) / b.n - (a.unread + a.fresh) / a.n || b.n - a.n);
    if (view === "problems") return rows.sort((a, b) => b.problems - a.problems || b.n - a.n);
    if (view === "relations") return rows.sort((a, b) => b.across - a.across || b.n - a.n);
    return rows;
  });
  const isolated = $derived(o && links ? o.groups.map((_, k) => k).filter((k) => links!.across[k] === 0) : []);
  const crossLinks = $derived(links ? links.pairs.reduce((s, p) => s + p.count, 0) : 0);
  const insideLinks = $derived(links ? links.inside.reduce((s: number, n: number) => s + n, 0) : 0);

  const detail = $derived.by(() => {
    if (!o || selected < 0 || !o.groups[selected]) return null;
    const g = o.groups[selected]!;
    const top = [...g.members].sort((a, b) => o!.shows[b]! - o!.shows[a]! || a - b).slice(0, 10);
    const partners = links!.pairs
      .filter((p) => p.a === selected || p.b === selected)
      .slice(0, 6)
      .map((p) => ({ k: p.a === selected ? p.b : p.a, count: p.count }));
    const troubled = g.members.filter((i) => o!.problems[i]!.length).slice(0, 12);
    const unused = g.members.filter((i) => o!.use[i] === "unread").slice(0, 12);
    return { g, top, partners, troubled, unused, makeup: makeUp(o, g.members), use: groupUse(selected) };
  });
  const filesLink = $derived(
    filesHref({
      bundle:
        workspace.bundles.find((bundle) => bundle.default)?.name ??
        workspace.bundles.find((bundle) => bundle.enabled)?.name ??
        "",
      path: "",
    }),
  );
  const question = $derived(VIEWS.find((v) => v.id === view)!.question);
  const stageLabel = $derived(
    o
      ? `${question} ${plural(o.count, "asset")} in ${plural(o.groups.length, o.groups[0]?.kind === "folder" ? "folder" : "topic")}. The list beside the picture gives the same figures.`
      : "",
  );
</script>

<svelte:window onkeydown={onKey} />
<span class="probe" bind:this={probe} aria-hidden="true"></span>
<nav class="library-views" aria-label="Library views" data-sveltekit-reset="false">
  <a href="/library/search">Search</a>
  <a href={filesLink}>Files</a>
  <a href="/library/map" aria-current="page">Map</a>
</nav>
<div class="map-page">
  <div class="map-toolbar">
    <h1>Library map</h1>
    <div class="views" role="tablist" aria-label="Question">
      {#each VIEWS as v}<button
          role="tab"
          aria-selected={view === v.id}
          class="btn-quiet"
          title={v.question}
          onclick={() => (view = v.id)}>{v.label}</button
        >{/each}
    </div>
    <span class="grow"></span>
    {#if view === "relations"}<label class="flat"><input type="checkbox" bind:checked={flat} /> Flat</label>{/if}
  </div>
  <p class="question">{question}</p>
  {#if error}<div class="notice notice-warn" role="alert">
      {error}<button class="btn-secondary" onclick={load}>Retry</button>
    </div>{/if}
  {#if notice}<p class="notice" role="status">{notice}</p>{/if}
  {#if o === null && !error && !notice}<p class="muted" role="status">
      Reading the library… The first read after an index build groups it into topics, which can take a few seconds.
    </p>{/if}
  {#if o}
    <div class="map-body">
      <div class="map-main">
        <div class="map-legend">
          {#if view === "contents"}<h3>Colour: asset type</h3>
            <ul>
              {#each makeup?.families ?? [] as row}<li>
                  <span class="swatch" style={`background:var(--map-${row.slot + 1})`}></span>{row.label}<span
                    class="count">{row.count.toLocaleString()}</span
                  >
                </li>{/each}
            </ul>
            <p class="muted small">
              Each circle is a {o.groups[0]?.kind === "folder" ? "folder" : "topic"}; its area is its number of assets.
            </p>
          {:else if view === "use"}<h3>Colour: use since {sinceText}</h3>
            {#if o.useKnown}<ul>
                {#each USE_CLASSES as u}<li>
                    <span class="swatch" style={`background:var(${u.token})`}></span>{u.label}<span class="count"
                      >{useCounts?.[u.id].toLocaleString()}</span
                    >
                  </li>{/each}
              </ul>{:else}<p class="muted small">No usage history is available, so use cannot be shown.</p>{/if}
          {:else if view === "problems"}<h3>Colour: what is wrong</h3>
            <ul>
              {#each PROBLEMS as p}<li>
                  <span class="swatch" style={`background:var(${p.token})`}></span>{p.label}<span class="count"
                    >{problemAssets[p.id]?.length.toLocaleString()}</span
                  >
                </li>{/each}
              <li><span class="swatch" style="background:var(--border-strong)"></span>No problem recorded</li>
            </ul>
          {:else}<h3>{o.groups[0]?.kind === "folder" ? "Folders" : "Topics"} and how they connect</h3>
            <ul>
              <li><span class="swatch" style="background:var(--accent)"></span>A topic; larger has more assets</li>
              <li><span class="line"></span>Its strongest declared links; wider is more</li>
              <li><span class="line dashed"></span>The topic most alike in content</li>
            </ul>{/if}
        </div>
        <div class="map-stage">
          <DeckStage
            {layers}
            labels={stageLabels}
            three={view === "relations" && !flat}
            {frame}
            label={stageLabel}
            ink={colours["--text"] ?? [0, 0, 0]}
            paper={colours["--surface"] ?? [255, 255, 255]}
            {tooltip}
          />
        </div>
      </div>
      <aside class="map-side" aria-label="Figures" bind:this={side}>
        {#if detail}<section class="detail" aria-live="polite">
            <div class="detail-head">
              <h2>{detail.g.label}</h2>
              <button class="btn-quiet" onclick={() => (selected = -1)} aria-label="Close topic">✕</button>
            </div>
            <p class="muted small">
              {plural(
                detail.g.members.length,
                "asset",
              )}{#if detail.g.kind === "topic"}{` · about ${detail.g.terms.join(", ")}`}{/if}
            </p>
            {#if view === "contents"}<h3>Types</h3>
              <ul class="rows">
                {#each detail.makeup.families as row}<li>{row.label}<span class="count">{row.count}</span></li>{/each}
              </ul>
              <h3>Bundles</h3>
              <ul class="rows">
                {#each detail.makeup.bundles as row}<li>{row.label}<span class="count">{row.count}</span></li>{/each}
              </ul>
            {:else if view === "use"}<ul class="rows">
                {#each USE_CLASSES as u}<li>{u.label}<span class="count">{detail.use[u.id]}</span></li>{/each}
              </ul>
              {#if detail.unused.length}<h3>Not read, old</h3>
                <ul class="assets">
                  {#each detail.unused as i}<li><a href={open(o.ref[i]!)}>{o.path(i)}</a></li>{/each}
                </ul>{/if}
            {:else if view === "problems"}{#if detail.troubled.length}<ul class="assets">
                  {#each detail.troubled as i}<li>
                      <a href={open(o.ref[i]!)}>{o.path(i)}</a>
                      <span class="muted small"
                        >{o.problems[i]!.map((p) => PROBLEMS.find((x) => x.id === p)!.label.toLowerCase()).join(
                          "; ",
                        )}</span
                      >
                    </li>{/each}
                </ul>{:else}<p class="muted small">No problems recorded here.</p>{/if}
            {:else}<h3>Linked with</h3>
              {#if detail.partners.length}<ul class="rows">
                  {#each detail.partners as p}<li>
                      <button class="link" onclick={() => (selected = p.k)}>{o.groups[p.k]!.label}</button><span
                        class="count">{plural(p.count, "link")}</span
                      >
                    </li>{/each}
                </ul>{:else}<p class="muted small">No declared links to other parts.</p>{/if}
              {#if detail.g.related.length}<h3>Most alike in content</h3>
                <ul class="rows">
                  {#each detail.g.related as r}<li>
                      <button class="link" onclick={() => (selected = r.group)}>{o.groups[r.group]!.label}</button><span
                        class="count">{r.cosine.toFixed(2)}</span
                      >
                    </li>{/each}
                </ul>{/if}{/if}
            <h3>{o.shows[detail.top[0] ?? -1] ? "Most read here" : "Assets here"}</h3>
            <ul class="assets">
              {#each detail.top as i}<li>
                  <a href={open(o.ref[i]!)}>{o.path(i)}</a>{#if o.shows[i]}<span class="count">{o.shows[i]}</span>{/if}
                </li>{/each}
            </ul>
          </section>{/if}

        {#if view === "contents"}<section>
            <div class="stats">
              <div><strong>{o.count.toLocaleString()}</strong><span>assets</span></div>
              <div>
                <strong>{o.groups.length}</strong><span>{o.groups[0]?.kind === "folder" ? "folders" : "topics"}</span>
              </div>
              <div><strong>{o.bundles.length}</strong><span>bundles</span></div>
            </div>
            {#if o.groups[0]?.kind === "folder"}<p class="muted small">
                No embeddings, so the library is grouped by folder. Build embeddings to group it by topic.
              </p>{/if}
            <h3>Looked for and not found</h3>
            {#if misses?.misses.length}<p class="muted small">
                {misses.foundNothing} of {misses.searches} searches in 30 days found nothing. Most asked:
              </p>
              <ul class="rows">
                {#each misses.misses.slice(0, 8) as m}<li>{m.query}<span class="count">{m.count}×</span></li>{/each}
              </ul>{:else}<p class="muted small">Every search in the last 30 days found something.</p>{/if}
            <h3>Bundles</h3>
            <ul class="rows">
              {#each makeup?.bundles ?? [] as row}<li>
                  {row.label}<span class="count">{row.count.toLocaleString()}</span>
                </li>{/each}
            </ul>
          </section>
        {:else if view === "use"}<section>
            {#if o.useKnown && useCounts}<div class="stats">
                <div><strong>{pct(useCounts.recent, o.count)}</strong><span>read in {RECENT_DAYS} days</span></div>
                <div>
                  <strong>{pct(useCounts.unread + useCounts.new, o.count)}</strong><span
                    >not read since {sinceText}</span
                  >
                </div>
                <div><strong>{useCounts.unread.toLocaleString()}</strong><span>unread and old</span></div>
              </div>
              <p class="muted small">
                Reads by people and their agents since {sinceText}; scheduled tasks and Improve are not counted. Old
                means last edited over {OLD_DAYS} days ago.
              </p>{:else}<p class="muted small">{o.note}</p>{/if}
          </section>
        {:else if view === "problems"}<section>
            <div class="stats">
              <div><strong>{problemAssets.outdated?.length ?? 0}</strong><span>outdated</span></div>
              <div><strong>{problemAssets.negative?.length ?? 0}</strong><span>disliked</span></div>
              <div>
                <strong>{o.duplicates.length}{o.duplicatesTruncated ? "+" : ""}</strong><span>duplicate pairs</span>
              </div>
            </div>
            {#if o.duplicates.length}<h3>Most alike pairs</h3>
              <ul class="pairs">
                {#each o.duplicates.slice(0, 8) as d}<li>
                    <a href={open(o.ref[d.a]!)}>{o.ref[d.a]}</a><a href={open(o.ref[d.b]!)}>{o.ref[d.b]}</a><span
                      class="muted small">cosine {d.cosine.toFixed(3)}</span
                    >
                  </li>{/each}
              </ul>
              <p class="muted small">
                Pairs in one topic whose content embeddings have a cosine of {o.duplicateThreshold} or more{o.duplicatesTruncated
                  ? "; only the 2,000 most alike are listed"
                  : ""}.
              </p>{:else if o.groups[0]?.kind === "folder"}<p class="muted small">
                Duplicates are found from embeddings, and this index has none.
              </p>{/if}
          </section>
        {:else}<section>
            <div class="stats">
              <div><strong>{insideLinks.toLocaleString()}</strong><span>links inside a part</span></div>
              <div><strong>{crossLinks.toLocaleString()}</strong><span>links across parts</span></div>
              <div><strong>{isolated.length}</strong><span>parts linked to no other</span></div>
            </div>
            {#if !o.links.from.length}<p class="muted small">
                No asset declares a link to another, so the parts are joined only by how alike their content is.
              </p>{/if}
            {#if links?.pairs.length}<h3>Most linked parts</h3>
              <ul class="rows">
                {#each links.pairs.slice(0, 8) as p}<li>
                    {o.groups[p.a]!.label} ↔ {o.groups[p.b]!.label}<span class="count">{p.count}</span>
                  </li>{/each}
              </ul>{/if}
          </section>{/if}

        <section>
          <h3>{o.groups[0]?.kind === "folder" ? "Folders" : "Topics"}</h3>
          <table class="groups">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Assets</th>
                {#if view === "use"}<th scope="col">Unread</th>{:else if view === "problems"}<th scope="col"
                    >Problems</th
                  >{:else if view === "relations"}<th scope="col">Links out</th>{/if}
              </tr>
            </thead>
            <tbody>
              {#each groupRows as row}<tr aria-current={row.k === selected ? "true" : undefined}>
                  <th scope="row"><button class="link" onclick={() => toggleGroup(row.k)}>{row.g.label}</button></th>
                  <td>{row.n.toLocaleString()}</td>
                  {#if view === "use"}<td>{pct(row.unread + row.fresh, row.n)}</td>{:else if view === "problems"}<td
                      >{row.problems}</td
                    >{:else if view === "relations"}<td>{row.across}</td>{/if}
                </tr>{/each}
            </tbody>
          </table>
          <p class="muted small">{o.note}</p>
        </section>
      </aside>
    </div>
  {/if}
</div>

<style>
  .probe {
    position: absolute;
    visibility: hidden;
    pointer-events: none;
  }
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
    align-items: center;
  }
  .map-toolbar h1 {
    margin: 0;
  }
  .views {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    min-inline-size: 0;
  }
  .views button[aria-selected="true"] {
    color: var(--text);
    background: var(--surface-2);
    font-weight: 600;
  }
  .grow {
    flex: 1;
  }
  .flat {
    font-size: 13px;
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .question {
    margin: 6px 0 12px;
    color: var(--muted);
  }
  .map-body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 22rem;
    gap: 16px;
    block-size: min(76vh, 900px);
    min-block-size: 440px;
  }
  .map-stage {
    position: relative;
    border: 1px solid var(--border);
    background: var(--bg);
    min-inline-size: 0;
  }
  .map-main {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    gap: 8px;
    min-inline-size: 0;
    min-block-size: 0;
  }
  .map-legend {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 16px;
    min-block-size: 32px;
  }
  .map-legend ul {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 16px;
  }
  .map-legend p {
    margin: 0;
  }
  .map-legend ul,
  .map-side ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .map-legend li,
  .rows li {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 13px;
    min-block-size: 24px;
  }
  h3 {
    font-size: 12px;
    color: var(--muted);
    margin: 12px 0 6px;
  }
  .map-legend h3 {
    margin: 0;
  }
  .swatch {
    inline-size: 10px;
    block-size: 10px;
    border-radius: 50%;
    flex: none;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 30%, transparent);
  }
  .line {
    inline-size: 22px;
    border-top: 2px solid var(--text);
    flex: none;
  }
  .line.dashed {
    border-top: 2px dashed var(--accent);
  }
  .count {
    margin-inline-start: auto;
    color: var(--muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .map-side {
    overflow: auto;
    min-block-size: 0;
    display: grid;
    align-content: start;
    gap: 8px;
  }
  .stats {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }
  .stats div {
    display: grid;
    padding: 8px;
    border: 1px solid var(--border);
    background: var(--surface);
  }
  .stats strong {
    font-size: 18px;
    font-variant-numeric: tabular-nums;
  }
  .stats span {
    font-size: 12px;
    color: var(--muted);
  }
  .detail {
    padding: 10px 12px;
    border: 1px solid var(--border-strong);
    background: var(--surface);
  }
  .detail-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .detail h2 {
    font-size: 15px;
    margin: 0;
    flex: 1;
  }
  .assets li,
  .pairs li {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 8px;
    font-size: 13px;
    padding: 2px 0;
    min-inline-size: 0;
  }
  .assets a,
  .pairs a {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-inline-size: 100%;
  }
  .pairs li {
    flex-direction: column;
    padding: 4px 0;
    border-bottom: 1px solid var(--border);
  }
  .groups {
    inline-size: 100%;
    font-size: 13px;
    border-collapse: collapse;
  }
  .groups th,
  .groups td {
    text-align: start;
    padding: 3px 4px;
    border-bottom: 1px solid var(--border);
    font-weight: 400;
  }
  .groups td {
    text-align: end;
    font-variant-numeric: tabular-nums;
  }
  .groups thead th {
    color: var(--muted);
    font-size: 12px;
  }
  .groups tr[aria-current] {
    background: var(--accent-bg);
  }
  button.link {
    border: 0;
    background: none;
    padding: 0;
    color: var(--link);
    font: inherit;
    text-align: start;
    cursor: pointer;
  }
  button.link:hover {
    text-decoration: underline;
  }
  @media (max-width: 900px) {
    .map-body {
      grid-template-columns: 1fr;
      block-size: auto;
    }
    .map-main {
      block-size: 70vh;
    }
  }
</style>
