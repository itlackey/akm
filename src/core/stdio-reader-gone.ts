// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tells a broken pipe on our own stdout/stderr (the reader closed) from the same errno on any other
 * stream. Only the first is ignorable; the rest stay failures.
 */

const isBrokenPipe = (err: unknown): boolean => (err as NodeJS.ErrnoException | undefined)?.code === "EPIPE";

export function trackStdioReaderGone(streams: readonly NodeJS.WritableStream[]): { explains(err: unknown): boolean } {
  let gone = false;
  for (const stream of streams) {
    stream.on("error", (err) => {
      if (!isBrokenPipe(err)) throw err;
      gone = true;
    });
  }
  return { explains: (err) => gone && isBrokenPipe(err) };
}
