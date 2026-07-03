/**
 * Swap-and-restore helpers for src module seams (`_set…ForTests` setters).
 *
 * Tests never call a `_set…ForTests` setter directly — they go through
 * `overrideSeam` / `withSeam` so the harness can restore every active seam
 * automatically (tests/_preload.ts calls `resetAllSeams()` before and after
 * every test). See docs/design/di-seams-plan.md.
 */
type SeamSetter<T> = (fake: T | undefined) => void;

/** Setters that currently hold a fake; drained by resetAllSeams(). */
const active = new Set<SeamSetter<unknown>>();

/**
 * Install a fake for the current test. Restoration is automatic: the
 * tests/_preload.ts afterEach calls resetAllSeams(). Use this for
 * file-scoped or beforeEach-scoped fakes (the common case, mirroring
 * today's top-of-file mock.module blocks).
 */
export function overrideSeam<T>(set: SeamSetter<T>, fake: T): void {
  set(fake);
  active.add(set as SeamSetter<unknown>);
}

/** Scoped swap → run → finally-restore, for fakes needed in one test only. */
export async function withSeam<T, R>(set: SeamSetter<T>, fake: T, run: () => R | Promise<R>): Promise<R> {
  set(fake);
  active.add(set as SeamSetter<unknown>);
  try {
    return await run();
  } finally {
    set(undefined);
    active.delete(set as SeamSetter<unknown>);
  }
}

/** Safety net: restore every active seam. Called by tests/_preload.ts. */
export function resetAllSeams(): void {
  for (const set of active) set(undefined);
  active.clear();
}
