// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Visual-regression config (plan 8.7). Baselines are only valid when produced
 * by the pinned image (`bun run test:ui-visual:docker`, or the ui-visual
 * workflow); never run `--update-snapshots` anywhere else.
 */

import { defineConfig, devices } from "@playwright/test";
import { VISUAL_PORT } from "./constants";

const WIDTHS = { desktop: 1440, mobile: 390 } as const;
const SCHEMES = ["light", "dark"] as const;

const projects = Object.entries(WIDTHS).flatMap(([name, width]) =>
  SCHEMES.map((colorScheme) => ({
    name: `${name}-${colorScheme}`,
    use: { ...devices["Desktop Chrome"], viewport: { width, height: 900 }, colorScheme },
  })),
);

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.pw.ts",
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}-{projectName}{ext}",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  outputDir: "test-results",
  use: {
    baseURL: `http://127.0.0.1:${VISUAL_PORT}`,
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
  },
  expect: {
    toHaveScreenshot: { maxDiffPixels: 0, threshold: 0.1, animations: "disabled", caret: "hide" },
  },
  projects,
  webServer: {
    command: "bun tests/visual/serve.ts",
    cwd: "../..",
    port: VISUAL_PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
