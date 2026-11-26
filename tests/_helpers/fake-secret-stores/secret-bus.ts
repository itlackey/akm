// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A stand-in for the session bus and GNOME Keyring's Secret Service, as far as a password unlock goes: it listens on
 * the socket its first argument names, authenticates any client, and answers `Hello`, `OpenSession` ("plain") and
 * `UnlockWithMasterPassword` over the fake stores' state. A session belongs to the connection that opened it, as
 * gnome-keyring's does. It records each unlock in the state's `calls`, never the password.
 */

import fs from "node:fs";
import net from "node:net";
import { decode, ERROR, encode, FIELD, METHOD_CALL, METHOD_RETURN, SIGNAL, Writer } from "../dbus-wire";
import { loadState, saveState } from "./state";

const COLLECTION_PREFIX = "/org/freedesktop/secrets/collection/";
const GNOME = "org.gnome.keyring.InternalUnsupportedGuiltRiddenInterface";
const socketPath = process.argv[2] as string;

let connections = 0;
let serials = 0;

const server = net.createServer((sock) => {
  const name = `:1.${++connections}`;
  const sessions = new Set<string>();
  let pending = Buffer.alloc(0);
  let authenticated = false;

  const send = (message: Uint8Array) => sock.write(message);
  const reply = (to: number, signature = "", body: Buffer = Buffer.alloc(0)) =>
    send(encode(METHOD_RETURN, ++serials, [[FIELD.replySerial, "u", to]], signature, body));
  const error = (to: number, errorName: string, text: string) =>
    send(
      encode(
        ERROR,
        ++serials,
        [
          [FIELD.replySerial, "u", to],
          [FIELD.errorName, "s", errorName],
        ],
        "s",
        new Writer().string(text).buffer(),
      ),
    );

  sock.on("data", (data) => {
    pending = Buffer.concat([pending, data]);
    while (!authenticated && pending.includes("\r\n")) {
      const line = pending.toString("utf8", 0, pending.indexOf("\r\n")).replace(/^\0/, "");
      pending = pending.subarray(pending.indexOf("\r\n") + 2);
      if (line.startsWith("AUTH EXTERNAL")) sock.write("OK 00000000000000000000000000000000\r\n");
      else if (line === "BEGIN") authenticated = true;
      else sock.write("ERROR\r\n");
    }
    if (!authenticated) return;
    for (let next = decode(pending); next; next = decode(pending)) {
      pending = pending.subarray(next.length);
      const { message } = next;
      if (message.type !== METHOD_CALL) continue;
      const member = `${message.fields[FIELD.interface]}.${message.fields[FIELD.member]}`;
      if (member === "org.freedesktop.DBus.Hello") {
        reply(message.serial, "s", new Writer().string(name).buffer());
        // The bus then tells the client its name, as dbus-daemon does: a signal the client must pass over.
        send(
          encode(
            SIGNAL,
            ++serials,
            [
              [FIELD.path, "o", "/org/freedesktop/DBus"],
              [FIELD.interface, "s", "org.freedesktop.DBus"],
              [FIELD.member, "s", "NameAcquired"],
              [FIELD.destination, "s", name],
            ],
            "s",
            new Writer().string(name).buffer(),
          ),
        );
      } else if (member === "org.freedesktop.Secret.Service.OpenSession") {
        const algorithm = message.body.string();
        if (algorithm !== "plain") {
          error(message.serial, "org.freedesktop.DBus.Error.NotSupported", "Algorithm is not supported");
          continue;
        }
        const session = `/org/freedesktop/secrets/session/${name.slice(1).replace(".", "_")}_${sessions.size + 1}`;
        sessions.add(session);
        reply(message.serial, "vo", new Writer().signature("s").string("").string(session).buffer());
      } else if (member === `${GNOME}.UnlockWithMasterPassword`) {
        const state = loadState();
        if (state.noPasswordUnlock) {
          error(message.serial, "org.freedesktop.DBus.Error.UnknownMethod", `No such interface “${GNOME}”`);
          continue;
        }
        const collection = message.body.string();
        message.body.pad(8);
        const session = message.body.string();
        message.body.byteArray();
        const password = message.body.byteArray().toString("utf8");
        const keyring = collection.slice(COLLECTION_PREFIX.length);
        state.calls.push(["secret-bus", "UnlockWithMasterPassword", collection]);
        if (!sessions.has(session)) {
          saveState(state);
          error(message.serial, "org.freedesktop.Secret.Error.NoSession", "The session does not exist");
        } else if (state.passwords?.[keyring] !== password) {
          saveState(state);
          error(message.serial, "org.gnome.keyring.Error.Denied", "The password was invalid");
        } else {
          state.locked = (state.locked ?? []).filter((locked) => locked !== keyring);
          saveState(state);
          reply(message.serial);
        }
      } else {
        error(message.serial, "org.freedesktop.DBus.Error.UnknownMethod", `Unknown method ${member}`);
      }
    }
  });
});

fs.rmSync(socketPath, { force: true });
server.listen(socketPath, () => process.stdout.write("ready\n"));
