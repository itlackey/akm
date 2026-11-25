// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The pieces of `akm lint` every adapter's lint is made of. A bundle's findings are what its adapter's `validate`
 * reports (`validateFindings`), narrowed to one file when the run asks for one; `lintByValidate` is that alone (what
 * an adapter returns from `lint` when it has no more to add), and `lintByValidateAndEnvSweep` also reads the `.env`
 * files of every configured bundle for the keys that hijack a process (the default for an adapter without a `lint`).
 * The `akm` adapter adds its own sweep on top (`akm-sweep.ts`).
 */

import fs from "node:fs";
import path from "node:path";
import { stashDirFor } from "../../asset/asset-placement";
import { conceptIdForStashFile, displayRefForConceptId } from "../../asset/resolve-ref";
import { validateBundleAssets } from "../../assets/validate";
import { isAkmRegistryCachePath, safeRealpath } from "../../common";
import { diagnosticToLintIssue, lintIssueDedupeKey } from "../../lint/diagnostics";
import { checkEnvForDangerousKeys } from "../../lint/env-key-rules";
import { readRecordedMoves } from "../../lint/moved-refs";
import { isAdvisoryLintIssue, type LintFindings, type LintIssue, type LintRun } from "../../lint/types";
import { warn } from "../../warn";
import { heldFilesBelow, heldText } from "../directory/held-files";

/**
 * What the bundle's adapter `validate()` reports for the assets it lists that `keep` admits (all of them by default), as
 * lint findings. The edits are the assets the adapter lists (one per concept): `validate` finds the files it ignores itself.
 */
export async function validateFindings(run: LintRun, keep?: (key: string) => boolean): Promise<LintIssue[]> {
  const { bundle, cfg, options } = run;
  const found = await validateBundleAssets(bundle, {
    // akm's own resolved registry-cache copies are not the bundle's content.
    keep: (entry) =>
      !isAkmRegistryCachePath(path.join(bundle.path, entry.key)) && (keep === undefined || keep(entry.key)),
    ctx: { config: cfg, readMoves: options.readMoves ?? readRecordedMoves },
  });
  return found.map(diagnosticToLintIssue);
}

/**
 * Scan every `env/`/`secrets/` `.env` file across the bundle and the other configured bundles for keys that are known
 * to enable process-execution hijacking. This is a cross-bundle SECURITY sweep, not per-adapter validation.
 */
export function envSweepFindings({ bundle, extraStashRoots, sources, cfg }: LintRun): LintIssue[] {
  const flagged: LintIssue[] = [];
  const bundleIdByRoot = new Map(sources.map((source) => [safeRealpath(source.path), source.registryId]));
  for (const root of [bundle.path, ...extraStashRoots]) {
    const bundleId = bundleIdByRoot.get(safeRealpath(root));
    // `env` assets live under `env/`, whole-file `secret` assets under `secrets/`. `displayRefForConceptId` owns the
    // short-default / qualified-secondary `Ref:` spelling `akm show` emits.
    for (const assetType of ["env", "secret"] as const) {
      for (const envPath of heldFilesBelow(root, stashDirFor(assetType) as string, (name) => name.endsWith(".env"))) {
        const conceptId = conceptIdForStashFile(assetType, root, envPath);
        const ref = displayRefForConceptId(conceptId, bundleId, cfg.defaultBundle);
        flagged.push(...checkEnvForDangerousKeys(heldText(envPath), path.relative(root, envPath), ref));
      }
    }
  }
  return flagged;
}

/** Only the findings about `run.file`, when the run names one. */
function narrowedToFile(run: LintRun, found: LintFindings): LintFindings {
  if (run.file === undefined) return found;
  const { real } = run.file;
  const realRoot = fs.realpathSync(run.bundle.path);
  const only = (issues: LintIssue[]): LintIssue[] => issues.filter((i) => path.resolve(realRoot, i.file) === real);
  return { fixed: [], flagged: only(found.flagged), warnings: only(found.warnings) };
}

/** The findings of the bundle's adapter's `validate()`; `validate` never writes, so nothing is fixed. */
async function validated(run: LintRun): Promise<LintFindings> {
  // `--type` names an akm folder; another adapter has its own type vocabulary and `validate()` sees the whole bundle
  // regardless. A user narrowing a run deserves to hear the flag did nothing: warn rather than throw, which would break
  // scripts passing one `--type` across mixed-adapter bundle sets.
  if (run.options.typeFilter && run.file === undefined) {
    warn(
      `Warning: lint --type "${run.options.typeFilter}" is not supported for the "${run.bundle.adapterId}" adapter — ` +
        "type scoping applies to akm bundles only; the whole bundle was validated.",
    );
  }
  const mapped = await validateFindings(run);
  // Advisory diagnostics travel in their own channel — never `flagged`, so a `--fail-on-flagged` gate is not tripped by
  // a non-fatal warning.
  return {
    fixed: [],
    flagged: mapped.filter((issue) => !isAdvisoryLintIssue(issue)),
    warnings: mapped.filter(isAdvisoryLintIssue),
  };
}

/** The findings of the bundle's adapter's `validate()` alone. */
export async function lintByValidate(run: LintRun): Promise<LintFindings> {
  return narrowedToFile(run, await validated(run));
}

/**
 * {@link lintByValidate} plus the cross-bundle `.env` sweep. Some adapters (`dotenv`) also find the same
 * `dangerous-env-key` findings through their own `validate()`: the sweep's are deduped against them by `(file, issue, detail)`.
 */
export async function lintByValidateAndEnvSweep(run: LintRun): Promise<LintFindings> {
  const found = await validated(run);
  const seen = new Set(found.flagged.map(lintIssueDedupeKey));
  for (const issue of envSweepFindings(run)) {
    const key = lintIssueDedupeKey(issue);
    if (seen.has(key)) continue;
    seen.add(key);
    found.flagged.push(issue);
  }
  return narrowedToFile(run, found);
}
