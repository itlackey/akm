// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Visual-regression config (plan 8.7). Baselines are only valid when produced
 * by the pinned image (`bun run test:ui-visual:docker`, or the ui-visual
 * workflow); never run `--update-snapshots` anywhere else.
 */

import { defineConfig, devices } from "@playwright/test";
import { PROFILES } from "./constants";

const VIEWPORTS = { 1440: 900, 390: 844 } as const;
const SCHEMES = ["light", "dark"] as const;

/** The full matrix: every width in both schemes. */
const matrix = Object.entries(VIEWPORTS).flatMap(([width, height]) =>
  SCHEMES.map((colorScheme) => ({
    name: `${width}--${colorScheme}`,
    testMatch: ["matrix.pw.ts", "interactions.pw.ts", "gallery.pw.ts"],
    use: { ...devices["Desktop Chrome"], viewport: { width: Number(width), height }, colorScheme },
  })),
);

/** Forced colors and `prefers-contrast: more`, light, at both widths. */
const accessibility = Object.entries(VIEWPORTS).flatMap(([width, height]) =>
  (
    [
      ["forced-colors", { forcedColors: "active" }],
      ["contrast-more", { contrast: "more" }],
    ] as const
  ).map(([name, preference]) => ({
    name: `${width}--${name}`,
    testMatch: "accessibility.pw.ts",
    use: {
      ...devices["Desktop Chrome"],
      viewport: { width: Number(width), height },
      colorScheme: "light" as const,
      ...preference,
    },
  })),
);

const projects = [
  ...matrix,
  ...accessibility,
  // The `wide` edge (plan 11.2): light only.
  {
    name: "1280--light",
    testMatch: "wide.pw.ts",
    use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }, colorScheme: "light" as const },
  },
  // Assertions and audits that take no screenshot.
  {
    name: "320--light",
    testMatch: "reflow.pw.ts",
    use: { ...devices["Desktop Chrome"], viewport: { width: 320, height: 640 }, colorScheme: "light" as const },
  },
  {
    name: "audit",
    testMatch: ["style-audit.pw.ts", "tools.pw.ts"],
    use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, colorScheme: "light" as const },
  },
];

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.pw.ts",
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}--{projectName}{ext}",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: [["list"], ["html", { open: "never", outputFolder: "../../.ui-visual/report" }]],
  outputDir: "../../.ui-visual/test-results",
  use: {
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
  },
  expect: {
    toHaveScreenshot: { maxDiffPixels: 0, threshold: 0.1, animations: "disabled", caret: "hide" },
  },
  projects,
  webServer: Object.entries(PROFILES).map(([profile, port]) => ({
    command: `bun tests/visual/serve.ts ${profile}`,
    cwd: "../..",
    port,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  })),
});
