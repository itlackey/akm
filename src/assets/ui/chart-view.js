// SVG charts supplement the adjacent data tables; they never own a write action.
export function wireChart(ctx, selector, options, onSelect) {
  ctx.after.push((root) => {
    const element = root.querySelector(selector);
    if (!element) return;
    let disposed = false;
    let chart;
    let observer;
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    // Texture only where colour alone is not enough: forced colours or a request for more contrast (plan D-04).
    const patterns = matchMedia("(forced-colors: active), (prefers-contrast: more)");
    const draw = () => {
      if (!chart || disposed) return;
      const css = getComputedStyle(element);
      const token = (name) => css.getPropertyValue(name).trim();
      // The builder gets the token reader, for the few marks that carry a colour of their own.
      const option = options(token);
      const axis = (value) => ({
        ...value,
        axisLabel: { color: token("--muted"), ...value?.axisLabel },
        nameTextStyle: { color: token("--muted") },
        splitLine: { lineStyle: { color: token("--border") } },
      });
      chart.setOption(
        {
          animation: false,
          color: ["--s1", "--s2", "--s3", "--s4", "--s5"].map(token),
          textStyle: { color: token("--text"), fontFamily: token("--font") },
          aria: {
            enabled: true,
            label: { description: element.getAttribute("aria-label") },
            decal: { show: patterns.matches },
          },
          grid: { left: 12, right: 22, top: 24, bottom: 16, containLabel: true },
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
    };
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
        scheme.addEventListener("change", draw);
      })
      .catch(() => {
        element.hidden = true;
      });
    root.addEventListener("change", draw);
    const resize = () => chart?.resize();
    root.addEventListener("toggle", resize, true);
    return () => {
      disposed = true;
      observer?.disconnect();
      scheme.removeEventListener("change", draw);
      root.removeEventListener("change", draw);
      root.removeEventListener("toggle", resize, true);
      chart?.dispose();
    };
  });
}

/** Axes that count whole things: a tick at "0.5 proposals" means nothing. */
const COUNT_UNITS = new Set(["Count", "Calls", "Searches", "Operations", "Decisions", "Failures"]);

export function verticalBars(labels, series, unit = "Count") {
  return {
    xAxis: { type: "category", data: labels, axisLabel: { hideOverlap: true } },
    yAxis: { type: "value", name: unit, min: 0, ...(COUNT_UNITS.has(unit) ? { minInterval: 1 } : {}) },
    series: series.map((s) => ({ type: "bar", barMaxWidth: 28, ...s })),
  };
}

export function horizontalBars(labels, series, unit = "Count") {
  return {
    grid: { left: 12, right: 22, top: 24, bottom: 42, containLabel: true },
    xAxis: {
      type: "value",
      name: unit,
      nameLocation: "middle",
      nameGap: 28,
      min: 0,
      ...(COUNT_UNITS.has(unit) ? { minInterval: 1 } : {}),
    },
    yAxis: { type: "category", inverse: true, data: labels, axisLabel: { width: 110, overflow: "truncate" } },
    series: series.map((s) => ({ type: "bar", ...s })),
  };
}

// ---- chart builders for the dashboard -----------------------------------------------------------------------------
// Each returns the option object `wireChart` takes. They use only the components the bundled ECharts has (bar, line,
// scatter, grid, aria), so a band is a stacked area and a strip is a scatter on one row.

const percent = (value) => `${value}%`;

/** Positive and negative counts per label as columns on either side of zero (e.g. flagged vs. kept). */
export function divergingColumns(labels, positive, negative, { positiveName, negativeName, unit = "Count" }) {
  return {
    xAxis: { type: "category", data: labels, axisLabel: { hideOverlap: true } },
    yAxis: { type: "value", name: unit, axisLabel: { formatter: (value) => Math.abs(value) }, minInterval: 1 },
    series: [
      { type: "bar", name: positiveName, stack: "d", colorIndex: 2, barMaxWidth: 28, data: positive },
      {
        type: "bar",
        name: negativeName,
        stack: "d",
        colorIndex: 3,
        barMaxWidth: 28,
        data: negative.map((n) => (n ? -n : n)),
      },
    ],
  };
}

/** One row of marks over the same labels as the chart above it: an `events` entry is `{ index, tone }`. */
export function eventStrip(labels, events, { name = "Events", token }) {
  const tones = { ok: 2, warn: 1, fail: 3, info: 0 };
  return {
    grid: { left: 12, right: 22, top: 4, bottom: 4, containLabel: true },
    xAxis: { type: "category", data: labels, axisLabel: { show: false }, axisTick: { show: false } },
    yAxis: { type: "value", min: 0, max: 1, axisLabel: { show: false }, splitLine: { show: false } },
    series: [
      {
        type: "scatter",
        name,
        symbolSize: 12,
        data: events.map((event) => ({
          value: [event.index, 0.5],
          itemStyle: { color: token(`--s${(tones[event.tone] ?? 0) + 1}`) },
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
    yAxis: { type: "value", name: unit, min: 0, minInterval: 1 },
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
    yAxis: { type: "value", name: unit, min: 0 },
    series: series.map((item) => ({
      type: "line",
      symbol: "none",
      connectNulls: false,
      lineStyle: { width: 2 },
      ...item,
    })),
  };
}
