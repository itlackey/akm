// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { defineJsonCommand, output, parseAllFlagValues } from "../cli/shared";
import { UsageError } from "../core/errors";
import { akmFeedback } from "./feedback";

export const feedbackCommand = defineJsonCommand({
  meta: {
    name: "feedback",
    description:
      "Record positive or negative feedback for any indexed bundle asset.\n\n" +
      '`akm feedback <ref> --negative --reason "<what is wrong and what should change>"` flags\n' +
      "the asset: the next improve run may repair its description, title or when_to_use from\n" +
      "your reason, but it does not rewrite the text. To correct a wrong fact in the text, attach\n" +
      'the exact fix: --replace "<exact current text>" --with "<corrected text>" --source "<URL,\n' +
      'command or file that shows it>" (repeat --replace/--with for several edits; use --with=...\n' +
      "for a value that starts with -). akm checks that each --replace text appears exactly once\n" +
      "and applies the edit at once, with no review (`akm proposal revert` undoes it). To mark\n" +
      "the asset's history instead, add\n" +
      "--superseded-by <ref> (the asset that replaces it) or --outdated (it describes a past\n" +
      "state and nothing replaces it), with --reason and --source: the same edit sets its\n" +
      "beliefState and, for --superseded-by, adds the ref to supersededBy. `--positive` records\n" +
      "that an asset helped (it raises its ranking) and does not trigger a rewrite.\n\n" +
      "Feedback changes `akm search` and `akm curate` ranking starting with the very\n" +
      "next search; no reindex is needed. Each recorded positive raises the asset's\n" +
      "score and each negative lowers it, the same way for every asset: the more\n" +
      "positives, the higher it ranks (5 outrank 2), and each further vote counts\n" +
      "for a little less. The effect is small: in keyword-only search one vote\n" +
      "moves a hit one place, and with embeddings it breaks only near-ties. Only\n" +
      "feedback recorded as the user counts, not feedback from improve, task or\n" +
      "audit runs. Feedback also moves the utility score that improve and\n" +
      "`akm doctor metrics` read.",
  },
  args: {
    // Optional in citty so run() is invoked even when omitted; we re-validate
    // and throw a structured UsageError below so exit code is 2 (USAGE) rather
    // than citty's default 0 (help banner).
    ref: { type: "positional", description: "Asset ref ([bundle//]conceptId, e.g. lessons/deploy)", required: false },
    positive: {
      type: "boolean",
      description: "Record that the asset helped (raises its ranking immediately; does not trigger a rewrite)",
      default: false,
    },
    negative: {
      type: "boolean",
      description:
        "Flag the asset: lowers its ranking now; the next improve run may repair its frontmatter from --reason",
      default: false,
    },
    reason: {
      type: "string",
      description: "What is wrong with the asset's content and what should change. Not for akm command errors",
    },
    replace: {
      type: "string",
      description: "Exact text to correct; it must appear exactly once (repeatable, paired with --with)",
    },
    with: {
      type: "string",
      description: "Corrected text for the matching --replace (repeatable, in the same order).",
    },
    source: {
      type: "string",
      description: "Where the correct fact comes from (URL, command or file). Required with --replace",
    },
    "superseded-by": {
      type: "string",
      description: "Ref of the asset that replaces this one (needs --source)",
    },
    outdated: {
      type: "boolean",
      description: "Mark the asset as describing a past state with no replacement (needs --source)",
      default: false,
    },
    tag: {
      type: "string",
      description: "Tag to attach to the feedback (repeatable, e.g. --tag slice:train --tag team:platform)",
    },
    "applied-to": {
      type: "string",
      description:
        "Credit a `lessons/<name>` ref that helped; with --positive it is added to the lesson's lessonStrength",
    },
  },
  async run({ args }) {
    if (args.positive && args.negative) {
      throw new UsageError("Specify either --positive or --negative, not both.");
    }
    if (!args.positive && !args.negative) {
      throw new UsageError("Specify --positive or --negative.");
    }
    // Repeatable flags are read from argv; each --replace pairs with a --with, in order.
    const replaces = parseAllFlagValues("--replace");
    const withs = parseAllFlagValues("--with");
    if (replaces.length !== withs.length) {
      throw new UsageError(
        `Each --replace needs one --with (got ${replaces.length} --replace and ${withs.length} --with).`,
        "INVALID_FLAG_VALUE",
      );
    }
    if (parseAllFlagValues("--superseded-by").length > 1) {
      throw new UsageError("--superseded-by takes one ref.", "INVALID_FLAG_VALUE");
    }
    output(
      "feedback",
      await akmFeedback({
        ref: args.ref ?? "",
        signal: args.positive ? "positive" : "negative",
        reason: args.reason,
        tags: parseAllFlagValues("--tag"),
        fix: replaces.map((replace, i) => ({ replace, with: withs[i] as string })),
        source: args.source,
        supersededBy: args["superseded-by"],
        outdated: args.outdated === true,
        appliedTo: args["applied-to"],
      }),
    );
  },
});
