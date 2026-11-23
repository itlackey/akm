// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The one owner of akm's standard streams.
 *
 * On Bun, the first read of `process.stdout`/`process.stderr` (any property, `isTTY` included) puts an
 * inherited pipe or socket into non-blocking mode. A child that inherits the stream then loses output
 * written to a full pipe, and the caller's pipe stays non-blocking after akm exits. So akm touches a
 * stream only when it writes to it: nothing in `src/` outside this file names `process.stdout`,
 * `process.stderr` or `process.stdin` (`scripts/lint-stdio-owner.ts` enforces it).
 *
 * Whether a descriptor is a terminal is answered by `isTerminal`, which asks the OS and creates no stream.
 */

import tty from "node:tty";

const isBrokenPipe = (err: unknown): boolean => (err as NodeJS.ErrnoException | undefined)?.code === "EPIPE";

let readerGone = false;
const handedOut = new Set<NodeJS.WriteStream>();

/**
 * Hand out one of our own streams, forgiving a reader that closed early (`akm search … | head`): the
 * command keeps running, its remaining output goes nowhere, and the process ends with the code the work
 * earned. Any other stream error still throws.
 */
function handOut(stream: NodeJS.WriteStream): NodeJS.WriteStream {
  if (!handedOut.has(stream)) {
    handedOut.add(stream);
    stream.on("error", (err) => {
      if (!isBrokenPipe(err)) throw err;
      readerGone = true;
    });
  }
  return stream;
}

/** Our standard output. */
export function stdout(): NodeJS.WriteStream {
  return handOut(process.stdout);
}

/** Our standard error. */
export function stderr(): NodeJS.WriteStream {
  return handOut(process.stderr);
}

/**
 * True when `err` is the broken pipe of a stream handed out by this module. An EPIPE from any other
 * stream (an embedding or LLM socket) is still a failure, and so is any EPIPE before a stream was handed out.
 */
export function explainedByReaderGone(err: unknown): boolean {
  return readerGone && isBrokenPipe(err);
}

let terminalFake: ((fd: 0 | 1 | 2) => boolean) | undefined;

/** TEST-ONLY. Replace the terminal answer; pass undefined to restore. */
export function _setTerminalForTests(fake?: (fd: 0 | 1 | 2) => boolean): void {
  terminalFake = fake;
}

/** Whether standard descriptor `fd` (0 stdin, 1 stdout, 2 stderr) is a terminal. */
export function isTerminal(fd: 0 | 1 | 2): boolean {
  return terminalFake ? terminalFake(fd) : tty.isatty(fd);
}

/** Our standard input, for the Node build's piped-input read. */
export function stdin(): NodeJS.ReadStream {
  return process.stdin;
}
