// Config: the effective configuration as a collapsible tree with a source badge per key. Values arrive redacted.

import { api, badge, definitionList, emptyState, html, pageHeader, pretty, tableWrap } from "./lib.js";

function sourceBadge(source) {
  if (source === "default") return badge("default", "neutral");
  if (source === "file") return badge("file", "info");
  if (typeof source === "string" && source.startsWith("extends:")) return badge(source, "accent");
  return badge("untraced", "warn");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function leafValue(value) {
  if (value === "[redacted]") return html`<span class="redacted">[redacted]</span>`;
  if (value === null) return html`<span class="muted">null</span>`;
  if (typeof value === "string") return html`<span class="v-str">${value === "" ? '""' : value}</span>`;
  if (typeof value === "number" || typeof value === "boolean") return html`<span class="v-lit">${String(value)}</span>`;
  const text = JSON.stringify(value);
  if (text.length <= 80) return html`<span class="mono">${text}</span>`;
  const count = Array.isArray(value) ? `${value.length} items` : "object";
  return html`<details class="inline"><summary>${count}</summary><pre class="code">${pretty(value)}</pre></details>`;
}

function node(key, value, path, sources, depth) {
  if (isObject(value)) {
    const keys = Object.keys(value);
    return html`<li><details ${depth < 1 ? html`open` : ""}><summary><span class="mono key">${key}</span> <span class="muted small">${keys.length} ${keys.length === 1 ? "key" : "keys"}</span></summary>
      <ul class="tree">${keys.map((k) => node(k, value[k], path ? `${path}.${k}` : k, sources, depth + 1))}</ul></details></li>`;
  }
  const source = sources.has(path) ? sources.get(path) : null;
  return html`<li class="leaf"><span class="mono key">${key}</span><span class="leaf-value">${leafValue(value)}</span>${sourceBadge(source)}</li>`;
}

function enginesTable(engines) {
  if (engines.length === 0) return emptyState("No engines are configured.");
  const rest = (e) => {
    const { name, kind, endpoint, model, ...others } = e;
    return Object.keys(others).length > 0 ? JSON.stringify(others) : "";
  };
  return tableWrap(
    html`<table><thead><tr><th>Name</th><th>Kind</th><th>Endpoint</th><th>Model</th><th>Other</th></tr></thead><tbody>${engines.map(
      (e) =>
        html`<tr><td class="mono">${e.name}</td><td>${e.kind}</td><td class="mono wrap">${e.endpoint ?? ""}</td><td class="mono">${e.model ?? ""}</td><td class="mono small wrap">${rest(e)}</td></tr>`,
    )}</tbody></table>`,
  );
}

export async function render() {
  const data = await api("/api/config");
  const sources = new Map(data.entries.map((e) => [e.path, e.source]));
  const keys = Object.keys(data.config ?? {});
  return html`${pageHeader("Config", "The effective configuration, and where each value comes from. Secret values are redacted by the server.")}
    <section>${definitionList([
      ["Config file", html`<span class="mono">${data.path}</span> ${data.exists ? "" : badge("not found", "warn")}`],
    ])}${data.exists ? "" : html`<p class="muted">There is no config file, so everything below is a default.</p>`}</section>
    <section><h2>Effective config</h2><p class="legend-line">Source: ${sourceBadge("default")} built-in ${sourceBadge("file")} this install's config.json ${sourceBadge("extends:ref")} a config it extends</p>
      ${keys.length === 0 ? emptyState("The effective config is empty.") : html`<ul class="tree root">${keys.map((k) => node(k, data.config[k], k, sources, 0))}</ul>`}</section>
    <section><h2>Engines</h2>${enginesTable(data.engines)}</section>
    <section><h2>Environment</h2><p class="muted">AKM_* variables set for the server. They override paths and credentials.</p>${
      data.env.length === 0
        ? emptyState("No AKM_* environment variables are set.")
        : tableWrap(
            html`<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody>${data.env.map((e) => html`<tr><td class="mono">${e.name}</td><td class="mono wrap">${e.value === "[redacted]" ? html`<span class="redacted">[redacted]</span>` : e.value}</td></tr>`)}</tbody></table>`,
          )
    }</section>`;
}
