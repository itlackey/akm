// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

const observers = new WeakSet<object>();

/** Metrics observe cancellation; they do not own termination or child cleanup. */
export function observeSignal(signal: "SIGINT" | "SIGTERM", observer: () => void): () => void {
  observers.add(observer);
  // Observe before a genuine once-handler removes itself from the listener list.
  process.prependOnceListener(signal, observer);
  return () => {
    process.off(signal, observer);
    observers.delete(observer);
  };
}

/** listenerCount alone mistakes registered metrics observers for lifecycle owners. */
export function hasSignalOwner(signal: "SIGINT" | "SIGTERM"): boolean {
  return process.listeners(signal).some((listener) => !observers.has(listener));
}
