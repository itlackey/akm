// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unlock a GNOME Keyring collection with its password, for a `secret-tool` bundle that has a `credential`.
 *
 * GNOME Keyring takes a password over D-Bus only through its own interface,
 * `org.gnome.keyring.InternalUnsupportedGuiltRiddenInterface.UnlockWithMasterPassword`, which no other Secret
 * Service has. Its secret names a session from `OpenSession`, and a session belongs to the connection that opened it,
 * so both calls must go over one connection: `busctl` makes one call per process and cannot. akm's adapters answer
 * synchronously, so a short child of akm's own runtime holds that connection, and akm waits for it. The child takes
 * the password on stdin, opens a `plain` session (the password crosses the session bus unencrypted, as every
 * Secret Service client's `plain` secrets do) and prints what the service answered.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { ConfigError } from "../../errors";

/** How long the unlock is given: it needs no person, so a service that does not answer fails the command. */
const UNLOCK_TIMEOUT_MS = 15_000;

/** The errors a Secret Service answers with when it has no such interface or method: it is not GNOME Keyring. */
const NOT_GNOME = new Set([
  "org.freedesktop.DBus.Error.UnknownMethod",
  "org.freedesktop.DBus.Error.UnknownInterface",
  "org.freedesktop.DBus.Error.UnknownObject",
]);

/** GNOME Keyring's answer to a wrong password. */
const DENIED = "org.gnome.keyring.Error.Denied";

/**
 * The child: a D-Bus client of the one session-bus connection the unlock needs, written for any runtime akm runs on
 * (`node -e`, `bun -e`, a standalone akm as Bun). It reads `{ socket, collection, password }` as JSON on stdin and
 * prints `{}` once the collection is unlocked, else `{ error, message }` with the D-Bus error the service gave.
 */
const CLIENT = String.raw`
const net = require("node:net");
const SERVICE = "org.freedesktop.secrets";
const SERVICE_PATH = "/org/freedesktop/secrets";

function writer() {
  let buf = Buffer.alloc(256);
  let n = 0;
  const room = (k) => { if (n + k > buf.length) { const grown = Buffer.alloc((n + k) * 2); buf.copy(grown); buf = grown; } };
  const w = {
    pad(align) { while (n % align) { room(1); buf[n++] = 0; } },
    y(x) { room(1); buf[n++] = x; },
    u(x) { w.pad(4); room(4); buf.writeUInt32LE(x, n); n += 4; },
    s(x) { const bytes = Buffer.from(x, "utf8"); w.u(bytes.length); room(bytes.length + 1); bytes.copy(buf, n); n += bytes.length; buf[n++] = 0; },
    o(x) { w.s(x); },
    g(x) { room(x.length + 2); buf[n++] = x.length; buf.write(x, n, "ascii"); n += x.length; buf[n++] = 0; },
    ay(bytes) { w.u(bytes.length); room(bytes.length); bytes.copy(buf, n); n += bytes.length; },
    array(align, fill) { w.u(0); const at = n - 4; w.pad(align); const start = n; fill(); buf.writeUInt32LE(n - start, at); },
    done() { return buf.subarray(0, n); },
  };
  return w;
}

function reader(buf) {
  const little = buf[0] === 108;
  let n = 0;
  const r = {
    at() { return n; },
    pad(align) { n = Math.ceil(n / align) * align; },
    y() { return buf[n++]; },
    u() { r.pad(4); const x = little ? buf.readUInt32LE(n) : buf.readUInt32BE(n); n += 4; return x; },
    s() { const length = r.u(); const x = buf.toString("utf8", n, n + length); n += length + 1; return x; },
    g() { const length = buf[n++]; const x = buf.toString("ascii", n, n + length); n += length + 1; return x; },
    value(type) {
      if (type === "s" || type === "o") return r.s();
      if (type === "g") return r.g();
      if (type === "u") return r.u();
      if (type === "y") return r.y();
      if (type === "v") return r.value(r.g());
      throw new Error("unexpected D-Bus type " + type);
    },
  };
  return r;
}

/** The length of the first whole message in buf, or 0 while it is incomplete. */
function messageLength(buf) {
  if (buf.length < 16) return 0;
  const little = buf[0] === 108;
  const body = little ? buf.readUInt32LE(4) : buf.readUInt32BE(4);
  const fields = little ? buf.readUInt32LE(12) : buf.readUInt32BE(12);
  const total = Math.ceil((16 + fields) / 8) * 8 + body;
  return buf.length >= total ? total : 0;
}

function parse(buf) {
  const r = reader(buf);
  r.y();
  const type = r.y();
  r.y();
  r.y();
  r.u();
  r.u();
  const length = r.u();
  r.pad(8);
  const end = r.at() + length;
  const fields = {};
  while (r.at() < end) {
    r.pad(8);
    const code = r.y();
    fields[code] = r.value("v");
  }
  r.pad(8);
  return { type, fields, body: r };
}

function message(serial, call) {
  const body = writer();
  if (call.fill) call.fill(body);
  const bytes = body.done();
  const h = writer();
  h.y(108); h.y(1); h.y(0); h.y(1); h.u(bytes.length); h.u(serial);
  h.array(8, () => {
    const field = (code, type, value) => { h.pad(8); h.y(code); h.g(type); h[type](value); };
    field(1, "o", call.path);
    field(2, "s", call.iface);
    field(3, "s", call.member);
    field(6, "s", call.dest);
    if (call.sig) field(8, "g", call.sig);
  });
  h.pad(8);
  return Buffer.concat([h.done(), bytes]);
}

async function unlock({ socket, collection, password }) {
  const sock = net.connect(socket);
  let pending = Buffer.alloc(0);
  let wake = () => {};
  sock.on("data", (data) => { pending = Buffer.concat([pending, data]); wake(); });
  const closed = new Promise((_, reject) => {
    sock.on("error", reject);
    sock.on("close", () => reject(new Error("the session bus closed the connection")));
  });
  closed.catch(() => {});
  const more = () => Promise.race([new Promise((resolve) => { wake = resolve; }), closed]);
  await Promise.race([new Promise((resolve) => sock.once("connect", resolve)), closed]);

  sock.write("\0AUTH EXTERNAL " + Buffer.from(String(process.getuid())).toString("hex") + "\r\n");
  while (pending.indexOf("\r\n") < 0) await more();
  const line = pending.subarray(0, pending.indexOf("\r\n")).toString();
  if (!line.startsWith("OK ")) throw new Error("the session bus refused the connection: " + line);
  pending = pending.subarray(pending.indexOf("\r\n") + 2);
  sock.write("BEGIN\r\n");

  let serial = 0;
  const call = async (spec) => {
    const id = ++serial;
    sock.write(message(id, spec));
    for (;;) {
      let length;
      while (!(length = messageLength(pending))) await more();
      const reply = parse(pending.subarray(0, length));
      pending = pending.subarray(length);
      if (reply.fields[5] !== id || (reply.type !== 2 && reply.type !== 3)) continue;
      if (reply.type === 3) {
        const text = (reply.fields[8] || "").startsWith("s") ? reply.body.s() : "";
        return { error: reply.fields[4], message: text };
      }
      return { body: reply.body };
    }
  };

  const hello = await call({ dest: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", iface: "org.freedesktop.DBus", member: "Hello" });
  if (hello.error) return hello;
  const opened = await call({
    dest: SERVICE, path: SERVICE_PATH, iface: "org.freedesktop.Secret.Service", member: "OpenSession", sig: "sv",
    fill: (w) => { w.s("plain"); w.g("s"); w.s(""); },
  });
  if (opened.error) return opened;
  opened.body.value("v");
  const session = opened.body.s();
  const unlocked = await call({
    dest: SERVICE, path: SERVICE_PATH, iface: "org.gnome.keyring.InternalUnsupportedGuiltRiddenInterface",
    member: "UnlockWithMasterPassword", sig: "o(oayays)",
    fill: (w) => { w.o(collection); w.pad(8); w.o(session); w.ay(Buffer.alloc(0)); w.ay(Buffer.from(password, "utf8")); w.s("text/plain"); },
  });
  return unlocked.error ? unlocked : {};
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  unlock(JSON.parse(input)).then(
    (answer) => { process.stdout.write(JSON.stringify(answer)); process.exit(0); },
    (error) => { process.stdout.write(JSON.stringify({ message: String((error && error.message) || error) })); process.exit(0); },
  );
});
`;

/** The session bus's socket: the first `unix:` address of `DBUS_SESSION_BUS_ADDRESS`, else `$XDG_RUNTIME_DIR/bus`, as `busctl --user` finds it. An abstract socket starts with a NUL. */
export function sessionBusSocket(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const address = env.DBUS_SESSION_BUS_ADDRESS;
  if (!address) return env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, "bus") : undefined;
  for (const entry of address.split(";")) {
    if (!entry.startsWith("unix:")) continue;
    const keys = new Map(
      entry
        .slice("unix:".length)
        .split(",")
        .map((pair) => [pair.slice(0, pair.indexOf("=")), decodeURIComponent(pair.slice(pair.indexOf("=") + 1))]),
    );
    const socket = keys.get("path") ?? (keys.has("abstract") ? `\0${keys.get("abstract")}` : undefined);
    if (socket) return socket;
  }
  return undefined;
}

/**
 * Unlock the collection at `collection` (the keyring `keyring` names) with `password`. Fails, never retrying and
 * never prompting, when the password is wrong or the Secret Service is not GNOME Keyring.
 */
export function unlockWithPassword(keyring: string, collection: string, password: string): void {
  const socket = sessionBusSocket();
  if (!socket) {
    throw new ConfigError(
      `Keyring "${keyring}" is locked, and akm finds no session bus to unlock it over: DBUS_SESSION_BUS_ADDRESS and XDG_RUNTIME_DIR are unset.`,
      "BUNDLE_UNREACHABLE",
    );
  }
  // A standalone akm is Bun with `BUN_BE_BUN`; Bun and Node run the script `-e` gives them and ignore the variable.
  const result = spawnSync(process.execPath, ["-e", CLIENT], {
    encoding: "utf8",
    input: JSON.stringify({ socket, collection, password }),
    env: { ...process.env, BUN_BE_BUN: "1" },
    timeout: UNLOCK_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const answer = readAnswer(result.stdout);
  if (result.error || result.status !== 0 || answer === undefined) {
    throw new ConfigError(
      `akm could not unlock keyring "${keyring}": ${(result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ? `the Secret Service did not answer within ${UNLOCK_TIMEOUT_MS / 1000} s` : "its D-Bus client failed"}.`,
      "BUNDLE_UNREACHABLE",
    );
  }
  if (answer.error === DENIED) {
    throw new ConfigError(
      `Keyring "${keyring}" refused the bundle's credential: the password is wrong.`,
      "BUNDLE_UNREACHABLE",
      "Set the bundle's `credential` to a reference to the keyring's password.",
    );
  }
  if (answer.error !== undefined && NOT_GNOME.has(answer.error)) {
    throw new ConfigError(
      `Keyring "${keyring}" is locked, and unlocking it with the bundle's credential works only with GNOME Keyring: this Secret Service has no way to take a password.`,
      "BUNDLE_UNREACHABLE",
      "Remove the bundle's `credential` and unlock the keyring in your keyring manager, or let your login unlock it.",
    );
  }
  if (answer.error !== undefined || answer.message !== undefined) {
    throw new ConfigError(
      `akm could not unlock keyring "${keyring}": ${[answer.error, answer.message].filter(Boolean).join(": ")}`,
      "BUNDLE_UNREACHABLE",
    );
  }
}

function readAnswer(stdout: string): { error?: string; message?: string } | undefined {
  try {
    const answer: unknown = JSON.parse(stdout);
    return answer !== null && typeof answer === "object" ? (answer as { error?: string; message?: string }) : undefined;
  } catch {
    return undefined;
  }
}
