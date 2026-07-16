// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Generic command-keyed registry factory.
 *
 * `src/output/shapes/registry.ts` and `src/output/text/registry.ts` are both
 * thin `Map<string, Handler>` wrappers with identical register/registerAll/
 * deregister/get semantics — they differ only in the handler's function
 * signature. This factory captures that shared shape once so each call site
 * only needs to name its handler type.
 */

/**
 * A single registration: a command name plus its handler.
 */
export interface CommandRegistryEntry<H> {
  command: string;
  handler: H;
}

/**
 * A command-keyed handler registry.
 */
export interface CommandRegistry<H> {
  /**
   * Register a single handler for a command name. Overwrites any existing
   * registration for the same name (last write wins).
   */
  register(command: string, handler: H): void;
  /**
   * Register a batch of entries in iteration order. Equivalent to calling
   * {@link CommandRegistry.register} once per entry.
   */
  registerAll(entries: Iterable<CommandRegistryEntry<H>>): void;
  /**
   * Remove a previously-registered handler. No-op if the command was never
   * registered.
   */
  deregister(command: string): void;
  /**
   * Look up a registered handler by command name. Returns `undefined` if not
   * registered.
   */
  get(command: string): H | undefined;
}

/**
 * Create a fresh, independent {@link CommandRegistry} backed by its own
 * `Map`. Each call returns a distinct registry — call once per registry
 * module and hold the result in a module-level `const`.
 */
export function createCommandRegistry<H>(): CommandRegistry<H> {
  const handlers = new Map<string, H>();
  return {
    register(command: string, handler: H): void {
      handlers.set(command, handler);
    },
    registerAll(entries: Iterable<CommandRegistryEntry<H>>): void {
      for (const { command, handler } of entries) {
        handlers.set(command, handler);
      }
    },
    deregister(command: string): void {
      handlers.delete(command);
    },
    get(command: string): H | undefined {
      return handlers.get(command);
    },
  };
}
