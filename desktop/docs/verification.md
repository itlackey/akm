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
npm run appimage
```

Build before starting tests. Install the pinned Electron runtime explicitly and
install Playwright Chromium with `npx playwright install chromium`. Native
Electron tests need a display (or Xvfb) and a working Chromium sandbox.
Browser test files use bounded parallelism so multiple full Electron/Chromium
workspaces do not compete with each other's startup assertions.

All tests create synthetic HOME/XDG/AKM directories. They do not use real
bundles, providers, credentials or the host's installed CLI for workspace actions.
Browser tests exercise actual core reads and writes: asset content, proposals,
editing/conflicts, protected-file CRUD, bundle rename, move/link repair,
retirement/undo, navigation, metrics, settings and accessibility.

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

Linux x64 is the current verification target. Other platforms, signed installers
and a public release are not established by these tests.
Optional network installation tests are described in
[Software](software.md); do not count skipped opt-in tests as verified.
