# Reused AKM presentation code

`src/lib/upstream/` imports the shared styles, DOM helpers, diff algorithm and
charts directly from this repository's `src/assets/ui/`. Only the modified
`diff-view.js` and `markdown.js` remain Desktop-owned adaptations of that code
(original source: `c3bb055`). Domain operations delegate to `akm-cli/workspace`.

Desktop modifies `diff-view.js` to accept optional display labels for
comparisons between unrelated assets, and to start every diff inline. A
side-by-side choice lasts for the open diff, not future diffs or other workflows.
Proposal diffs retain the upstream Current/Proposed labels and the same
alignment, escaping and safety behavior.

Desktop also extends `markdown.js` to render the Markdown editor's asterisk
emphasis, explicit block quotes, and matching-length backtick code spans. It
retains AKM's escaped-HTML construction, restricted link destinations, indexed
heading/link context, and source-only storage. The renderer is a deliberately
limited Markdown presentation subset, not a full CommonMark implementation;
unsupported syntax remains text. These additions and their security regression
tests must be considered when syncing the upstream helper.

The copied AKM files are covered by the Mozilla Public License 2.0; its text is
included at `src/lib/upstream/LICENSE`. The vendored ECharts renderer retains its
embedded Apache 2.0 / BSD notices. Review upstream presentation changes before
syncing these copies; do not replace Desktop's task-specific Svelte workflows
wholesale.

The application package includes these notices and source files so the license
and provenance remain available outside this checkout. The npm dependency graph
also retains each dependency's original license in `node_modules`.

## fhold menu integration

`electron/menu-install.mjs` and its unit tests adapt the per-user AppImage menu
installation pattern from `fwdslsh/fhold`, `packages/electron/src/admin-desktop.ts`
and its tests, reviewed at `907ceb9427c1d1b5414870abf8d1b5132bc5facf`.
It uses Desktop's existing authenticated server/main-process bridge, not fhold's
instance management or IPC framework. The original MIT notice follows:

MIT License

Copyright (c) 2026 fwdslsh

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
