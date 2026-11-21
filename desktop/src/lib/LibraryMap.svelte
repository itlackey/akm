<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  // The library, or one bundle of it, as a mind map of asset types and the tags their assets carry. Choosing a type or a
  // tag draws what it is joined to (declared links and near-duplicate content) and fills the side column with what that
  // group needs: how much of it is read, what is outdated, disliked or duplicated, what it connects to, which bundles
  // repeat it, what people searched for and did not find, and, for any asset, the content closest to it in meaning.
  import { api, apiState } from "./client";
  import {
    buildOverview,
    DAY,
    firstProblem,
    flatPlace,
    groupFacts,
    groupJoins,
    groupsOf,
    mindMap,
    OUTDATED_LINKS,
    type Overview,
    type OverviewPayload,
    type Pair,
    PROBLEMS,
    OLD_DAYS,
    RECENT_DAYS,
    relations,
    tally,
    unplaced,
    USE_CLASSES,
    VIEWS,
    type View,
  } from "./library-overview";
  import { joinsOf, LEVEL_CAP, LEVEL_STYLES, reach } from "./link-levels";
  import { filesHref } from "./library-files-model";
  import { libraryRead, searchHref } from "./library-model";
  import MindMap, { type Segment } from "./MindMap.svelte";
  import SimilarityMap from "./SimilarityMap.svelte";
  import { workspace } from "./state/workspace.svelte";

  /** `?select=<ref>`: open the tag this asset is under. */
  let { select: wanted = "" }: { select?: string } = $props();

  type Miss = { query: string; count: number; lastAt: string };
  type Similar = { ref: string; title: string; cosine: number };

  let o = $state.raw<Overview | null>(null);
  let misses = $state.raw<Miss[]>([]);
  /** Why the searches that found nothing could not be read, when they could not. */
  let missesNote = $state("");
  let error = $state("");
  let notice = $state("");
  let view = $state<View>("contents");
  let bundle = $state(-1);
  let selected = $state("");
  /** Words typed to narrow the map: an asset matches when its name and tags together contain every one. */
  let filter = $state("");
  /** The `?select=` asset already opened, so choosing anything else, or resetting, is not undone by it. */
  let opened = "";
  /** The drawing: the mind map of types and tags (SVG), or every asset as a point by meaning (three.js) in one plane
   * or in 3D; unchosen, the plane when the index has assets grouped by meaning: it is read faster than 3D, which is
   * one choice away. */
  let chosenDrawing = $state<"tags" | "2d" | "3d" | null>(null);
  const drawing = $derived(chosenDrawing ?? (o?.groupCount ? "2d" : "tags"));
  const points = $derived(drawing !== "tags");
  const flat = $derived(drawing === "2d");
  const place = $derived(o ? (flat ? flatPlace(o) : o.place) : new Float32Array(0));
  const DRAWINGS = [
    ["tags", "Tags", "The asset types and the tags their assets carry most"],
    ["2d", "2D", "Every asset as a point, placed by meaning, in one plane"],
    ["3d", "3D", "Every asset as a point, placed by meaning, in 3D"],
  ] as const;
  /** In 3D, the asset chosen on the map, or -1. */
  let picked = $state(-1);
  /** The asset whose closest content is open, and what was found. */
  let near = $state<{ ref: string; matches: Similar[] | null; error: string } | null>(null);

  const open = (ref: string) => searchHref(new URLSearchParams(), ref);
  const compare = (a: string, b: string) =>
    `/library/search?${new URLSearchParams([
      ["compare", a],
      ["compare", b],
    ])}`;
  const pct = (part: number, whole: number) => (whole ? `${Math.round((100 * part) / whole)}%` : "–");
  const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
  const short = (ref: string) => ref.split("//").at(-1) ?? ref;

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
    try {
      misses = (await apiState<{ misses: Miss[] }>("/search/misses", { since: "90d" })).misses;
    } catch (cause) {
      misses = [];
      missesNote = (cause as Error).message;
    }
  }
  void load();

  /** The assets in the bundle chosen, or in all of them. */
  const bundleScope = $derived(o ? o.ref.map((_, i) => i).filter((i) => bundle < 0 || o!.bundle[i] === bundle) : []);
  const words = $derived(filter.toLowerCase().split(/\s+/).filter(Boolean));
  /** The assets of the bundle whose name or tags hold every word typed. */
  const found = $derived(
    o && words.length
      ? bundleScope.filter((i) => {
          const text = `${o!.ref[i]} ${(o!.tags[i] ?? []).map((t) => o!.tagNames[t]).join(" ")}`.toLowerCase();
          return words.every((w) => text.includes(w));
        })
      : bundleScope,
  );
  /** The assets whose name or tags hold every word typed, or null when nothing is typed. */
  const matching = $derived(o && words.length ? new Set(found) : null);
  /** The assets in scope: those of the bundle that match what is typed. */
  const scope = $derived(matching ? bundleScope.filter((i) => matching.has(i)) : bundleScope);
  const readsOf = (members: readonly number[]) => members.reduce((sum, i) => sum + o!.shows[i]!, 0);
  // Each view draws the tags its question is about: the largest, the most read, or the ones with most problems.
  const branches = $derived(
    o ? mindMap(o, 44, scope, view === "use" ? readsOf : view === "problems" ? (m) => problemsOf(m) : undefined) : [],
  );
  /** Groups by meaning, for the 3D map. */
  const groups = $derived(o ? groupsOf(o, bundleScope) : []);
  const parts = $derived(
    new Map<string, { name: string; type: string; tag: string; group: boolean; members: number[] }>([
      ...branches.flatMap((b) => [
        [b.key, { name: b.label, type: "", tag: "", group: false, members: b.members }] as const,
        ...b.leaves.map(
          (l) => [l.key, { name: l.label, type: b.label, tag: l.label, group: false, members: l.members }] as const,
        ),
      ]),
      ...groups.map((g) => [g.key, { name: g.label, type: "", tag: "", group: true, members: g.members }] as const),
    ]),
  );
  const largestTag = $derived(Math.max(1, ...branches.flatMap((b) => b.leaves.map((l) => l.members.length))));
  $effect(() => {
    if (!o || !wanted || opened === wanted) return;
    const i = o.ref.indexOf(wanted);
    if (i < 0) {
      notice = `No asset “${wanted}” is in the library.`;
      return;
    }
    const b = branches.find((x) => x.members.includes(i));
    selected = b?.leaves.find((l) => l.members.includes(i))?.key ?? b?.key ?? "";
    opened = wanted;
  });

  const useOf = (members: readonly number[]) =>
    tally(
      members,
      (i) => o!.use[i] ?? null,
      USE_CLASSES.map((u) => u.id),
    );
  function problemsOf(members: readonly number[]) {
    return members.filter((i) => o!.problems[i]!.length > 0).length;
  }

  /** What a type's or tag's label says in each view. */
  function figure(members: number[]): string {
    if (view === "use" && o!.useKnown) return `${plural(readsOf(members), "read")}`;
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
    picked = -1;
    near = null;
  }
  /** A point chosen on the 3D map: it and its group. */
  function pick(i: number) {
    if (picked === i) {
      choose(selected);
      return;
    }
    selected = `g:${o!.group[i]}`;
    picked = i;
    near = null;
  }
  /** The arrow keys on the 3D map: the previous or next asset of the picked one's group, in name order; with nothing
   * picked, the first of the first group. */
  function step(direction: -1 | 1) {
    const group = groups.find((g) => g.key === (picked >= 0 ? `g:${o!.group[picked]}` : ""));
    const order = [...(group ?? groups[0])!.members].sort((a, b) => (o!.ref[a]! < o!.ref[b]! ? -1 : 1));
    const at = order.indexOf(picked);
    const next = at < 0 ? order[0] : order[(at + direction + order.length) % order.length];
    if (next !== undefined && next !== picked) pick(next);
  }
  /** The lists opened to their full length, by name. */
  let whole = $state<Record<string, boolean>>({});
  /** The panel beside the map: it shows its top again whenever what is chosen changes. */
  let side = $state<HTMLElement>();
  $effect(() => {
    void selected;
    void picked;
    void view;
    if (side) side.scrollTop = 0;
  });
  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape" && filter && event.target instanceof HTMLInputElement) filter = "";
    else if (event.key === "Escape" && picked >= 0) picked = -1;
    else if (event.key === "Escape" && selected) choose(selected);
  }

  // ---- The side column ----
  const part = $derived(parts.get(selected) ?? null);
  const members = $derived(part?.members ?? scope);
  const facts = $derived(o ? groupFacts(o, members) : null);
  // Problems draws only what makes a problem: replacement and contradiction links, and near-duplicates.
  const joined = $derived(
    !o || !selected
      ? []
      : selected.startsWith("g:")
        ? groupJoins(o, Number(selected.slice(2)), view === "problems" ? OUTDATED_LINKS : null)
        : relations(o, branches, selected, view === "problems" ? OUTDATED_LINKS : null),
  );
  const top = (list: readonly number[], by: (i: number) => number) =>
    list.filter((i) => by(i) > 0).sort((a, b) => by(b) - by(a) || a - b);
  const mostRead = $derived(o ? top(members, (i) => o!.shows[i]!) : []);
  const mostLinked = $derived(o ? top(members, (i) => o!.degree[i]!) : []);
  /** Never read in the window, the longest unchanged first. */
  const neverRead = $derived(
    o
      ? members
          .filter((i) => o!.use[i] === "unread" || o!.use[i] === "new")
          .sort((a, b) => (o!.modified[a] ?? "").localeCompare(o!.modified[b] ?? "") || a - b)
      : [],
  );
  /** Dead weight: never read in the window and not edited for long, the longest unchanged first. */
  const deadWeight = $derived(neverRead.filter((i) => o!.use[i] === "unread"));
  /** More negative feedback than positive, and still being read: the most read first. */
  const dislikedRead = $derived(o && facts ? top(facts.disliked, (i) => o!.shows[i]!) : []);
  /** Outdated assets still being read, the most read first; and the rest of the outdated. */
  const outdatedRead = $derived(o && facts ? top(facts.outdated, (i) => o!.shows[i]!) : []);
  const outdatedUnread = $derived(o && facts ? facts.outdated.filter((i) => !o!.shows[i]) : []);
  /** No declared link either way, the most read first: an asset agents use that nothing leads to. */
  const unlinked = $derived(
    o ? members.filter((i) => !o!.degree[i]).sort((a, b) => o!.shows[b]! - o!.shows[a]! || a - b) : [],
  );
  /** Near-duplicate pairs whose two assets are in different bundles. */
  const acrossBundles = $derived(
    o && facts
      ? [...facts.duplicatesInside, ...facts.duplicatesOutside].filter((d) => o!.bundle[d.a] !== o!.bundle[d.b])
      : [],
  );
  /** What a group's name says on the map: the view's figure for that group. */
  function groupNote(g: { members: number[] }): string {
    if (view === "use")
      return o!.useKnown
        ? `${pct(g.members.filter((i) => o!.use[i] === "unread" || o!.use[i] === "new").length, g.members.length)} never read`
        : "";
    if (view === "problems") {
      const n = problemsOf(g.members);
      return n ? `${n.toLocaleString()} to fix` : "nothing to fix";
    }
    const types = new Map<string, number>();
    for (const i of g.members) types.set(o!.types[o!.type[i]!]!, (types.get(o!.types[o!.type[i]!]!) ?? 0) + 1);
    const [name, n] = [...types].sort((x, y) => y[1] - x[1])[0] ?? ["", 0];
    return name ? `${pct(n, g.members.length)} ${name}` : "";
  }
  const liked = $derived(o ? members.filter((i) => o!.positive[i]! > o!.negative[i]!).length : 0);
  /** What the group is made of: its bundles and its asset types, largest first. */
  const madeOf = $derived.by(() => {
    const count = (label: (i: number) => string) => {
      const m = new Map<string, number>();
      for (const i of members) m.set(label(i), (m.get(label(i)) ?? 0) + 1);
      return [...m].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
    };
    return o
      ? { bundles: count((i) => o!.bundles[o!.bundle[i]!]!), types: count((i) => o!.types[o!.type[i]!]!) }
      : { bundles: [], types: [] };
  });
  const edited = (i: number) => (o!.modified[i] ? `edited ${new Date(o!.modified[i]!).toLocaleDateString()}` : "");
  /** Whether a query uses a tag as a whole word or phrase ("secret" does not mention "sec"). */
  const mentions = (query: string, tag: string) =>
    ` ${query.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `.includes(` ${tag.replace(/[^a-z0-9]+/g, " ").trim()} `);
  /** Searches that found nothing: for a tag, the ones that mention it. */
  const gaps = $derived(part?.tag ? misses.filter((m) => mentions(m.query, part.tag)).slice(0, 6) : misses.slice(0, 6));
  /** Assets in the bundle that are not points on the 3D map: akm's stored layout has no group for them. */
  const offMap = $derived(o ? unplaced(o, bundleScope) : 0);
  const scopeName = $derived(bundle < 0 ? "All bundles" : (o?.bundles[bundle] ?? ""));
  const nameOf = (key: string) => {
    const p = parts.get(key);
    if (!p) return key;
    return p.group || p.type ? (p.type ? `${p.name} · ${p.type}` : p.name) : `${p.name}, under no tag on the map`;
  };

  async function similar(ref: string) {
    if (near?.ref === ref) {
      near = null;
      return;
    }
    near = { ref, matches: null, error: "" };
    try {
      const result = await libraryRead<{ matches: Similar[] }>("/asset/related", { ref, scope: "all" });
      if (near?.ref === ref) near = { ref, matches: result.matches.slice(0, 6), error: "" };
    } catch (cause) {
      if (near?.ref === ref) near = { ref, matches: [], error: (cause as Error).message };
    }
  }

  // ---- The 3D map ----
  /** Contents colours a point by its group (hues spaced by the golden angle), Use by its use, Problems by its problem. */
  const colourOf = (i: number) => {
    if (view === "use" && o!.useKnown) return USE_CLASSES.find((u) => u.id === o!.use[i])?.token ?? "--border";
    if (view === "problems") return PROBLEMS.find((p) => p.id === firstProblem(o!, i))?.token ?? "--border";
    return `hsl(${Math.round((o!.group[i]! * 137.508) % 360)} 62% 56%)`;
  };
  /** Every join akm reports for this view: declared links (Problems: replacement and contradiction only) and
   * near-duplicates. */
  const allJoins = $derived(o ? joinsOf(o, view === "problems" ? OUTDATED_LINKS : null) : []);
  /** What the picked asset is joined to directly. */
  const pickedJoins = $derived.by(() => {
    const out: Array<{ i: number; what: string }> = [];
    if (picked >= 0)
      for (const j of allJoins)
        if (j.a === picked || j.b === picked) out.push({ i: j.a === picked ? j.b : j.a, what: j.what });
    return out;
  });
  /** What it is joined to one, two and three steps out. */
  const reached = $derived(o && picked >= 0 ? reach(allJoins, o.count, picked) : null);
  /** Whether an asset is a point on this map: it has a group by meaning and is in the bundle chosen. */
  const drawn = (i: number) => o!.group[i]! >= 0 && (bundle < 0 || o!.bundle[i] === bundle);
  /** Per level: the assets shown on the map, those reached but not on it, and those cut by the cap. */
  const levelFigures = $derived(
    reached?.levels.map((l) => {
      const shown = l.nodes.filter(drawn);
      return { shown, off: l.nodes.length - shown.length, cut: l.cut };
    }) ?? null,
  );
  const lit = $derived(
    picked >= 0
      ? new Set([picked, ...(reached?.levels.flatMap((l) => l.nodes) ?? [])])
      : part?.group
        ? new Set(matching ? part.members.filter((i) => matching.has(i)) : part.members)
        : matching,
  );
  const lines = $derived.by(() => {
    if (!o) return [];
    if (picked >= 0)
      return (reached?.links ?? [])
        .filter((l) => drawn(l.a) && drawn(l.b))
        .map((l) => ({ from: l.a, to: l.b, weight: 1, level: l.level }));
    // A chosen group's joins to other groups are drawn where the panel lists them: not in Use.
    if (!part?.group || view === "use") return [];
    const strongest = Math.max(1, ...joined.map((r) => r.links + r.duplicates));
    return joined
      .slice(0, 12)
      .filter((r) => groups.some((g) => g.key === r.key))
      .map((r) => ({ from: selected, to: r.key, weight: (r.links + r.duplicates) / strongest }));
  });
  /** What a point's size stands for: links in Contents, so a large point is a hub, and reads in Problems, so a large
   * coloured point is a problem still in use. Use draws one size: what it looks for is what is not read. */
  const size = $derived.by(() => {
    if (!o || view === "use" || (view === "problems" && !o.useKnown)) return null;
    const values = view === "contents" ? o.degree : o.shows;
    return {
      label: view === "contents" ? "links" : "reads",
      values,
      largest: Math.max(0, ...bundleScope.map((i) => values[i]!)),
    };
  });
  /** What an asset's colour, depth and size stand for, in akm's recorded figures: said after its name on the map. */
  const ago = (iso: string) => {
    const days = Math.floor((o!.at - Date.parse(iso)) / DAY);
    return days < 1 ? "today" : `${plural(days, "day")} ago`;
  };
  /** The usage window in words: "the last 90 days". */
  const windowText = $derived(
    o?.useSince ? `the last ${Math.round((o.at - Date.parse(o.useSince)) / DAY)} days` : "the usage window",
  );
  const reads = (i: number) =>
    !o!.useKnown
      ? "reads unknown"
      : o!.shows[i]
        ? `read ${plural(o!.shows[i]!, "time")}${o!.lastShown[i] ? `, last ${ago(o!.lastShown[i]!)}` : ""}`
        : `not read in ${windowText}`;
  /** How long since an asset's file was changed, in words: "untouched 19 months". */
  const untouched = (i: number) => {
    if (!o!.modified[i]) return "";
    const days = Math.floor((o!.at - Date.parse(o!.modified[i]!)) / DAY);
    return `untouched ${days < 60 ? plural(days, "day") : days < 730 ? plural(Math.floor(days / 30), "month") : plural(Math.floor(days / 365), "year")}`;
  };
  const problem = (i: number) => PROBLEMS.find((p) => p.id === firstProblem(o!, i))?.label.toLowerCase();
  /** Why an outdated asset is outdated, and how much it is still read. */
  const outdatedNote = (i: number) =>
    [
      [...new Set(o!.outdatedWhy[i]!.map((why) => why.split(" ")[0]))].join(", "),
      o!.shows[i] ? plural(o!.shows[i]!, "read") : "",
    ]
      .filter(Boolean)
      .join(" · ");
  /** The near-duplicate pairs an asset is in. */
  const pairsOf = (i: number) => o!.duplicates.filter((d) => d.a === i || d.b === i);
  function describe(i: number): string {
    const colour =
      view === "use"
        ? reads(i)
        : view === "problems"
          ? (problem(i) ?? "no problem recorded")
          : (parts.get(`g:${o!.group[i]}`)?.name ?? "");
    const bySize = view === "contents" ? plural(o!.degree[i]!, "link") : view === "problems" ? reads(i) : "";
    return [...new Set([colour, bySize])].filter(Boolean).join(" · ");
  }

  const filesLink = $derived(
    filesHref({
      bundle: workspace.bundles.find((b) => b.default)?.name ?? workspace.bundles.find((b) => b.enabled)?.name ?? "",
      path: "",
    }),
  );
  const question = $derived(VIEWS.find((v) => v.id === view)!.question);
  const mapLabel = $derived(
    o
      ? `${question} A mind map of ${plural(scope.length, "asset")} in ${scopeName}: asset types and the tags their assets carry most. Choosing one draws what it is joined to; the column beside it gives its figures.`
      : "",
  );
</script>

{#snippet assetList(list: number[], note: (i: number) => string = () => "", limit = 8, id = "")}
  {@const shown = whole[id] ? list.length : limit}
  <ul class="read">
    {#each list.slice(0, shown) as i}<li class="read-row">
        <a href={open(o!.ref[i]!)} title={o!.ref[i]}>{short(o!.ref[i]!)}</a>{#if note(i)}<span class="count"
            >{note(i)}</span
          >{/if}
      </li>{/each}
  </ul>
  {#if list.length > limit}{#if id}<button class="link more" onclick={() => (whole = { ...whole, [id]: !whole[id] })}
        >{whole[id] ? "Show fewer" : `Show all ${list.length.toLocaleString()}`}</button
      >{:else}<p class="more">and {(list.length - limit).toLocaleString()} more</p>{/if}{/if}
{/snippet}

{#snippet stat(n: number | string, text: string, token = "")}
  <li>
    <span class="swatch" style={token ? `background:var(${token})` : ""}></span><strong
      >{typeof n === "number" ? n.toLocaleString() : n}</strong
    ><span>{text}</span>
  </li>
{/snippet}

{#snippet pairList(list: Pair[], limit = 8)}
  <ul class="pairs">
    {#each list.slice(0, limit) as d}<li>
        <a href={open(o!.ref[d.a]!)} title={o!.ref[d.a]}>{short(o!.ref[d.a]!)}</a>
        <span class="pair-foot"
          ><a href={open(o!.ref[d.b]!)} title={o!.ref[d.b]}>{short(o!.ref[d.b]!)}</a><span class="muted"
            >{Math.round(d.cosine * 100)}% alike</span
          ><a href={compare(o!.ref[d.a]!, o!.ref[d.b]!)}>Compare</a></span
        >
      </li>{/each}
  </ul>
  {#if list.length > limit}<p class="more">and {(list.length - limit).toLocaleString()} more</p>{/if}
{/snippet}

{#snippet connects(what: string)}
  <section>
    <h3>How it connects</h3>
    <dl class="figures">
      <dt>Assets with links</dt>
      <dd>{pct(facts!.linked, facts!.count)}</dd>
      {#if part || bundle >= 0}<dt>Links to the rest of the library</dt>
        <dd>{facts!.linksOut.toLocaleString()}</dd>{/if}
    </dl>
    {#if selected}<p class="muted small">{what}:</p>
      {#if joined.length}<ul class="joined">
          {#each joined.slice(0, 10) as r}<li>
              <button class="link" onclick={() => choose(r.key)}>{nameOf(r.key)}</button>
              <span class="muted small"
                >{r.links ? plural(r.links, "link") : ""}{r.links && r.duplicates ? " · " : ""}{r.duplicates
                  ? plural(r.duplicates, "duplicate")
                  : ""}</span
              >
            </li>{/each}
        </ul>{:else}<p class="muted small">Nothing on the map.</p>{/if}
    {:else}<p class="muted small">Choose a type or tag on the map to see what it is joined to.</p>{/if}
  </section>
{/snippet}

{#snippet overlap()}
  {#if facts!.overlap.length}<section>
      <h3>Repeated in other bundles</h3>
      <ul class="rows">
        {#each facts!.overlap.slice(0, 6) as row}<li>
            {row.bundle}<span class="count">{plural(row.pairs, "near-duplicate pair")}</span>
          </li>{/each}
      </ul>
    </section>{/if}
{/snippet}

<svelte:window onkeydown={onKey} />
<div class="map-head">
  <nav class="library-views" aria-label="Library views" data-sveltekit-reset="false">
    <a href="/library/search">Search</a>
    <a href={filesLink}>Files</a>
    <a href="/library/map" aria-current="page">Map</a>
  </nav>
  <h1 class="sr-only">Library map</h1>
  <div class="views" role="tablist" aria-label="Question">
    {#each VIEWS as v}<button
        role="tab"
        aria-selected={view === v.id}
        class="btn-quiet"
        title={v.question}
        onclick={() => (view = v.id)}>{v.label}</button
      >{/each}
  </div>
  {#if o}<label class="bundle-pick"
      >Bundle <select
        bind:value={bundle}
        onchange={() => {
          selected = "";
          near = null;
        }}
        ><option value={-1}>All bundles</option>{#each o.bundles as name, b}<option value={b}>{name}</option
          >{/each}</select
      ></label
    >{/if}
</div>
<div class="map-page">
  {#if error}<div class="notice notice-warn" role="alert">
      {error}<button class="btn-secondary" onclick={load}>Retry</button>
    </div>{/if}
  {#if notice}<p class="notice" role="status">{notice}</p>{/if}
  {#if o === null && !error && !notice}<p class="muted" role="status">Reading the library…</p>{/if}
  {#if o && facts}
    {#if points}<p class="sr-only" role="status">
        {picked >= 0 && levelFigures
          ? `Selected ${o.ref[picked]}. ${levelFigures.map((l, k) => `${LEVEL_STYLES[k]!.label}: ${plural(l.shown.length, "asset")}`).join(". ")}.`
          : ""}
      </p>{/if}
    <div class="map-body">
      <div class="map-stage">
        <div class="stage-tools">
          <div class="views" role="group" aria-label="Drawing">
            {#each DRAWINGS as [id, name, title]}<button
                class="btn-quiet"
                aria-pressed={drawing === id}
                {title}
                onclick={() => (chosenDrawing = id)}>{name}</button
              >{/each}
          </div>
          <label class="map-filter"
            ><span class="sr-only">Filter</span><input
              type="search"
              bind:value={filter}
              placeholder="Find by name or tag"
              autocomplete="off"
            /></label
          >
          {#if matching}<span class="muted small" role="status"
              >{matching.size.toLocaleString()} of {plural(bundleScope.length, "asset")}</span
            >{/if}
        </div>
        {#if points}{#if groups.length}<SimilarityMap
              {o}
              {place}
              {flat}
              {size}
              {describe}
              {groupNote}
              scope={bundleScope}
              {groups}
              {colourOf}
              {lit}
              {lines}
              levels={levelFigures
                ? [levelFigures[0]!.shown, levelFigures[1]!.shown, levelFigures[2]!.shown]
                : undefined}
              {picked}
              {selected}
              related={joined.slice(0, 12).map((r) => r.key)}
              onPick={pick}
              onGroup={choose}
              onStep={step}
              label={`${question} The ${plural(bundleScope.length - offMap, "asset")} of ${scopeName} that have a group by meaning, as points, in ${plural(groups.length, "group")} named by their tags, groups alike in meaning near each other.${offMap ? ` ${plural(offMap, "asset")} not shown.` : ""}`}
            >
              {#snippet legend()}
                {#if picked >= 0 && levelFigures?.some((l) => l.shown.length)}<div class="levels">
                    <p class="small">
                      <strong>{short(o!.ref[picked]!)}</strong> and what it is joined to, three steps out. A join is drawn
                      once, at the nearest level it belongs to.
                    </p>
                    <ul>
                      {#each LEVEL_STYLES as style, k}
                        {@const f = levelFigures[k]!}
                        {@const colour = `color-mix(in srgb, var(--map-highlight) ${Math.round(100 - 100 * style.mute)}%, var(--bg))`}
                        <li>
                          <svg class="level-key" width="46" height="26" viewBox="0 0 46 26" aria-hidden="true">
                            <line
                              x1="2"
                              x2="30"
                              y1="13"
                              y2="13"
                              style={`stroke:${colour}`}
                              stroke-width={style.width}
                              stroke-dasharray={style.dash ? "5 3" : undefined}
                            />
                            <circle
                              cx="36"
                              cy="13"
                              r={style.ring / 2 - 1.5}
                              fill="none"
                              style={`stroke:${colour}`}
                              stroke-width="2"
                            />
                          </svg>
                          <span
                            >{style.label}: {plural(f.shown.length, "asset")}{f.off
                              ? `, ${f.off.toLocaleString()} not on this map`
                              : ""}{f.cut
                              ? `, ${f.cut.toLocaleString()} more not shown (a level shows its ${LEVEL_CAP} most joined assets)`
                              : ""}</span
                          >
                        </li>
                      {/each}
                    </ul>
                  </div>{/if}{/snippet}
            </SimilarityMap>
            {#if offMap}<p class="muted small map-note" role="status">
                {plural(offMap, "asset")}
                {offMap === 1 ? "has" : "have"} no group by meaning, so {offMap === 1 ? "is" : "are"} not shown (not embedded,
                or added since the last index build).
              </p>{/if}{:else}<p class="notice">
              No stored embeddings, so assets cannot be placed by meaning. Build the index with embeddings, or use Tags.
            </p>{/if}
        {:else}<MindMap
            {branches}
            rootLabel={scopeName}
            rootFigure={view === "contents" ? scope.length.toLocaleString() : figure(scope)}
            {figure}
            {bar}
            scale={largestTag}
            {selected}
            related={joined.slice(0, 12)}
            onSelect={choose}
            label={mapLabel}
          />{/if}
      </div>

      <aside class="map-side" aria-label="Figures" aria-live="polite" bind:this={side}>
        {#if picked >= 0}
          {@const i = picked}
          <header class="side-head">
            <div>
              <h2>{short(o.ref[i]!)}</h2>
              <p class="muted small">{o.types[o.type[i]!]} · {o.bundles[o.bundle[i]!]} · {nameOf(`g:${o.group[i]}`)}</p>
            </div>
            <button class="btn-quiet" onclick={() => (picked = -1)} aria-label="Close">✕</button>
          </header>
          <section>
            <div class="actions">
              <a class="btn btn-secondary" href={open(o.ref[i]!)}>Open</a>
              <button
                class="btn-secondary"
                aria-expanded={near?.ref === o.ref[i]}
                onclick={() => similar(o!.ref[i]!)}
                title="The assets closest to this one in meaning, with their measured similarity">Most similar</button
              >
            </div>
            {#if o.problems[i]!.length}<ul class="wrong">
                {#if o.problems[i]!.includes("outdated")}<li>
                    <strong>Outdated:</strong>
                    {o.outdatedWhy[i]!.join(", ")}. Open it to retire it or fix the link.
                  </li>{/if}
                {#if o.problems[i]!.includes("negative")}<li>
                    <strong>Disliked:</strong>
                    {o.negative[i]} down, {o.positive[i]} up. Open it to fix what readers found wrong.
                  </li>{/if}
                {#each pairsOf(i) as d}{@const other = d.a === i ? d.b : d.a}
                  <li>
                    <strong>Nearly the same as</strong>
                    <button class="link" onclick={() => pick(other)} title={o.ref[other]}>{short(o.ref[other]!)}</button
                    >
                    ({Math.round(d.cosine * 100)}% alike).
                    <a href={compare(o.ref[i]!, o.ref[other]!)}>Compare</a> and keep one.
                  </li>{/each}
              </ul>{/if}
            <dl class="figures">
              <dt>Reads</dt>
              <dd>{reads(i)}</dd>
              <dt>Last edited</dt>
              <dd>{o.modified[i] ? new Date(o.modified[i]!).toLocaleDateString() : "unknown"}</dd>
              <dt>Feedback</dt>
              <dd>{o.feedbackKnown ? `${o.positive[i]} positive · ${o.negative[i]} negative` : "unavailable"}</dd>
              <dt>Links</dt>
              <dd>{o.degree[i]!.toLocaleString()}</dd>
            </dl>
            {#if near?.ref === o.ref[i]}<div class="near">
                {#if near.error}<p class="muted small">{near.error}</p>
                {:else if !near.matches}<p class="muted small">Finding the closest content…</p>
                {:else if !near.matches.length}<p class="muted small">No embedded content to compare.</p>
                {:else}<ul>
                    {#each near.matches as m}<li>
                        <a href={open(m.ref)} title={m.ref}>{short(m.ref)}</a><span class="muted small"
                          >{m.cosine.toFixed(2)}</span
                        ><a class="small" href={compare(o.ref[i]!, m.ref)}>Compare</a>
                      </li>{/each}
                  </ul>{/if}
              </div>{/if}
          </section>
          {#if pickedJoins.length}<section>
              <h3>Joined to</h3>
              <ul class="rows">
                {#each pickedJoins.slice(0, 12) as j}<li>
                    <button class="link" onclick={() => pick(j.i)} title={o.ref[j.i]}>{short(o.ref[j.i]!)}</button><span
                      class="count">{j.what}</span
                    >
                  </li>{/each}
              </ul>
            </section>{/if}
        {:else}
          <header class="side-head">
            <div>
              <h2>{part ? part.name : scopeName}</h2>
              <p class="muted small">
                {part
                  ? `${part.group ? "Group by meaning · " : part.type ? `Tag in ${part.type} · ` : "Asset type · "}${scopeName}`
                  : "The whole scope"} ·
                {plural(facts.count, "asset")}
              </p>
            </div>
            {#if part}<button class="btn-quiet" onclick={() => choose(selected)} aria-label="Close">✕</button>{/if}
          </header>

          {#if view === "contents"}
            <ul class="stats">
              {@render stat(facts.count, madeOf.types.map(([name, n]) => `${n.toLocaleString()} ${name}`).join(", "))}
              {#if madeOf.bundles.length > 1}{@render stat(
                  madeOf.bundles.length,
                  `bundles: ${madeOf.bundles.map(([name, n]) => `${name} ${n.toLocaleString()}`).join(", ")}`,
                )}{/if}
              {@render stat(unlinked.length, "not linked to or from anything")}
              {#if madeOf.bundles.length > 1 && o.duplicatesKnown}{@render stat(
                  acrossBundles.length,
                  "near-identical pairs in two different bundles",
                )}{/if}
            </ul>
            <section>
              <h3>Not linked to anything, most read first</h3>
              {#if unlinked.length}{@render assetList(
                  unlinked,
                  (i) => (o!.useKnown ? plural(o!.shows[i]!, "read") : ""),
                  5,
                  "unlinked",
                )}{:else}<p class="muted small">Every asset here has a link.</p>{/if}
            </section>
            {#if acrossBundles.length}<section>
                <h3>The same content in two bundles</h3>
                {@render pairList(acrossBundles, 3)}
              </section>{/if}
            <section>
              <h3>Most linked</h3>
              {#if mostLinked.length}{@render assetList(
                  mostLinked,
                  (i) => plural(o!.degree[i]!, "link"),
                  5,
                  "linked",
                )}{:else}<p class="muted small">None of these assets has a declared link.</p>{/if}
            </section>
            {#if selected}{@render connects("Joined by links and near-duplicates")}{/if}
          {:else if view === "use"}{#if o.useKnown}
              <ul class="stats">
                {@render stat(facts.use.recent, `read in the last ${RECENT_DAYS} days`, "--use-4")}
                {@render stat(facts.use.earlier, `read earlier, not in the last ${RECENT_DAYS} days`, "--use-2")}
                {@render stat(facts.use.new, "never read, edited in the last 6 months (may be new)", "--use-0")}
                {@render stat(facts.use.unread, "never read, untouched 6+ months: retire candidates", "--warn")}
                {#if o.feedbackKnown}{@render stat(dislikedRead.length, "read but disliked")}{/if}
              </ul>
              <p class="muted small scope-note">Reads counted over {windowText}.</p>
              <section>
                <h3>Retire candidates, longest untouched first</h3>
                {#if deadWeight.length}{@render assetList(deadWeight, untouched, 5, "dead")}{:else}<p
                    class="muted small"
                  >
                    Nothing here is both unread and old.
                  </p>{/if}
              </section>
              {#if o.feedbackKnown && dislikedRead.length}<section>
                  <h3>Read but disliked, most read first</h3>
                  {@render assetList(
                    dislikedRead,
                    (i) => `${plural(o!.shows[i]!, "read")} · ${o!.negative[i]} down, ${o!.positive[i]} up`,
                    3,
                    "dislikedRead",
                  )}
                </section>{/if}
              <section>
                <h3>Most read</h3>
                {#if mostRead.length}{@render assetList(
                    mostRead,
                    (i) => plural(o!.shows[i]!, "read"),
                    5,
                    "mostRead",
                  )}{:else}<p class="muted small">Nothing here has been read.</p>{/if}
                {#if facts.useUnclassed}<p class="muted small">
                    {plural(facts.useUnclassed, "asset")} not read and with no edit time akm could read, so not counted above.
                  </p>{/if}
              </section>{:else}<section><p class="muted small">{o.note}</p></section>{/if}
            <section>
              <h3>Searched for in the last 90 days, nothing found</h3>
              {#if gaps.length}<ul class="rows">
                  {#each gaps as m}<li>
                      <a href={`/library/search?${new URLSearchParams([["q", m.query]])}`}>{m.query}</a><span
                        class="count">×{m.count}</span
                      >
                    </li>{/each}
                </ul>{:else if missesNote}<p class="muted small">Unavailable. {missesNote}</p>{:else}<p
                  class="muted small"
                >
                  None{part?.tag ? ` mentioning “${part.tag}”` : ""}.
                </p>{/if}
            </section>
          {:else}
            <ul class="stats">
              {@render stat(outdatedRead.length, "outdated and still read by agents: fix first", "--map-highlight")}
              {@render stat(outdatedUnread.length, "outdated, nobody reads them", "--map-highlight")}
              {@render stat(
                o.duplicatesKnown ? facts.duplicatesInside.length + facts.duplicatesOutside.length : "?",
                "pairs of near-identical assets",
                "--warn",
              )}
              {@render stat(
                o.feedbackKnown ? facts.disliked.length : "?",
                "with more negative feedback than positive",
                "--fail",
              )}
            </ul>
            {#if !o.feedbackKnown || !o.duplicatesKnown}<p class="muted small scope-note">
                {o.feedbackKnown ? "" : "Feedback is unavailable. "}{o.duplicatesKnown
                  ? ""
                  : "Near-identical pairs are unavailable. "}{o.note}
              </p>{/if}
            {#if outdatedRead.length}<section>
                <h3>Outdated and still read, most read first</h3>
                {@render assetList(outdatedRead, outdatedNote, 4, "outdatedRead")}
              </section>{/if}
            {#if facts.duplicatesInside.length + facts.duplicatesOutside.length}<section>
                <h3>Near-identical pairs: compare and keep one</h3>
                {@render pairList([...facts.duplicatesInside, ...facts.duplicatesOutside], 3)}
                {#if o.duplicatesTruncated}<p class="muted small">
                    Only the {o.duplicates.length.toLocaleString()} most alike pairs in the library are counted.
                  </p>{/if}
              </section>{/if}
            {#if o.feedbackKnown && facts.disliked.length}<section>
                <h3>More negative feedback than positive</h3>
                {@render assetList(
                  facts.disliked,
                  (i) => `${o!.negative[i]} down, ${o!.positive[i]} up`,
                  3,
                  "disliked",
                )}
              </section>{/if}
            {#if outdatedUnread.length}<section>
                <h3>Outdated, nobody reads them</h3>
                {@render assetList(outdatedUnread, outdatedNote, 3, "outdatedUnread")}
              </section>{/if}
            {@render overlap()}
          {/if}

          {#if points && !part && groups.length}<section>
              <h3>Groups by meaning</h3>
              <ul class="rows">
                {#each groups as g (g.key)}<li>
                    <button class="link" onclick={() => choose(g.key)}>{g.label}</button><span class="count"
                      >{groupNote(g) || figure(g.members)}</span
                    >
                  </li>{/each}
              </ul>
            </section>{/if}
        {/if}
      </aside>
    </div>
  {/if}
</div>

<style>
  /* One row: where in the Library this is, which question the map answers, and whose assets. */
  .map-head {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 24px;
    align-items: center;
    padding: 0 12px;
    border-bottom: 1px solid var(--border);
  }
  .library-views {
    display: flex;
    gap: 24px;
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
    padding: 8px 12px;
  }
  .views {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    min-inline-size: 0;
  }
  .views button[aria-selected="true"],
  .views button[aria-pressed="true"] {
    color: var(--text);
    background: var(--surface-2);
    font-weight: 600;
  }
  .map-filter {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 13px;
    color: var(--muted);
  }
  .bundle-pick {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-inline-start: auto;
    font-size: 13px;
    color: var(--muted);
  }
  .map-filter input {
    inline-size: 12rem;
  }
  .map-body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 21rem;
    gap: 8px;
    align-items: start;
  }
  .map-stage {
    position: relative;
    border: 1px solid var(--border);
    background: var(--surface);
    padding: 0;
    min-inline-size: 0;
    /* The map takes all the window has left under the app's header and the row above. */
    --stage-size: max(360px, calc(100vh - 152px));
  }
  /* The drawing and the finder sit on the map; over the tags, which have no spare corner, they sit above it. */
  .stage-tools {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin-block-end: 8px;
  }
  .map-stage:has(:global(.stage-3d)) .stage-tools {
    position: absolute;
    inset-block-start: 8px;
    inset-inline-start: 8px;
    z-index: 3;
    margin: 0;
    padding: 2px;
    background: color-mix(in srgb, var(--surface) 94%, transparent);
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  .map-note {
    margin: 0;
    padding: 4px 8px;
  }
  .stage-tools :global(button) {
    min-block-size: 28px;
    padding: 2px 10px;
    font-size: 13px;
  }
  .stage-tools input {
    block-size: 28px;
    font-size: 13px;
  }
  /* What the view found, one fact a line; a line with a colour is also the key to that colour on the map. */
  .stats {
    display: grid;
    gap: 3px;
    margin: 0;
    padding: 0 12px 8px;
    list-style: none;
    font-size: 13px;
  }
  .stats li {
    display: grid;
    grid-template-columns: 10px 2.75rem 1fr;
    gap: 6px;
    align-items: baseline;
  }
  .stats .swatch {
    align-self: center;
  }
  .stats strong {
    text-align: end;
    font-size: 15px;
    font-variant-numeric: tabular-nums;
  }
  .scope-note {
    padding: 0 12px 6px;
  }
  .swatch {
    flex: none;
    inline-size: 10px;
    block-size: 10px;
    border-radius: 2px;
  }
  .actions {
    display: flex;
    gap: 8px;
    margin-block-end: 12px;
  }
  .map-side section > h3 {
    display: flex;
    gap: 8px;
  }
  .levels {
    padding: 6px 10px;
  }
  .levels p {
    margin: 0 0 4px;
  }
  .levels ul {
    display: grid;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .levels li {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: var(--text-xs);
  }
  .level-key {
    flex: none;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .swatch {
    inline-size: 10px;
    block-size: 10px;
    border-radius: 2px;
    flex: none;
  }
  .map-side {
    border: 1px solid var(--border);
    background: var(--surface);
    min-inline-size: 0;
  }
  .map-side section {
    margin: 0;
    padding: 8px 12px;
    border-top: 1px solid var(--border);
  }
  .map-side section > h3 {
    margin: 0 0 4px;
  }
  .map-side p {
    margin: 0 0 4px;
  }
  .side-head {
    display: flex;
    gap: 8px;
    align-items: start;
    padding: 8px 12px;
  }
  .side-head div {
    flex: 1;
    min-inline-size: 0;
  }
  .side-head h2 {
    font-size: 15px;
    margin: 0 0 2px;
    overflow-wrap: anywhere;
  }
  .side-head p {
    margin: 0;
  }
  h3 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
    margin: 0 0 8px;
  }
  .figures {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 4px 12px;
    margin: 0;
    font-size: 13px;
  }
  .figures dd {
    margin: 0;
    text-align: end;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  .count {
    flex: none;
    white-space: nowrap;
    margin-inline-start: auto;
    color: var(--muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .rows li,
  .joined li {
    display: flex;
    gap: 8px;
    align-items: baseline;
    font-size: 13px;
    padding: 2px 0;
    min-inline-size: 0;
  }
  .rows a,
  .pairs a,
  .read a,
  .near a {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-inline-size: 0;
  }
  .pairs li {
    display: grid;
    gap: 2px;
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .pairs li:last-child {
    border-bottom: 0;
  }
  .pair-foot {
    display: flex;
    gap: 8px;
    align-items: baseline;
    font-size: 12px;
  }
  .pair-foot a:first-child {
    flex: 1;
    font-size: 13px;
  }
  .more {
    margin: 4px 0 0;
    font-size: 12px;
    color: var(--muted);
  }
  .joined li {
    justify-content: space-between;
  }
  .read li {
    padding: 2px 0;
  }
  /* A name and its figure on one line; a figure too long for that goes under the name. */
  .read-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0 8px;
    align-items: baseline;
    font-size: 13px;
    min-inline-size: 0;
  }
  .read-row a {
    flex: 1 1 auto;
  }
  .read-row .count {
    flex: 0 1 auto;
    min-inline-size: 0;
    margin-inline-start: 0;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .actions a {
    display: inline-flex;
    align-items: center;
    text-decoration: none;
  }
  /* What is wrong with the chosen asset, each with what to do about it. */
  .wrong {
    display: grid;
    gap: 6px;
    margin: 0 0 12px;
    padding: 8px 10px;
    list-style: none;
    font-size: 13px;
    background: var(--warn-bg);
    border-radius: 6px;
  }
  .near {
    margin: 4px 0 6px 12px;
    padding-inline-start: 8px;
    border-inline-start: 2px solid var(--accent);
  }
  .near li {
    display: flex;
    gap: 8px;
    align-items: baseline;
    font-size: 12px;
  }
  .small {
    font-size: 12px;
  }
  button.link {
    min-block-size: 0;
    border: 0;
    background: none;
    padding: 0;
    color: var(--link);
    font: inherit;
    text-align: start;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  button.link:hover {
    text-decoration: underline;
  }
  /* The map needs about 1,000 px to be read at full size; below that the figures go under it. */
  /* Beside the map the figures scroll on their own, so the map stays in view while they are read. */
  @media (min-width: 1401px) {
    .map-side {
      max-block-size: calc(max(360px, 100vh - 152px) + 2px);
      overflow-y: auto;
    }
  }
  @media (max-width: 1400px) {
    .map-body {
      grid-template-columns: 1fr;
    }
  }
</style>
