// SVG charts supplement the adjacent data tables; they never own a write action.
export function wireChart(ctx, selector, options, onSelect) {
  ctx.after.push((root) => {
    const element = root.querySelector(selector);
    if (!element) return;
    let disposed = false;
    let chart;
    let observer;
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    const draw = () => {
      if (!chart || disposed) return;
      const css = getComputedStyle(element);
      const token = (name) => css.getPropertyValue(name).trim();
      const option = options();
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
          aria: { enabled: true, label: { description: element.getAttribute("aria-label") }, decal: { show: true } },
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

export function verticalBars(labels, series, unit = "Count") {
  return {
    xAxis: { type: "category", data: labels, axisLabel: { hideOverlap: true } },
    yAxis: { type: "value", name: unit, min: 0 },
    series: series.map((s) => ({ type: "bar", ...s })),
  };
}

export function horizontalBars(labels, series, unit = "Count") {
  return {
    grid: { left: 12, right: 22, top: 24, bottom: 42, containLabel: true },
    xAxis: { type: "value", name: unit, nameLocation: "middle", nameGap: 28, min: 0 },
    yAxis: { type: "category", inverse: true, data: labels, axisLabel: { width: 110, overflow: "truncate" } },
    series: series.map((s) => ({ type: "bar", ...s })),
  };
}
