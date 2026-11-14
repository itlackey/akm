<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  // The whole library as a mind map, in three views, each answering one question: Contents (what is in it), Use (what
  // is read and what is dead weight) and Problems (what is wrong or duplicated). The map is the library, its asset
  // types, and the tags each type's assets carry most; every label is drawn. Choosing a type or a tag opens its figures
  // beside the map, and the list there gives the same figures as text.
  import { api } from "./client";
  import {
    buildOverview,
    firstProblem,
    makeUp,
    mindMap,
    OLD_DAYS,
    type Overview,
    type OverviewPayload,
    PROBLEMS,
    RECENT_DAYS,
    tally,
    USE_CLASSES,
    VIEWS,
    type View,
  } from "./library-overview";
  import { filesHref } from "./library-files-model";
  import { searchHref } from "./library-model";
  import MindMap, { type Segment } from "./MindMap.svelte";
  import { workspace } from "./state/workspace.svelte";

  /** `?select=<ref>`: open the tag this asset is under. */
  let { select: wanted = "" }: { select?: string } = $props();

  let o = $state.raw<Overview | null>(null);
  let error = $state("");
  let notice = $state("");
  let view = $state<View>("contents");
  let selected = $state("");

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
    } catch (cause) {
      error = (cause as Error).message;
    }
  }
  void load();

  const branches = $derived(o ? mindMap(o) : []);
  /** Every type and tag on the map by key, with its name and assets. */
  const parts = $derived(
    new Map(
      branches.flatMap((b) => [
        [b.key, { name: b.label, type: "", members: b.members }] as const,
        ...b.leaves.map((l) => [l.key, { name: l.label, type: b.label, members: l.members }] as const),
      ]),
    ),
  );
  const largestTag = $derived(Math.max(1, ...branches.flatMap((b) => b.leaves.map((l) => l.members.length))));
  $effect(() => {
    if (!o || !wanted) return;
    const i = o.ref.indexOf(wanted);
    if (i < 0) {
      notice = `No asset “${wanted}” is in the library.`;
      return;
    }
    const b = branches.find((x) => x.family === o!.family[i]);
    selected = b?.leaves.find((l) => l.members.includes(i))?.key ?? b?.key ?? "";
  });

  const all = $derived(o ? o.ref.map((_, i) => i) : []);
  const useOf = (members: readonly number[]) =>
    tally(
      members,
      (i) => o!.use[i],
      USE_CLASSES.map((u) => u.id),
    );
  const problemsOf = (members: readonly number[]) => members.filter((i) => o!.problems[i]!.length > 0).length;
  const useCounts = $derived(o ? useOf(all) : null);
  const problemAssets = $derived(
    o ? Object.fromEntries(PROBLEMS.map((p) => [p.id, all.filter((i) => o!.problems[i]!.includes(p.id))])) : {},
  );
  const makeup = $derived(o ? makeUp(o) : null);
  const sinceText = $derived(o?.useSince ? new Date(o.useSince).toLocaleDateString() : "");

  /** What a type's or tag's label says in each view. */
  function figure(members: number[]): string {
    if (view === "use" && o!.useKnown) return `${pct(useOf(members).recent, members.length)} read`;
    if (view === "problems") return plural(problemsOf(members), "problem");
    return members.length.toLocaleString();
  }
  /** The bar under a tag: its assets, split by what the view shows. */
  function bar(members: number[]): Segment[] {
    if (view === "use" && o!.useKnown) {
      const u = useOf(members);
      return USE_CLASSES.map((c) => ({ n: u[c.id], token: c.token }));
    }
    if (view === "problems") {
      const p = tally(
        members,
        (i) => firstProblem(o!, i),
        PROBLEMS.map((x) => x.id),
      );
      const none = members.length - PROBLEMS.reduce((sum, x) => sum + p[x.id], 0);
      return [...PROBLEMS.map((x) => ({ n: p[x.id], token: x.token })), { n: none, token: "--use-0" }];
    }
    return [{ n: members.length, token: `--map-${o!.family[members[0] ?? 0]! + 1}` }];
  }

  function choose(key: string) {
    selected = selected === key ? "" : key;
  }
  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape" && selected) selected = "";
  }

  // ---- Text beside the map ----
  const rows = $derived.by(() => {
    if (!o) return [];
    const out = branches.flatMap((b) =>
      b.leaves.map((l) => ({
        key: l.key,
        name: l.label,
        type: b.label,
        n: l.members.length,
        read: useOf(l.members).recent,
        problems: problemsOf(l.members),
      })),
    );
    if (view === "use") return out.sort((a, b) => a.read / a.n - b.read / b.n || b.n - a.n);
    if (view === "problems") return out.sort((a, b) => b.problems - a.problems || b.n - a.n);
    return out.sort((a, b) => b.n - a.n);
  });

  const detail = $derived.by(() => {
    const part = parts.get(selected);
    if (!o || !part) return null;
    const m = part.members;
    return {
      ...part,
      top: [...m].sort((a, b) => o!.shows[b]! - o!.shows[a]! || a - b).slice(0, 10),
      troubled: m.filter((i) => o!.problems[i]!.length).slice(0, 12),
      unused: m.filter((i) => o!.use[i] === "unread").slice(0, 12),
      makeup: makeUp(o, m),
      use: useOf(m),
    };
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
  const mapLabel = $derived(
    o
      ? `${question} A mind map of ${plural(o.count, "asset")}: the library, its asset types, and the tags each type's assets carry most. The list beside it gives the same figures.`
      : "",
  );
</script>

<svelte:window onkeydown={onKey} />
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
  </div>
  <p class="question">{question}</p>
  {#if error}<div class="notice notice-warn" role="alert">
      {error}<button class="btn-secondary" onclick={load}>Retry</button>
    </div>{/if}
  {#if notice}<p class="notice" role="status">{notice}</p>{/if}
  {#if o === null && !error && !notice}<p class="muted" role="status">Reading the library…</p>{/if}
  {#if o}
    <div class="map-body">
      <div class="map-main">
        <div class="map-legend">
          {#if view === "contents"}<p class="muted small">
              Each branch is an asset type; at its end are the tags its assets carry most. The bar under a tag is its
              number of assets. An asset with several of these tags is under each.
            </p>
          {:else if view === "use"}{#if o.useKnown}<ul>
                {#each USE_CLASSES as u}<li>
                    <span class="swatch" style={`background:var(${u.token})`}></span>{u.label}<span class="count"
                      >{useCounts?.[u.id].toLocaleString()}</span
                    >
                  </li>{/each}
              </ul>{:else}<p class="muted small">No usage history is available, so use cannot be shown.</p>{/if}
          {:else}<ul>
              {#each PROBLEMS as p}<li>
                  <span class="swatch" style={`background:var(${p.token})`}></span>{p.label}<span class="count"
                    >{problemAssets[p.id]?.length.toLocaleString()}</span
                  >
                </li>{/each}
              <li><span class="swatch" style="background:var(--use-0)"></span>No problem recorded</li>
            </ul>{/if}
        </div>
        <div class="map-stage">
          <MindMap
            {branches}
            rootLabel="Library"
            rootFigure={view === "contents" ? o.count.toLocaleString() : figure(all)}
            {figure}
            {bar}
            scale={largestTag}
            {selected}
            onSelect={choose}
            label={mapLabel}
          />
        </div>
      </div>
      <aside class="map-side" aria-label="Figures">
        {#if detail}<section class="detail" aria-live="polite">
            <div class="detail-head">
              <h2>
                {detail.name}{#if detail.type}<span class="muted"> · {detail.type}</span>{/if}
              </h2>
              <button class="btn-quiet" onclick={() => (selected = "")} aria-label="Close">✕</button>
            </div>
            <p class="muted small">{plural(detail.members.length, "asset")}</p>
            {#if view === "contents"}<h3>Bundles</h3>
              <ul class="rows">
                {#each detail.makeup.bundles as row}<li>{row.label}<span class="count">{row.count}</span></li>{/each}
              </ul>
            {:else if view === "use"}<ul class="rows">
                {#each USE_CLASSES as u}<li>
                    <span class="swatch" style={`background:var(${u.token})`}></span>{u.label}<span class="count"
                      >{detail.use[u.id]}</span
                    >
                  </li>{/each}
              </ul>
              {#if detail.unused.length}<h3>Not read, old</h3>
                <ul class="assets">
                  {#each detail.unused as i}<li><a href={open(o.ref[i]!)}>{o.path(i)}</a></li>{/each}
                </ul>{/if}
            {:else if detail.troubled.length}<ul class="assets">
                {#each detail.troubled as i}<li>
                    <a href={open(o.ref[i]!)}>{o.path(i)}</a>
                    <span class="muted small"
                      >{o.problems[i]!.map((p) => PROBLEMS.find((x) => x.id === p)!.label.toLowerCase()).join(
                        "; ",
                      )}</span
                    >
                  </li>{/each}
              </ul>{:else}<p class="muted small">No problems recorded here.</p>{/if}
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
              <div><strong>{o.tagNames.length.toLocaleString()}</strong><span>tags</span></div>
              <div><strong>{o.bundles.length}</strong><span>bundles</span></div>
            </div>
            <h3>Types</h3>
            <ul class="rows">
              {#each makeup?.families ?? [] as row}<li>
                  <span class="swatch" style={`background:var(--map-${row.slot + 1})`}></span>{row.label}<span
                    class="count">{row.count.toLocaleString()}</span
                  >
                </li>{/each}
            </ul>
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
        {:else}<section>
            <div class="stats">
              <div><strong>{problemAssets.outdated?.length ?? 0}</strong><span>outdated</span></div>
              <div><strong>{problemAssets.negative?.length ?? 0}</strong><span>disliked</span></div>
              <div>
                <strong>{o.duplicates.length}{o.duplicatesTruncated ? "+" : ""}</strong><span>duplicate pairs</span>
              </div>
            </div>
            {#if o.duplicates.length}<h3>Most alike pairs</h3>
              <ul class="pairs">
                {#each o.duplicates.slice(0, 6) as d}<li>
                    <a href={open(o.ref[d.a]!)}>{o.ref[d.a]}</a><a href={open(o.ref[d.b]!)}>{o.ref[d.b]}</a><span
                      class="muted small">cosine {d.cosine.toFixed(3)}</span
                    >
                  </li>{/each}
              </ul>
              <p class="muted small">
                Pairs whose content embeddings have a cosine of {o.duplicateThreshold} or more{o.duplicatesTruncated
                  ? "; only the 2,000 most alike are listed"
                  : ""}.
              </p>{/if}
          </section>{/if}

        <section>
          <h3>Tags on the map</h3>
          <table class="tag-table">
            <thead>
              <tr>
                <th scope="col">Tag</th>
                <th scope="col">Assets</th>
                {#if view === "use"}<th scope="col">Read</th>{:else if view === "problems"}<th scope="col">Problems</th
                  >{/if}
              </tr>
            </thead>
            <tbody>
              {#each rows as row (row.key)}<tr aria-current={row.key === selected ? "true" : undefined}>
                  <th scope="row"
                    ><button class="link" onclick={() => choose(row.key)}>{row.name}</button>
                    <span class="muted small">{row.type}</span></th
                  >
                  <td>{row.n.toLocaleString()}</td>
                  {#if view === "use"}<td>{pct(row.read, row.n)}</td>{:else if view === "problems"}<td
                      >{row.problems}</td
                    >{/if}
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
  .question {
    margin: 6px 0 12px;
    color: var(--muted);
  }
  .map-body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 22rem;
    gap: 24px;
    align-items: start;
  }
  .map-main {
    display: grid;
    gap: 8px;
    min-inline-size: 0;
  }
  .map-stage {
    border: 1px solid var(--border);
    background: var(--surface);
    padding: 8px;
    min-inline-size: 0;
  }
  .map-legend {
    min-block-size: 24px;
  }
  .map-legend ul {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 16px;
  }
  .map-legend p {
    margin: 0;
    max-inline-size: 60rem;
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
  .swatch {
    inline-size: 10px;
    block-size: 10px;
    border-radius: 2px;
    flex: none;
  }
  .count {
    margin-inline-start: auto;
    color: var(--muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .map-side {
    display: grid;
    align-content: start;
    gap: 8px;
    min-inline-size: 0;
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
  .tag-table {
    inline-size: 100%;
    font-size: 13px;
    border-collapse: collapse;
  }
  .tag-table th,
  .tag-table td {
    text-align: start;
    padding: 4px;
    border-bottom: 1px solid var(--border);
    font-weight: 400;
    vertical-align: baseline;
  }
  .tag-table td {
    text-align: end;
    font-variant-numeric: tabular-nums;
  }
  .tag-table thead th {
    color: var(--muted);
    font-size: 12px;
  }
  .tag-table tr[aria-current] {
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
  /* The map needs about 1,000 px to be read at full size; below that the figures go under it. */
  @media (max-width: 1400px) {
    .map-body {
      grid-template-columns: 1fr;
    }
  }
</style>
