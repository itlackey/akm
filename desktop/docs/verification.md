# Verification

Run from a clean clone using the setup commands in [README](../README.md).
Use Node for Desktop tests; Bun builds and packs core.

```sh
npm run check
npm run build
npm test
npm run test:e2e
npm run test:usability
npm run test:electron
npm run dist
npm run smoke
```

Build before starting tests. Install the pinned Electron runtime explicitly and
install Playwright Chromium with `npx playwright install chromium`. Native
Electron tests need a display (or Xvfb) and a working Chromium sandbox.
Browser test files use bounded parallelism so multiple full Electron/Chromium
workspaces do not compete with each other's startup assertions.

All tests create synthetic HOME/XDG/AKM directories, removed afterwards
(`AKM_DESKTOP_KEEP_FIXTURES=1` keeps them for diagnosis; set `AKM_DESKTOP_SCREENSHOTS`
to keep screenshots). They do not use real bundles, providers, credentials or the
host's installed CLI for workspace actions. Fixtures are built with the CLI:
`akm index`, `akm proposal new` (a stand-in agent returns the proposal; no model runs),
and `akm search`/`show`/`feedback` for usage. Recorded task and improve runs and stored
embeddings, which no command makes without a scheduler or a model, are inserted with SQL into
the databases the CLI created. No test imports akm internals.

| Layer | Where |
| --- | --- |
| Transport and wiring: every route reaches its operation; errors map to one status | `server-routes`, `server-reveal`, `file-edit`, `runtime` (`npm test`, no browser) |
| Desktop features: host tools, menu install, reveal policy, file editing, view models | `software`, `menu-install`, `file-edit`, `*-model`, `presenters` (`npm test`) |
| UI: one happy path and one refusal per section, navigation and drafts, protected files, Software, first-run setup | `e2e`, `navigation`, `sensitive-ui`, `software-ui`, `setup-ui` (`npm run test:e2e`) |
| Accessibility, reflow and design language | `usability*`, `design-language` (`npm run test:usability`) |
| The web process without Electron: starts under plain Node, answers the shell and two reads | `scripts/server-guard.mjs` (`npm run test:server`, after a build) |
| Electron main: sandbox, isolation, navigation, lifecycle | `electron` (`npm run test:electron`, needs a display: `xvfb-run -a`) |

What an operation decides (revisions, leases, staleness, write targets) is tested in akm
(`tests/integration/workspace/`), not here.

Packaging installs the local core package into a new production-only stage.
To test the actual packaged runtime and server, use the stage and executable
paths printed by the packaging command:

```sh
AKM_DESKTOP_TEST_APP_ROOT=/path/to/resources/app AKM_DESKTOP_TEST_RUNTIME=/path/to/akm-desktop npm test
AKM_DESKTOP_TEST_APP_ROOT=/path/to/resources/app AKM_DESKTOP_TEST_RUNTIME=/path/to/akm-desktop npm run test:electron
```

The native test checks sandbox/context isolation, fixed window size, SQLite
workspace access, unsaved-work protection and child-server shutdown. Inspect
its screenshot as well as the browser workflow screenshots; passing assertions
alone are not a visual review.

Packaging is proven on Linux x64, macOS arm64 and Windows x64 by CI (`desktop-package` in
`.github/workflows/ci.yml`): each builds the installers and `npm run smoke` starts the packaged
app headless (its own server, answering `/api/desktop` with the embedded version, and serving the
UI). The native-window tests (`test:electron`) run on Linux under Xvfb. Signed installers and
macOS/Windows window tests are not established by these tests. The release workflow can be
rehearsed without publishing: `gh workflow run release.yml --ref <branch> -f version=<version> -f dry_run=true`.
Optional network installation tests are described in
[Software](software.md); do not count skipped opt-in tests as verified.
