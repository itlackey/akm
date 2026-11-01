// Bundles: one card per configured bundle with git status and asset counts, plus the index state.

import { proportionBar } from "./charts.js";
import {
  actionForm,
  api,
  badge,
  definitionList,
  emptyState,
  fmtNum,
  fmtPct,
  html,
  pageHeader,
  post,
  when,
} from "./lib.js";

function gitBlock(git) {
  if (!git) return html`<p class="muted">Not a git repository.</p>`;
  const sync =
    git.upstream === null
      ? html`<span class="muted">no upstream</span>`
      : html`<span class="num">${git.ahead} ahead, ${git.behind} behind</span> <span class="muted mono">${git.upstream}</span>`;
  return definitionList([
    [
      "Branch",
      git.branch ? html`<span class="mono">${git.branch}</span>` : html`<span class="muted">detached HEAD</span>`,
    ],
    ["Remote", sync],
    [
      "Uncommitted",
      git.dirtyPaths > 0 ? badge(`${git.dirtyPaths} paths`, "warn") : html`<span class="muted">clean</span>`,
    ],
    [
      "Last commit",
      git.lastCommit
        ? html`${when(git.lastCommit.time)} <span class="mono small">${git.lastCommit.sha.slice(0, 8)}</span><div class="small">${git.lastCommit.subject}</div>`
        : html`<span class="muted">none</span>`,
    ],
  ]);
}

function card(bundle) {
  const writableKind = ["filesystem", "git"].includes(bundle.kind);
  return html`<article class="card">
    <header class="card-head"><h3>${bundle.name}</h3>${badge(bundle.kind, "info")}${bundle.default ? badge("default", "neutral") : ""}${bundle.enabled ? "" : badge("disabled", "warn")}${bundle.writable ? badge("writable", "ok") : badge("read-only", "neutral")}${bundle.exists ? "" : badge("missing", "fail")}</header>
    <p><a href="#/search?bundle=${encodeURIComponent(bundle.name)}">Browse assets</a></p>
    ${definitionList([
      ["Path", bundle.path ? html`<span class="mono">${bundle.path}</span>` : html`<span class="muted">none</span>`],
      [
        "Source",
        bundle.source?.locator === bundle.path
          ? html`<span class="muted">${bundle.source?.kind ?? "unknown"} path</span>`
          : html`<span class="mono">${bundle.source?.locator ?? ""}</span> <span class="muted">(${bundle.source?.kind ?? "unknown"})</span>`,
      ],
      ["Version", bundle.version],
      ["Assets", html`<span class="num">${fmtNum(bundle.itemCount)}</span>`],
    ])}
    ${proportionBar(bundle.byType ?? {})}
    <h4>Git</h4>${gitBlock(bundle.git)}
    <details><summary>Bundle settings</summary>
      <form class="bundle-settings form-grid" data-bundle="${bundle.name}">
        <p class="muted small">Settings from ${bundle.settingsSource ?? "configuration"}. Saving creates a local override. Component settings take precedence over the bundle writable default. Choose another default before disabling the default bundle.</p>
        <label class="check-label"><input type="checkbox" role="switch" class="switch" name="enabled" data-initial="${bundle.enabled}" ${bundle.enabled ? html`checked` : ""}> Enabled</label>
        <label class="check-label"><input type="checkbox" role="switch" class="switch" name="writable" data-initial="${bundle.writableSetting ?? bundle.kind === "filesystem"}" ${(bundle.writableSetting ?? bundle.kind === "filesystem") ? html`checked` : ""} ${writableKind ? "" : html`disabled`}> Bundle writable default</label>
        ${(bundle.components ?? []).map((c) => html`<label class="check-label"><input type="checkbox" role="switch" class="switch" name="component:${c.name}" data-initial="${c.writable ?? bundle.writableSetting ?? bundle.kind === "filesystem"}" ${(c.writable ?? bundle.writableSetting ?? bundle.kind === "filesystem") ? html`checked` : ""} ${writableKind && c.configured && !c.name.includes(".") ? "" : html`disabled`}> ${c.name} writable <span class="muted small">(${c.adapter}, ${c.root ?? "."}${c.writable === undefined ? ", inherits default" : ", explicit override"})</span></label>`)}
        <button type="submit">Save settings</button><div data-status></div>
      </form>
    </details>
    <form class="bundle-update" data-bundle="${bundle.name}"><p><button type="submit" class="btn-secondary">Update / reindex bundle</button></p><div data-status></div></form>
    <details><summary>Remove bundle</summary><form class="bundle-remove form-grid" data-bundle="${bundle.name}">
      <p>Uses <code>akm bundle remove</code>. Managed installed content may be deleted; filesystem sources remain on disk.</p>
      <label class="check-label"><input type="checkbox" name="confirm" required> Remove ${bundle.name}</label>
      <button type="submit" class="btn-danger">Remove bundle</button><div data-status></div>
    </form></details>
  </article>`;
}

function workingStashCard(stash) {
  return html`<article class="card">
    <header class="card-head"><h3>Working stash</h3>${badge("default", "neutral")}</header>
    ${definitionList([["Path", html`<span class="mono">${stash.path}</span>`]])}
    <h4>Git</h4>${gitBlock(stash.git)}
  </article>`;
}

const plain = (value) => (typeof value === "string" ? value : JSON.stringify(value));

function indexPanel(index) {
  const semantic = index.semanticSearch;
  return html`<section class="settings-section" aria-labelledby="bundles-index"><div class="settings-intro"><h2 id="bundles-index">Index</h2><p>The search index across every enabled bundle.</p></div><div class="card">
    ${definitionList([
      ["Entries", html`<span class="num">${fmtNum(index.entryCount)}</span>`],
      ["Last built", index.lastBuiltAt ? when(index.lastBuiltAt) : html`<span class="muted">never</span>`],
      [
        "Embeddings",
        index.hasEmbeddings
          ? html`<span class="num">${fmtNum(index.embeddingCount)}</span> (${fmtPct(index.embeddingCoverage)} coverage)`
          : html`<span class="muted">none</span>`,
      ],
      [
        "Semantic search",
        semantic ? html`<span class="mono">${semantic.mode}</span> <span class="muted">${semantic.status}</span>` : "",
      ],
      ["Unavailable", index.unavailable ? html`<span class="mono small">${plain(index.unavailable)}</span>` : ""],
      ["Unreadable", index.unreadable ? html`<span class="mono small">${plain(index.unreadable)}</span>` : ""],
    ])}
    ${proportionBar(index.byType ?? {})}
  </div></section>`;
}

export async function render(ctx) {
  const data = await api("/api/bundles");
  ctx.after.push((root) => {
    actionForm(root, ".bundle-settings", (form, values) =>
      post("/api/bundles/settings", {
        bundle: form.dataset.bundle,
        ...Object.fromEntries(
          ["enabled", "writable"]
            .filter(
              (key) =>
                !form.elements[key].disabled &&
                form.elements[key].checked !== (form.elements[key].dataset.initial === "true"),
            )
            .map((key) => [key, values.has(key)]),
        ),
        componentWritability: Object.fromEntries(
          [...form.querySelectorAll('input[name^="component:"]:not(:disabled)')]
            .filter((input) => input.checked !== (input.dataset.initial === "true"))
            .map((input) => [input.name.slice(10), input.checked]),
        ),
      }),
    );
    actionForm(root, ".bundle-defaults", (form, values) =>
      post(
        "/api/bundles/settings",
        Object.fromEntries([...values].filter(([key, value]) => value !== form.elements[key].dataset.initial)),
      ),
    );
    actionForm(root, ".bundle-add", (_form, values) =>
      post("/api/bundles/add", { ...Object.fromEntries(values), writable: values.has("writable") }),
    );
    actionForm(root, ".bundle-update", (form) => post("/api/bundles/update", { bundle: form.dataset.bundle }));
    actionForm(root, ".bundle-remove", (form, values) =>
      post("/api/bundles/remove", { bundle: form.dataset.bundle, confirm: values.has("confirm") }),
    );
  });
  const writeTargetLabel = ({ automaticWriteTarget: t, defaultBundle, workingStash }) =>
    !t
      ? "None (writes need a default bundle)"
      : workingStash && t.path === workingStash.path
        ? "Automatic (working stash)"
        : t.name === defaultBundle
          ? `Default bundle (${t.name})`
          : `Automatic (${t.name})`;
  const choices = (selected, emptyLabel) =>
    html`<option value="">${emptyLabel}</option>${data.bundles.map((b) => html`<option value="${b.name}" ${b.name === selected ? html`selected` : ""}>${b.name}${b.enabled ? "" : " (disabled)"}</option>`)}`;
  return html`${pageHeader("Bundles", data.defaultBundle ? html`Default bundle <span class="mono">${data.defaultBundle}</span>${data.defaultWriteTarget ? html`, writes go to <span class="mono">${data.defaultWriteTarget}</span>` : ""}.` : "")}
    <section class="settings-section" aria-labelledby="bundles-defaults">
      <div class="settings-intro"><h2 id="bundles-defaults">Defaults</h2><p>Which bundle akm reads first, and where new knowledge, memories and accepted proposals are written.</p></div>
      <form class="bundle-defaults card settings-card">
        <div class="settings-fields">
          <div class="field"><label class="field-label" for="bd-default">Default bundle</label><select name="defaultBundle" id="bd-default" data-initial="${data.defaultBundle ?? ""}">${choices(data.defaultBundle, "Automatic (working stash)")}</select></div>
          <div class="field"><label class="field-label" for="bd-write">Default write target</label><select name="defaultWriteTarget" id="bd-write" data-initial="${data.defaultWriteTarget ?? ""}">${choices(data.defaultWriteTarget, writeTargetLabel(data))}</select></div>
        </div>
        <div class="settings-footer"><span></span><div data-status class="settings-status"></div><button type="submit">Save defaults</button></div>
      </form>
    </section>
    <section class="settings-section" aria-labelledby="bundles-configured">
      <div class="settings-intro"><h2 id="bundles-configured">Configured bundles</h2><p>Every source akm indexes, with its git state and what it holds.</p></div><div class="cards cards-narrow">${data.workingStash ? workingStashCard(data.workingStash) : ""}${data.bundles.map(card)}${data.bundles.length === 0 ? emptyState("No other bundles.", html`Add one below or with <code>akm bundle add &lt;source&gt;</code>.`) : ""}</div>
    </section>
    <section class="settings-section" aria-labelledby="bundles-add">
      <div class="settings-intro"><h2 id="bundles-add">Add a bundle</h2><p>A local folder, Git repository, npm package or website. akm detects its format, validates it and indexes it. Adding a remote source uses the network.</p></div>
      <form class="bundle-add card settings-card">
        <div class="settings-fields">
          <div class="field"><label class="field-label" for="ba-source">Source</label><input id="ba-source" name="source" required placeholder="./team-skills, github:org/repo, npm:package or a docs URL" autocomplete="off" spellcheck="false"></div>
          <div class="field"><label class="field-label" for="ba-name">Name</label><input id="ba-name" name="name" placeholder="Optional; defaults to the source name" autocomplete="off" spellcheck="false"></div>
          <div class="field field-row"><div class="field-text"><label class="field-label" for="ba-writable">Allow writes to a Git source</label><p class="field-hint">Local folders are writable by default. Git sources are read-only unless you allow writes.</p></div><input id="ba-writable" type="checkbox" role="switch" class="switch" name="writable"></div>
        </div>
        <div class="settings-footer"><span></span><div data-status class="settings-status"></div><button type="submit">Add bundle</button></div>
      </form>
    </section>
    ${indexPanel(data.index)}`;
}
