<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts" module>
  /** One coloured part of a bar: `n` assets (or events) in the colour of `token`. */
  export type Segment = { n: number; token: string };
</script>

<script lang="ts">
  // The library as a two-sided mind map: the library in the middle, its asset types around it, and the tags each type's
  // assets carry most at the ends. Every label is drawn; the bar under a tag is its size, split by what the view shows.
  import type { Branch, Relation } from "./library-overview";

  let {
    branches,
    rootLabel,
    rootFigure,
    figure,
    bar,
    scale,
    selected = "",
    onSelect,
    pulse = null,
    related = [],
    appeared,
    label,
  }: {
    branches: Branch[];
    rootLabel: string;
    rootFigure: string;
    /** The text after a name: a count, a share read, a number of problems. */
    figure: (members: number[], key: string) => string;
    /** The bar under a tag, in parts. */
    bar: (members: number[], key: string) => Segment[];
    /** The bar total drawn at full width. */
    scale: number;
    selected?: string;
    onSelect: (key: string) => void;
    /** Replay: how many events each tag has had; a tag whose count changes flashes. */
    pulse?: Map<string, number> | null;
    /** The groups joined to the selected one, drawn as lines to it; the others fade. */
    related?: Relation[];
    /** Replay: whether a type or tag has had an event yet; one that has not keeps its place and is not drawn. */
    appeared?: (key: string) => boolean;
    label: string;
  } = $props();

  const ROW = 30;
  const GAP = 24;
  const PAD = 16;
  const BAR = 150;
  const LINK = 36;

  /** Text width at a font size: about 0.55 em a character, 0.6 when bold. */
  const textWidth = (text: string, px: number, bold = false) => text.length * px * (bold ? 0.6 : 0.55);
  /** A pill holds its name over its figure. */
  const pillWidth = (name: string, fig: string, px = 13) =>
    Math.max(80, textWidth(name, px, true), textWidth(fig, 12)) + 28;
  const rootWidth = $derived(pillWidth(rootLabel, rootFigure, 15));

  const layout = $derived.by(() => {
    // Types go to the side with fewer rows so far, largest first, so the two sides balance.
    const sides: Array<{ dir: 1 | -1; items: Branch[]; rows: number }> = [
      { dir: 1, items: [], rows: 0 },
      { dir: -1, items: [], rows: 0 },
    ];
    for (const b of branches) {
      const side = sides[0]!.rows <= sides[1]!.rows ? sides[0]! : sides[1]!;
      side.items.push(b);
      side.rows += Math.max(2, b.leaves.length);
    }
    const heightOf = (s: (typeof sides)[number]) => s.rows * ROW + Math.max(0, s.items.length - 1) * GAP;
    const height = Math.max(heightOf(sides[0]!), heightOf(sides[1]!), 2 * ROW) + 2 * PAD;
    // Each side is as wide as its own labels: the types clear of the root, the tags clear of the widest type.
    const placed = sides.flatMap((side) => {
      const pills = side.items.map((b) => pillWidth(b.label, figure(b.members, b.key)));
      const widest = Math.max(0, ...pills);
      const r1 = rootWidth / 2 + LINK + widest / 2;
      const r2 = r1 + widest / 2 + LINK;
      let y = (height - heightOf(side)) / 2;
      return side.items.map((b, i) => {
        const leaves = b.leaves.map((leaf, k) => {
          const fig = figure(leaf.members, leaf.key);
          return { leaf, fig, w: Math.max(BAR, textWidth(`${leaf.label} ${fig}`, 13)), y: y + k * ROW + ROW / 2 };
        });
        const rows = Math.max(2, b.leaves.length);
        const by = y + (rows * ROW) / 2;
        y += rows * ROW + GAP;
        return { b, dir: side.dir, y: by, leaves, pill: pills[i]!, r1, r2 };
      });
    });
    const extent = (dir: 1 | -1) =>
      Math.max(
        rootWidth / 2 + 8,
        ...placed
          .filter((p) => p.dir === dir)
          .flatMap((p) => [p.r1 + p.pill / 2, ...p.leaves.map((l) => p.r2 + 10 + l.w)]),
      ) + 8;
    const left = extent(-1);
    const width = left + extent(1);
    return { height, placed, left, width };
  });

  /** Where each type's pill and each tag's dot sit, by key. */
  const at = $derived(
    new Map(
      layout.placed.flatMap((p) => [
        [p.b.key, { x: p.dir * p.r1, y: p.y }] as const,
        ...p.leaves.map((l) => [l.leaf.key, { x: p.dir * p.r2, y: l.y - 3 }] as const),
      ]),
    ),
  );
  const joined = $derived(new Set(related.map((r) => r.key)));
  const strongest = $derived(Math.max(1, ...related.map((r) => r.links + r.duplicates)));
  /** Faded: something is selected and this is neither it, its type, nor joined to it. */
  const faded = (key: string, branch: string) =>
    selected !== "" && selected !== key && selected !== branch && !joined.has(key);
  /** A line from the selected group to a joined one, bowed toward the middle: deeply across the map, gently along one side. */
  const bow = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const pull = Math.sign(from.x) === Math.sign(to.x) ? 0.75 : 0.35;
    return `M${from.x},${from.y} C${from.x * pull},${from.y} ${to.x * pull},${to.y} ${to.x},${to.y}`;
  };

  const curve = (x1: number, y1: number, x2: number, y2: number) => {
    const mid = (x1 + x2) / 2;
    return `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`;
  };
  const colour = (family: number) => `var(--map-${family + 1})`;
  const width = (members: number[], key: string) => bar(members, key).reduce((sum, s) => sum + s.n, 0);
  /** The bar's parts as x offsets from its start, in the direction it grows. */
  function parts(members: number[], key: string) {
    let at = 0;
    return bar(members, key)
      .filter((s) => s.n > 0)
      .map((s) => {
        const w = Math.max(2, (s.n / Math.max(1, scale)) * BAR);
        const part = { at, w, token: s.token };
        at += w;
        return part;
      });
  }
  function key(event: KeyboardEvent, k: string) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(k);
    }
  }
</script>

<svg
  class="mind-map"
  class:focused={selected !== ""}
  class:arrives={!!appeared}
  viewBox={`${-layout.left} 0 ${layout.width} ${layout.height}`}
  style={`max-inline-size:${Math.round(layout.width)}px`}
  role="group"
  aria-label={label}
>
  {#each layout.placed as p (p.b.key)}
    {#if !appeared || appeared(p.b.key)}<path
        class="branch-line"
        d={curve(p.dir * (rootWidth / 2), layout.height / 2, p.dir * (p.r1 - p.pill / 2), p.y)}
        style={`stroke:${colour(p.b.family)}`}
      />{/if}
    {#each p.leaves.filter((l) => !appeared || appeared(l.leaf.key)) as l (l.leaf.key)}
      <path
        class="leaf-line"
        class:dim={faded(l.leaf.key, p.b.key)}
        d={curve(p.dir * (p.r1 + p.pill / 2), p.y, p.dir * (p.r2 - 6), l.y)}
        style={`stroke:${colour(p.b.family)}`}
      />
    {/each}
  {/each}

  {#if selected && at.has(selected)}<g class="relations">
      {#each related as r (r.key)}{#if at.has(r.key)}<path
            d={bow(at.get(selected)!, at.get(r.key)!)}
            style={`stroke-width:${1.5 + 5 * Math.sqrt((r.links + r.duplicates) / strongest)}`}
            ><title>{`${r.links.toLocaleString()} links, ${r.duplicates.toLocaleString()} near-duplicate pairs`}</title
            ></path
          >{/if}{/each}
    </g>{/if}

  <g class="root">
    <rect x={-rootWidth / 2} y={layout.height / 2 - 24} width={rootWidth} height="48" rx="24" />
    <text x="0" y={layout.height / 2 - 4} text-anchor="middle"
      ><tspan class="name">{rootLabel}</tspan><tspan class="figure" x="0" dy="17">{rootFigure}</tspan></text
    >
  </g>

  {#each layout.placed.filter((p) => !appeared || appeared(p.b.key)) as p (p.b.key)}
    {@const fig = figure(p.b.members, p.b.key)}
    <g
      class="branch"
      class:selected={selected === p.b.key}
      role="button"
      tabindex="0"
      aria-label={fig ? `${p.b.label}: ${fig}` : p.b.label}
      aria-pressed={selected === p.b.key}
      onclick={() => onSelect(p.b.key)}
      onkeydown={(e) => key(e, p.b.key)}
    >
      <title>{`${p.b.label}\n${p.b.members.length.toLocaleString()} assets · ${fig}`}</title>
      <rect
        x={p.dir * p.r1 - p.pill / 2}
        y={p.y - 20}
        width={p.pill}
        height="40"
        rx="12"
        style={`stroke:${colour(p.b.family)}`}
      />
      <text x={p.dir * p.r1} y={p.y - 3} text-anchor="middle"
        ><tspan class="name">{p.b.label}</tspan><tspan class="figure" x={p.dir * p.r1} dy="15">{fig}</tspan></text
      >
    </g>
    {#each p.leaves.filter((l) => !appeared || appeared(l.leaf.key)) as l (l.leaf.key)}
      {@const lfig = l.fig}
      {@const x = p.dir * (p.r2 + 10)}
      <g
        class="leaf"
        class:selected={selected === l.leaf.key}
        class:dim={faded(l.leaf.key, p.b.key)}
        role="button"
        tabindex="0"
        aria-label={lfig ? `${l.leaf.label} (${p.b.label}): ${lfig}` : `${l.leaf.label} (${p.b.label})`}
        aria-pressed={selected === l.leaf.key}
        onclick={() => onSelect(l.leaf.key)}
        onkeydown={(e) => key(e, l.leaf.key)}
      >
        <title>{`${l.leaf.label} · ${p.b.label}\n${l.leaf.members.length.toLocaleString()} assets · ${lfig}`}</title>
        <rect
          class="hit"
          x={p.dir > 0 ? p.r2 - 8 : -(p.r2 + 10 + l.w)}
          y={l.y - ROW / 2}
          width={l.w + 18}
          height={ROW}
        />
        {#key pulse?.get(l.leaf.key) ?? 0}<circle
            class:flash={pulse !== null && (pulse.get(l.leaf.key) ?? 0) > 0}
            cx={p.dir * p.r2}
            cy={l.y - 3}
            r="4"
            style={`fill:${colour(p.b.family)}`}
          />{/key}
        <text {x} y={l.y} text-anchor={p.dir > 0 ? "start" : "end"}
          ><tspan class="name">{l.leaf.label}</tspan> <tspan class="figure">{lfig}</tspan></text
        >
        {#if width(l.leaf.members, l.leaf.key) > 0}{#each parts(l.leaf.members, l.leaf.key) as s}<rect
              class="bar"
              x={p.dir > 0 ? x + s.at : x - s.at - s.w}
              y={l.y + 5}
              width={s.w}
              height="5"
              style={`fill:var(${s.token})`}
            />{/each}{/if}
      </g>
    {/each}
  {/each}
</svg>

<style>
  .mind-map {
    display: block;
    inline-size: 100%;
    block-size: auto;
    margin-inline: auto;
    font-family: inherit;
  }
  .branch-line,
  .leaf-line {
    fill: none;
    stroke-linecap: round;
  }
  .branch-line {
    stroke-width: 3;
    opacity: 0.85;
  }
  .leaf-line {
    stroke-width: 1.5;
    opacity: 0.6;
  }
  .root rect {
    fill: var(--text);
  }
  .root text {
    fill: var(--bg);
    font-size: 15px;
  }
  .root .name {
    font-weight: 700;
  }
  .root .figure {
    opacity: 0.75;
  }
  .branch rect {
    fill: var(--surface);
    stroke-width: 2;
  }
  .branch .figure {
    font-size: 12px;
  }
  .root .figure {
    font-size: 13px;
  }
  .branch text {
    font-size: 13px;
    fill: var(--text);
  }
  .branch .name {
    font-weight: 600;
  }
  .branch .figure,
  .leaf .figure {
    fill: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .branch.selected rect {
    fill: var(--accent-bg);
    stroke-width: 3;
  }
  .leaf text {
    font-size: 13px;
    fill: var(--text);
  }
  .leaf .hit {
    fill: transparent;
  }
  .leaf:hover .hit,
  .branch:hover rect {
    fill: var(--surface-2);
  }
  .leaf.selected .name {
    font-weight: 700;
    fill: var(--accent);
  }
  .leaf.selected .hit {
    fill: var(--accent-bg);
  }
  .dim {
    opacity: 0.35;
  }
  .relations path {
    fill: none;
    stroke: var(--accent);
    stroke-linecap: round;
    opacity: 0.55;
  }
  .branch,
  .leaf {
    cursor: pointer;
    outline: none;
  }
  .branch:focus-visible rect,
  .leaf:focus-visible .hit {
    stroke: var(--accent);
    stroke-width: 2;
  }
  .flash {
    animation: flash 1.2s ease-out;
    transform-box: fill-box;
    transform-origin: center;
  }
  @keyframes flash {
    0% {
      transform: scale(3.2);
      filter: drop-shadow(0 0 4px var(--accent));
    }
    100% {
      transform: scale(1);
    }
  }
  /* In a replay a type or tag arrives when it first has an event: it and its line grow in rather than appear. */
  .arrives .branch,
  .arrives .leaf {
    animation: arrive 0.45s cubic-bezier(0.34, 1.56, 0.64, 1);
    transform-box: fill-box;
    transform-origin: center;
  }
  .arrives .branch-line,
  .arrives .leaf-line {
    animation: line-in 0.45s ease-out;
  }
  @keyframes arrive {
    from {
      opacity: 0;
      transform: scale(0.4);
    }
  }
  @keyframes line-in {
    from {
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .flash,
    .arrives .branch,
    .arrives .leaf,
    .arrives .branch-line,
    .arrives .leaf-line {
      animation: none;
    }
  }
</style>
