// SVG charts supplement the adjacent data tables; they never own a write action.

import { html } from "./lib.js";

/**
 * The colour a token resolves to now. A token is a `light-dark()` pair, which a custom property keeps unresolved, so
 * a probe element takes it as its `color` and the browser says which one applies in the scheme on screen.
 */
export function colourReader(near) {
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
  near.parentNode.append(probe);
  return {
    token(name) {
      probe.style.color = `var(${name})`;
      return getComputedStyle(probe).color;
    },
    done: () => probe.remove(),
  };
}

function wireChart(ctx, selector, options, onSelect) {
  ctx.after.push((root) => {
    const element = root.querySelector(selector);
    if (!element) return;
    let disposed = false;
    let chart;
    let observer;
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    const retheme = () => draw();
    // Texture only where colour alone is not enough: forced colours or a request for more contrast.
    const patterns = matchMedia("(forced-colors: active), (prefers-contrast: more)");
    const draw = () => {
      if (!chart || disposed) return;
      const font = getComputedStyle(element).getPropertyValue("--font").trim();
      const { token, done } = colourReader(element);
      // The builder gets the token reader, for the few marks that carry a colour of their own.
      const option = options(token);
      const axis = (value) => ({
        ...value,
        axisLabel: { color: token("--muted"), ...value?.axisLabel },
        nameTextStyle: { color: token("--muted") },
        splitLine: { show: value?.splitLine?.show ?? true, lineStyle: { color: token("--border") } },
      });
      chart.setOption(
        {
          animation: false,
          color: SERIES.map(token),
          textStyle: { color: token("--text"), fontFamily: font },
          aria: {
            enabled: true,
            label: { description: element.getAttribute("aria-label") },
            decal: { show: patterns.matches },
          },
          grid: { left: 12, right: 22, top: 24, bottom: 16, containLabel: true },
          // richText draws the tooltip as chart text, never as HTML, so a series name or a query cannot inject markup.
          tooltip: {
            trigger: "axis",
            renderMode: "richText",
            confine: true,
            backgroundColor: token("--surface"),
            borderColor: token("--border-strong"),
            textStyle: { color: token("--text"), fontFamily: font, fontSize: 12 },
            axisPointer: { type: "line", lineStyle: { color: token("--border-strong") } },
          },
          ...option,
          series: option.series.map(({ colorIndex, ...series }, index) => ({
            ...series,
            itemStyle: { color: token(`--s${(colorIndex ?? index) + 1}`), ...series.itemStyle },
          })),
          xAxis: axis(option.xAxis),
          yAxis: axis(option.yAxis),
        },
        { notMerge: true },
      );
      done();
    };
    // A chart is drawn when its card nears the screen, so ECharts is not fetched for a page that never scrolls to one.
    const start = () =>
      import("./echarts.js")
        .then(({ init }) => {
          if (disposed || !element.isConnected) return;
          const resize = () => {
            if (disposed || !element.clientWidth || !element.clientHeight) return;
            if (!chart) {
              chart = init(element, null, { renderer: "svg" });
              if (onSelect) chart.on("click", onSelect);
              draw();
            } else chart.resize();
          };
          observer = new ResizeObserver(resize);
          observer.observe(element);
          resize();
          scheme.addEventListener("change", retheme);
          window.addEventListener("akm-theme", retheme);
        })
        .catch(() => {
          // Say so, instead of leaving a blank box: the numbers are in the table beside it.
          element.textContent = "Chart unavailable. The same figures are in Data and details.";
          element.classList.add("chart-failed");
        });
    let lazy;
    if (typeof IntersectionObserver === "function") {
      lazy = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          lazy.disconnect();
          start();
        },
        { rootMargin: "300px" },
      );
      lazy.observe(element);
    } else start();
    // A control redraws the chart in its own card only, not every chart on the page.
    const card = element.closest(".chart-card") ?? element.parentElement;
    const redraw = (event) => {
      if (card?.contains(event.target)) draw();
    };
    root.addEventListener("change", redraw);
    const resize = () => chart?.resize();
    root.addEventListener("toggle", resize, true);
    return () => {
      disposed = true;
      observer?.disconnect();
      scheme.removeEventListener("change", retheme);
      window.removeEventListener("akm-theme", retheme);
      lazy?.disconnect();
      root.removeEventListener("change", redraw);
      root.removeEventListener("toggle", resize, true);
      chart?.dispose();
    };
  });
}

/**
 * A chart's element, drawn once the page is mounted. `options(token)` builds the ECharts option; `height` is the
 * element's `data-height`; `onSelect` receives a click on a mark. `label` names the chart for assistive technology.
 */
export function chart(ctx, id, label, options, { height, onSelect } = {}) {
  wireChart(ctx, `#${id}`, options, onSelect);
  return html`<div class="echarts-view" ${height ? html`data-height="${height}"` : ""} id="${id}" role="img" aria-label="${label}"></div>`;
}

/** The categorical colours, in order; a series without its own `colorIndex` takes the next. */
const SERIES = ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6"];

/** Axes that count whole things: a tick at "0.5 proposals" means nothing. */
const COUNT_UNITS = new Set(["Count", "Calls", "Searches", "Operations", "Decisions", "Failures"]);

export function verticalBars(labels, series, unit = "Count") {
  return {
    xAxis: { type: "category", data: labels, axisLabel: { hideOverlap: true } },
    yAxis: { type: "value", name: unit, min: 0, ...(COUNT_UNITS.has(unit) ? { minInterval: 1 } : {}) },
    series: series.map((s) => ({ type: "bar", barMaxWidth: 28, ...s })),
  };
}

// ---- chart builders for the dashboard -----------------------------------------------------------------------------
// Each returns the option object `wireChart` takes. They use only the components the bundled ECharts has (bar, line,
// scatter, grid, aria), so a band is a stacked area and a strip is a scatter on one row.

const percent = (value) => `${value}%`;

/** One row of marks over the same labels as the chart above it: an `events` entry is `{ index, tone }`. */
export function eventStrip(labels, events, { name = "Events", token }) {
  const tones = { ok: "--ok", warn: "--warn", fail: "--fail", info: "--link" };
  return {
    grid: { left: 12, right: 22, top: 4, bottom: 4, containLabel: true },
    xAxis: {
      type: "category",
      data: labels,
      axisLabel: { show: false },
      axisTick: { show: false },
      axisLine: { show: false },
      splitLine: { show: false },
    },
    yAxis: { type: "value", min: 0, max: 1, axisLabel: { show: false }, splitLine: { show: false } },
    series: [
      {
        type: "scatter",
        name,
        symbolSize: 12,
        data: events.map((event) => ({
          value: [event.index, 0.5],
          itemStyle: { color: token(tones[event.tone] ?? "--link") },
        })),
      },
    ],
  };
}

/**
 * A weekly proportion as a p-chart: the share per week, its centre, and the band a steady process stays in. `points` is
 * `pChart(...).points` from the server; a week outside its band is drawn larger. `unit` names the y axis.
 */
export function pChartLine(labels, points, centre, { name = "Share", unit = "Share" } = {}) {
  const pct = (value) => (value === null || value === undefined ? null : Math.round(value * 1000) / 10);
  return {
    xAxis: { type: "category", data: labels, boundaryGap: false, axisLabel: { hideOverlap: true } },
    yAxis: { type: "value", name: unit, min: 0, axisLabel: { formatter: percent } },
    series: [
      {
        type: "line",
        name: "Lower limit",
        stack: "band",
        symbol: "none",
        lineStyle: { opacity: 0 },
        colorIndex: 0,
        data: points.map((p) => pct(p.lower)),
      },
      {
        type: "line",
        name: "Usual range",
        stack: "band",
        symbol: "none",
        lineStyle: { opacity: 0 },
        areaStyle: { opacity: 0.16 },
        colorIndex: 0,
        data: points.map((p) => (p.upper === null ? null : pct(p.upper - p.lower))),
      },
      {
        type: "line",
        name,
        colorIndex: 0,
        symbol: "circle",
        symbolSize: 6,
        connectNulls: false,
        lineStyle: { width: 2.5 },
        data: points.map((p) => ({ value: pct(p.rate), symbolSize: p.signal ? 12 : 6 })),
      },
      {
        type: "line",
        name: "Centre",
        colorIndex: 5,
        symbol: "none",
        lineStyle: { type: "dashed", width: 1.5 },
        data: points.map(() => pct(centre)),
      },
    ],
  };
}

/** Counts per label stacked by series: `series` is `[{ name, data, colorIndex? }]`. */
export function stackedColumns(labels, series, unit = "Count") {
  return verticalBars(
    labels,
    series.map((item) => ({ stack: "total", ...item })),
    unit,
  );
}

/** A level that holds until it changes (a queue length, the library size), as a step line. */
export function stepLine(labels, data, { name = "Level", unit = "Count" } = {}) {
  return {
    xAxis: { type: "category", data: labels, boundaryGap: false, axisLabel: { hideOverlap: true } },
    yAxis: { type: "value", name: unit, min: 0, minInterval: 1, splitNumber: 2 },
    series: [
      {
        type: "line",
        name,
        step: "end",
        symbol: "none",
        connectNulls: true,
        lineStyle: { width: 2.5 },
        areaStyle: { opacity: 0.1 },
        colorIndex: 0,
        data,
      },
    ],
  };
}

/** Several lines over the same labels (`series`: `[{ name, data, colorIndex? }]`), gaps shown as gaps. */
export function lines(labels, series, unit = "Count") {
  return {
    xAxis: { type: "category", data: labels, boundaryGap: false, axisLabel: { hideOverlap: true } },
    yAxis: { type: "value", name: unit, min: 0, splitNumber: 2 },
    series: series.map((item) => ({
      type: "line",
      symbol: "none",
      connectNulls: false,
      lineStyle: { width: 2 },
      ...item,
    })),
  };
}
