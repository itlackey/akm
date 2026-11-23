// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os from "node:os";

const observers = new WeakSet<object>();

type ObservedSignal = "SIGINT" | "SIGQUIT" | "SIGTERM" | "SIGHUP";

/** Metrics observe cancellation; they do not own termination or child cleanup. */
export function observeSignal(signal: ObservedSignal, observer: () => void): () => void {
  observers.add(observer);
  // Observe before a genuine once-handler removes itself from the listener list.
  process.prependOnceListener(signal, observer);
  return () => {
    process.off(signal, observer);
    observers.delete(observer);
  };
}

/**
 * akm's guard over its managed children: a persistent listener that, like a metrics observer, is never
 * counted as an owner of the signal.
 */
export function guardSignal(signal: ObservedSignal, listener: () => void): () => void {
  observers.add(listener);
  // First in line, so it sees which owners are listening before a once-handler removes itself.
  process.prependListener(signal, listener);
  return () => {
    process.off(signal, listener);
    observers.delete(listener);
  };
}

let endingBy: NodeJS.Signals | undefined;

/**
 * Make akm end by `signal`, as a process whose child died of it does. The exit code is 128 plus the signal
 * number, for a runtime that cannot re-raise. When the process exits, after output and usage reporting have
 * run, every listener is removed and the signal is raised again with its default disposition.
 */
export function endBySignal(signal: NodeJS.Signals): void {
  if (endingBy) return;
  endingBy = signal;
  const number = os.constants.signals[signal];
  if (number !== undefined && !process.exitCode) process.exitCode = 128 + number;
  process.once("exit", () => {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  });
}

/** listenerCount alone mistakes registered metrics observers for lifecycle owners. */
export function hasSignalOwner(signal: ObservedSignal): boolean {
  return process.listeners(signal).some((listener) => !observers.has(listener));
}
