// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Setup wizard step: choose where akm stores its stash (skills, commands,
 * and other assets).
 */

import * as p from "../../cli/clack";
import type { AkmConfig } from "../../core/config/config";
import { primaryBundlePath } from "../../core/config/config";
import { assertSafeStashDir, getDefaultStashDir } from "../../core/paths";
import { prompt } from "../prompt";

export async function stepStashDir(
  current: AkmConfig,
  options?: { nonInteractive?: boolean; preferredDir?: string },
): Promise<string> {
  // 0.9.0 (spec §10.1): the current primary stash is the defaultBundle's path.
  const currentPrimary = primaryBundlePath(current);
  const defaultDir = options?.preferredDir ?? currentPrimary ?? getDefaultStashDir();

  if (options?.nonInteractive) {
    return defaultDir;
  }

  const choice = await prompt(() =>
    p.select({
      message: "Where should akm store skills, commands, and other assets?",
      options: [
        { value: "default", label: defaultDir, hint: currentPrimary ? "current" : "default" },
        { value: "custom", label: "Enter a custom path..." },
      ],
    }),
  );

  if (choice === "default") return defaultDir;

  const customPath = await prompt(() =>
    p.text({
      message: "Enter the stash directory path:",
      placeholder: defaultDir,
      validate: (v) => {
        if (!v?.trim()) return "Path cannot be empty";
        try {
          assertSafeStashDir(v.trim());
        } catch (err) {
          if (err instanceof Error) return err.message;
          return "Refused: unsafe stash directory";
        }
      },
    }),
  );

  return customPath.trim();
}
