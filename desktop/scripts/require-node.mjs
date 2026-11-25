// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The Desktop tests run under `node --test`. Where `node` on PATH is Bun they fail with "Cannot use test outside of the
// test runner"; stop first and say why.
if (process.versions.bun) {
  console.error(
    `The Desktop tests need Node.js, but \`node\` on your PATH is Bun ${process.versions.bun}. Put a real Node.js ahead of it on PATH and run again.`,
  );
  process.exit(1);
}
