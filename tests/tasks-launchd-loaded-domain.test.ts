// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// `parseLaunchdLoadedLabels` reads the current user's OWN launchd inventory —
// the tasks they asked akm to schedule, on their own machine. It is not an
// attacker-controlled document.
//
// This file used to assert the opposite. Most of its cases pinned a rigid
// whole-document grammar that returned `undefined` — a hard
// INVALID_CONFIG_FILE that refused to inspect scheduler state at all — if any
// line failed to match: unrecognized token shapes, duplicate labels, nested
// blocks, extra columns, trailing text. Real `launchctl print gui/<uid>` output
// on macOS is far richer than that grammar allowed, so on a real Mac it
// rejected the user's own inventory and broke every launchd operation. The
// gated native-scheduler suite caught it the first time it was ever dispatched.
//
// What is pinned now is what the function is actually for: find the labels in
// our own `com.akm.task.` namespace and ignore everything else, however large
// the inventory is.

import { describe, expect, test } from "bun:test";
import { parseLaunchdLoadedLabels } from "../src/tasks/backends/launchd";

describe("parseLaunchdLoadedLabels", () => {
  test("reads a domain services table row", () => {
    const output = `gui/501 = {
  services = {
    799  -  com.akm.task.ping
  }
}`;

    expect([...parseLaunchdLoadedLabels(output)!]).toEqual(["com.akm.task.ping"]);
  });

  test("reads every PID and status spelling in a domain services table", () => {
    const output = `gui/501 = {
  services = {
    0  0  com.akm.task.zero
    -  0  com.akm.task.idle
    799  -  com.akm.task.running
    -  -  com.akm.task.dormant
    42  -9  com.akm.task.failed
  }
}`;

    expect([...parseLaunchdLoadedLabels(output)!]).toEqual([
      "com.akm.task.zero",
      "com.akm.task.idle",
      "com.akm.task.running",
      "com.akm.task.dormant",
      "com.akm.task.failed",
    ]);
  });

  test("reads bare, quoted, and dictionary-key label spellings, ignoring non-akm services", () => {
    const output = `gui/501 = {
  type = login
  services = {
    123 = com.akm.task.ping
    "com.akm.task.second" = {
      active count = 1
    }
    99 = com.apple.WindowServer
  }
}`;

    expect([...parseLaunchdLoadedLabels(output)!]).toEqual(["com.akm.task.ping", "com.akm.task.second"]);
  });

  test("reads launchctl list rows while filtering unrelated jobs", () => {
    const output = `PID\tStatus\tLabel
123\t0\tcom.akm.task.ping
-\t0\tcom.akm.task.ping.
999\t0\tcom.apple.WindowServer
`;

    expect([...parseLaunchdLoadedLabels(output)!]).toEqual(["com.akm.task.ping", "com.akm.task.ping."]);
  });

  test("a label repeated across the inventory is reported once, not treated as corruption", () => {
    const output = `PID Status Label
123 0 com.akm.task.ping
- 0 com.akm.task.ping
`;

    expect([...parseLaunchdLoadedLabels(output)!]).toEqual(["com.akm.task.ping"]);
  });

  test("reads a realistically-shaped launchctl print envelope with unrelated sections", () => {
    // The shape that broke macOS: sections beyond `services`, nested
    // dictionaries, arrays, and an akm label appearing outside the services
    // block. Every one of these previously returned undefined.
    const output = `gui/501 = {
	type = login
	handle = 501
	active count = 482
	properties = {
		system domain
		exempt from dyld cache
	}
	endpoints = {
		"com.akm.task.ping" = {
			active = 1
			managed = 0
		}
	}
	services = {
		799     0       com.akm.task.ping
		-       0       com.akm.task.nightly
		1021    0       com.apple.WindowServer
	}
}`;

    expect([...parseLaunchdLoadedLabels(output)!].sort()).toEqual(["com.akm.task.nightly", "com.akm.task.ping"]);
  });

  test("ignores tokens that are not valid labels in our namespace", () => {
    // The prefix appears, but the token is not a well-formed label, so it is
    // skipped rather than poisoning the whole read.
    const output = `gui/501 = {
  services = {
    799 - com.akm.task.ok
    note = com.akm.task.bad$token
    bare = com.akm.task.
  }
}`;

    // `bad$token` carries a character outside the label charset and
    // `com.akm.task.` has no suffix at all; both are skipped, and the valid
    // sibling on the line above is still read.
    expect([...parseLaunchdLoadedLabels(output)!]).toEqual(["com.akm.task.ok"]);
  });

  test("control characters elsewhere in the inventory do not discard the read", () => {
    const output = "gui/501 = {\n  services = {\n    799 - com.akm.task.ping\n    note = \n  }\n}\n";

    expect([...parseLaunchdLoadedLabels(output)!]).toEqual(["com.akm.task.ping"]);
  });

  test("reads every akm label however large the inventory is", () => {
    const labels = Array.from({ length: 5000 }, (_, index) => `${index + 1} 0 com.akm.task.task-${index}`).join("\n");
    const parsed = parseLaunchdLoadedLabels(`${"x".repeat(5 * 1024 * 1024)}\nPID Status Label\n${labels}\n`);
    expect(parsed.size).toBe(5000);
    expect(parsed.has("com.akm.task.task-4999")).toBe(true);
  });
});
