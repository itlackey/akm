// Config: an editable settings page. Each card saves its own changed fields through `/api/config/set`, which
// validates them exactly like `akm config set`. The full effective config stays below as a read-only reference.

import { actionForm, api, badge, emptyState, html, pageHeader, post, pretty, tableWrap } from "./lib.js";

const OUTPUT_FORMATS = ["json", "yaml", "text", "jsonl", "md", "html"];
const DETAILS = ["brief", "normal", "full"];
const ALIASES = ["fast", "balanced", "reasoning"];

function sourceBadge(source) {
  if (source === "default") return badge("default", "neutral");
  if (source === "file") return badge("set in config.json", "info");
  if (typeof source === "string" && source.startsWith("extends:")) return badge(`from ${source.slice(8)}`, "accent");
  return "";
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function valueAt(config, key) {
  return key.split(".").reduce((value, part) => (isObject(value) ? value[part] : undefined), config);
}

/** The text a field starts with: arrays as a comma list, everything else as a string, absent as empty. */
function initialText(value, kind) {
  if (value === undefined || value === null) return "";
  if (kind === "list") return Array.isArray(value) ? value.join(", ") : "";
  return String(value);
}

/**
 * One settings field. `name` is the dotted config key; `data-kind` tells the submit handler how to send it.
 * Clearing an optional field unsets the key, so the built-in default applies again.
 */
function field(ctx, { key, label, hint = "", kind = "text", options = [], placeholder = "" }) {
  const value = valueAt(ctx.config, key);
  const initial = initialText(value, kind);
  const id = `f-${key.replace(/[^a-z0-9]+/gi, "-")}`;
  const source = ctx.sources.get(key);
  const head = html`<div class="field-head"><label class="field-label" for="${id}">${label}</label>${sourceBadge(source)}</div>`;
  const help = hint ? html`<p class="field-hint" id="${id}-hint">${hint}</p>` : "";
  const described = hint ? html`aria-describedby="${id}-hint"` : "";
  const common = html`id="${id}" name="${key}" data-kind="${kind}" data-initial="${initial}" ${described}`;
  if (kind === "toggle") {
    return html`<div class="field field-row"><div class="field-text">${head}${help}</div>
      <input type="checkbox" role="switch" class="switch" ${common} ${value === true ? html`checked` : ""}></div>`;
  }
  if (kind === "segmented") {
    return html`<fieldset class="field"><legend class="field-head"><span class="field-label">${label}</span>${sourceBadge(source)}</legend>${help}
      <div class="segmented" role="radiogroup">${options.map(
        ([optionValue, optionLabel]) =>
          html`<label><input type="radio" name="${key}" value="${optionValue}" data-kind="segmented" data-initial="${initial}" ${initial === optionValue ? html`checked` : ""}><span>${optionLabel}</span></label>`,
      )}</div></fieldset>`;
  }
  let control;
  if (kind === "select") {
    control = html`<select ${common}>${options.map(
      ([optionValue, optionLabel]) =>
        html`<option value="${optionValue}" ${initial === optionValue ? html`selected` : ""}>${optionLabel}</option>`,
    )}</select>`;
  } else {
    const type = kind === "number" ? "number" : kind === "url" ? "url" : "text";
    control = html`<input type="${type}" ${common} value="${initial}" placeholder="${placeholder}" ${kind === "number" ? html`min="0" step="1" inputmode="numeric"` : ""} autocomplete="off" spellcheck="false">`;
  }
  return html`<div class="field">${head}${control}${help}</div>`;
}

function settingsCard(id, title, description, fields, footnote = "") {
  return html`<section class="settings-section" aria-labelledby="${id}">
    <div class="settings-intro"><h2 id="${id}">${title}</h2><p>${description}</p></div>
    <form class="card settings-card config-form" novalidate>
      <div class="settings-fields">${fields}</div>
      <div class="settings-footer"><span class="muted small">${footnote}</span><div data-status class="settings-status"></div><button type="submit" disabled>Save changes</button></div>
    </form>
  </section>`;
}

/** The set and unset lists for the fields of `form` that differ from what the page loaded. */
function changesOf(form) {
  const set = {};
  const unset = [];
  const seen = new Set();
  for (const input of form.querySelectorAll("[data-kind]")) {
    const key = input.name;
    if (!key || seen.has(key)) continue;
    const kind = input.dataset.kind;
    let current;
    if (kind === "toggle") current = input.checked ? "true" : "false";
    else if (kind === "segmented") {
      seen.add(key);
      current = form.querySelector(`[name="${CSS.escape(key)}"]:checked`)?.value ?? "";
    } else current = input.value.trim();
    const initial = kind === "toggle" ? (input.dataset.initial === "true" ? "true" : "false") : input.dataset.initial;
    if (current === initial) continue;
    if (current === "" && kind !== "toggle") unset.push(key);
    else if (kind === "list")
      set[key] = JSON.stringify(
        current
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      );
    else set[key] = current;
  }
  return { set, unset };
}

function wireDirty(root) {
  for (const form of root.querySelectorAll(".config-form")) {
    const button = form.querySelector('button[type="submit"]');
    const update = () => {
      const { set, unset } = changesOf(form);
      const dirty = Object.keys(set).length + unset.length;
      button.disabled = dirty === 0;
      button.textContent = dirty ? `Save ${dirty} ${dirty === 1 ? "change" : "changes"}` : "Save changes";
      form.toggleAttribute("data-dirty", dirty > 0);
    };
    form.addEventListener("input", update);
    form.addEventListener("change", update);
  }
}

function connectionCard(ctx, connection) {
  const base = `connections.${connection.name}`;
  const models = isObject(connection.models) ? connection.models : {};
  const aliasKey = (alias) => (isObject(models[alias]) ? `${base}.models.${alias}.model` : `${base}.models.${alias}`);
  return html`<form class="card settings-card config-form connection-card" novalidate>
    <div class="connection-head"><h3 class="mono">${connection.name}</h3>${ctx.defaultConnection === connection.name ? badge("default", "info") : ""}</div>
    <div class="settings-fields settings-grid">
      ${field(ctx, { key: `${base}.endpoint`, label: "Endpoint", kind: "url", placeholder: "host:port/v1/chat/completions" })}
      ${field(ctx, { key: `${base}.apiKey`, label: "API key", placeholder: "$OPENAI_API_KEY", hint: "An environment variable reference such as $OPENAI_API_KEY. Literal keys are never stored." })}
      ${ALIASES.map((alias) => field(ctx, { key: aliasKey(alias), label: `${alias[0].toUpperCase()}${alias.slice(1)} model`, placeholder: "model id" }))}
      ${field(ctx, { key: `${base}.concurrency`, label: "Concurrency", kind: "number", hint: "Requests in flight at once." })}
    </div>
    <div class="settings-footer"><span></span><div data-status class="settings-status"></div><button type="submit" disabled>Save changes</button></div>
  </form>`;
}

function newConnectionForm() {
  return html`<details class="card settings-card add-card"><summary>Add a connection</summary>
    <form class="new-connection" novalidate><div class="settings-fields settings-grid">
      <div class="field"><label class="field-label" for="nc-name">Name</label><input id="nc-name" name="name" required pattern="[A-Za-z0-9_-]+" placeholder="local" autocomplete="off"></div>
      <div class="field"><label class="field-label" for="nc-endpoint">Endpoint</label><input id="nc-endpoint" name="endpoint" type="url" required placeholder="127.0.0.1:1234/v1/chat/completions"></div>
      <div class="field"><label class="field-label" for="nc-model">Model</label><input id="nc-model" name="model" required placeholder="model id" autocomplete="off"><p class="field-hint">Used for the fast, balanced and reasoning aliases; change any of them later.</p></div>
      <div class="field"><label class="field-label" for="nc-key">API key</label><input id="nc-key" name="apiKey" placeholder="$OPENAI_API_KEY" autocomplete="off"><p class="field-hint">Optional. An environment variable reference.</p></div>
      </div><div class="settings-footer"><span></span><div data-status class="settings-status"></div><button type="submit">Add connection</button></div>
    </form></details>`;
}

function referenceTree(value) {
  return html`<pre class="code config-json" tabindex="0" role="group" aria-label="Configuration, scrolls sideways">${pretty(value)}</pre>`;
}

export async function render(ctx) {
  const data = await api("/api/config");
  const config = data.config ?? {};
  const bundles = Object.keys(config.bundles ?? {});
  const page = {
    config,
    sources: new Map(data.entries.map((entry) => [entry.path, entry.source])),
    defaultConnection: data.connections.find((c) => c.default)?.name ?? data.connections[0]?.name,
  };
  const bundleOptions = [["", "Automatic (working stash)"], ...bundles.map((name) => [name, name])];
  ctx.after.push((root) => {
    wireDirty(root);
    actionForm(root, ".config-form", (form) => post("/api/config/set", changesOf(form)));
    actionForm(root, ".new-connection", (_form, values) => {
      const model = String(values.get("model")).trim();
      const entry = {
        endpoint: String(values.get("endpoint")).trim(),
        models: Object.fromEntries(ALIASES.map((alias) => [alias, model])),
      };
      const apiKey = String(values.get("apiKey") ?? "").trim();
      if (apiKey) entry.apiKey = apiKey;
      return post("/api/config/set", {
        set: { [`connections.${String(values.get("name")).trim()}`]: JSON.stringify(entry) },
      });
    });
    actionForm(root, ".advanced-set", (_form, values) => {
      const key = String(values.get("key")).trim();
      const value = String(values.get("value"));
      return post("/api/config/set", values.get("unset") ? { unset: [key] } : { set: { [key]: value } });
    });
  });
  return html`${pageHeader("Config", html`Settings for this install, saved to <span class="mono">${data.path}</span>. Every change is validated like <code>akm config set</code>.`)}
    ${data.exists ? "" : html`<div class="notice"><p>There is no config file yet. Saving any setting creates it.</p></div>`}
    ${settingsCard(
      "set-search",
      "Search",
      "How search finds and ranks your assets.",
      html`${field(page, {
        key: "semanticSearchMode",
        label: "Semantic search",
        kind: "segmented",
        options: [
          ["off", "Off"],
          ["auto", "Auto"],
        ],
        hint: "Auto uses embeddings when the index has them, and keyword search otherwise.",
      })}
        ${field(page, { key: "search.defaultExcludeTypes", label: "Hide these types by default", kind: "list", placeholder: "memory, script", hint: "Comma-separated asset types that search leaves out unless you ask for them." })}
        ${field(page, { key: "search.curateRerank.enabled", label: "Rerank curate results", kind: "toggle", hint: "Send the top candidates to a reranker model before curate picks." })}
        ${field(page, { key: "search.curateRerank.endpoint", label: "Reranker endpoint", kind: "url", placeholder: "host:port/rerank" })}
        ${field(page, { key: "search.curateRerank.topN", label: "Candidates to rerank", kind: "number", placeholder: "30", hint: "At most 50." })}`,
    )}
    ${settingsCard(
      "set-library",
      "Library",
      "Where akm reads by default and where it writes new assets.",
      html`${field(page, { key: "defaultBundle", label: "Default bundle", kind: "select", options: bundleOptions })}
        ${field(page, { key: "defaultWriteTarget", label: "Default write target", kind: "select", options: bundleOptions, hint: "New knowledge, memories and accepted proposals are written here." })}
        ${field(page, { key: "archiveRetentionDays", label: "Keep archived assets for", kind: "number", placeholder: "30", hint: "Days before retired assets are purged from the archive." })}
        ${field(page, { key: "feedback.requireReason", label: "Require a reason with feedback", kind: "toggle", hint: "Negative feedback always needs a reason; this asks for one on positive feedback too." })}`,
    )}
    ${settingsCard(
      "set-output",
      "Command output",
      "The defaults the akm CLI uses when you pass no --format or --detail.",
      html`${field(page, { key: "output.format", label: "Format", kind: "select", options: OUTPUT_FORMATS.map((f) => [f, f]) })}
        ${field(page, { key: "output.detail", label: "Detail", kind: "segmented", options: DETAILS.map((d) => [d, d[0].toUpperCase() + d.slice(1)]) })}`,
    )}
    <section class="settings-section" aria-labelledby="set-connections">
      <div class="settings-intro"><h2 id="set-connections">Model connections</h2><p>The OpenAI-compatible endpoints improve, judges and agents call. Keys are environment variable references.</p></div>
      <div class="stack">${data.connections.map((c) => connectionCard(page, c))}${data.connections.length === 0 ? emptyState("No connections yet.", "Add one to let improve and the judges call a model.") : ""}${newConnectionForm()}</div>
    </section>
    <section class="settings-section" aria-labelledby="set-advanced">
      <div class="settings-intro"><h2 id="set-advanced">Advanced</h2><p>Set or unset any key, as <code>akm config set</code> does. Objects and lists take JSON.</p></div>
      <div class="stack">
        <form class="card settings-card advanced-set" novalidate><div class="settings-fields settings-grid">
          <div class="field"><label class="field-label" for="adv-key">Key</label><input id="adv-key" name="key" required placeholder="improve.processes.reflect.enabled" autocomplete="off" spellcheck="false"></div>
          <div class="field"><label class="field-label" for="adv-value">Value</label><input id="adv-value" name="value" placeholder="true" autocomplete="off" spellcheck="false"></div>
          </div><div class="settings-footer"><label class="check-label"><input type="checkbox" role="switch" class="switch" name="unset"> Unset this key instead</label><div data-status class="settings-status"></div><button type="submit">Apply</button></div>
        </form>
        <details class="card"><summary>Effective config <span class="muted small">(read-only, secrets redacted)</span></summary>${referenceTree(config)}</details>
        ${data.harnesses.length ? html`<details class="card"><summary>Harnesses</summary>${tableWrap(html`<table><thead><tr><th>Name</th><th>Platform</th></tr></thead><tbody>${data.harnesses.map((h) => html`<tr><td class="mono">${h.name}</td><td class="mono">${h.platform ?? h.name}</td></tr>`)}</tbody></table>`)}</details>` : ""}
        <details class="card"><summary>Environment <span class="muted small">(${data.env.length} AKM_* variables)</span></summary>${
          data.env.length === 0
            ? html`<p class="muted">No AKM_* environment variables are set.</p>`
            : tableWrap(
                html`<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody>${data.env.map((e) => html`<tr><td class="mono">${e.name}</td><td class="mono wrap">${e.value === "[redacted]" ? html`<span class="redacted">[redacted]</span>` : e.value}</td></tr>`)}</tbody></table>`,
              )
        }</details>
      </div>
    </section>`;
}
