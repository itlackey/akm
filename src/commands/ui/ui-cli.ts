// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm ui` — a local web UI, read-only apart from accepting and rejecting proposals, over the same data the CLI reports:
 * health and metrics, bundles, config, the proposal queue, recent changes and
 * search. See `docs/reference/ui-api.md` for the API the page reads.
 */

import { defineJsonCommand } from "../../cli/shared";
import { UsageError } from "../../core/errors";
import { info, warn } from "../../core/warn";
import { openBrowser } from "./open-browser";
import { isLoopbackBind, startUiServer } from "./server";

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed) || Number(trimmed) > 65535) {
    throw new UsageError(
      `Invalid --port value: "${raw}". Must be a port number from 0 to 65535.`,
      "INVALID_FLAG_VALUE",
    );
  }
  return Number(trimmed);
}

export const uiCommand = defineJsonCommand({
  meta: {
    name: "ui",
    description:
      "Experimental: serve a local web UI (health, bundles, config, proposals, recent changes, search) and open it in your browser. It is read-only except that you can accept and reject proposals in it. The URL carries a per-launch token. Press Ctrl-C to stop.",
  },
  args: {
    port: { type: "string", description: "Port to listen on (default: a random free port)" },
    host: { type: "string", description: "Address to bind (default 127.0.0.1; anything else exposes the stash)" },
    // citty treats `--no-open` as the negation of `open`; declare the positive flag (see `akm health --probe`).
    open: {
      type: "boolean",
      default: true,
      description: "Open the UI in your default browser (on by default).",
      negativeDescription: "Print the URL without opening a browser.",
    },
  },
  async run({ args }) {
    const host = (args.host as string | undefined)?.trim() || "127.0.0.1";
    const server = await startUiServer({ host, port: parsePort(args.port as string | undefined) });
    if (!isLoopbackBind(host)) {
      warn(
        `[ui] Listening on ${host}, not just this machine: anyone who can reach it and has the token can read your stash, config and proposals. Keep the URL private.`,
      );
    }
    // The URL is the command's output, so it goes to stdout like any other result.
    process.stdout.write(`akm ui: ${server.url}\n`);
    info("Press Ctrl-C to stop.");

    if (args.open !== false && !(await openBrowser(server.url))) {
      info("Could not open a browser; open the URL above yourself.");
    }

    await new Promise<void>((resolve) => {
      const stop = () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    await server.close();
  },
});
