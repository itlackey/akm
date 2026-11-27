// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The D-Bus wire format, as far as the keyring-unlock tests need it: little-endian messages whose bodies hold the
 * basic types, byte arrays, variants of a string and the secret struct `(oayays)`. Written apart from akm's own
 * client (`src/core/adapter/adapters/gnome-keyring-unlock.ts`), so a test that uses it does not check the client
 * against itself. The fake Secret Service and the real-keyring test's setup both speak it.
 */

import net from "node:net";

export const METHOD_CALL = 1;
export const METHOD_RETURN = 2;
export const ERROR = 3;
export const SIGNAL = 4;

/** The header fields this format uses, by code. */
export const FIELD = { path: 1, interface: 2, member: 3, errorName: 4, replySerial: 5, destination: 6, signature: 8 };

export class Writer {
  private bytes: number[] = [];

  pad(align: number): this {
    while (this.bytes.length % align) this.bytes.push(0);
    return this;
  }
  byte(value: number): this {
    this.bytes.push(value);
    return this;
  }
  uint32(value: number): this {
    this.pad(4);
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(value);
    this.bytes.push(...buf);
    return this;
  }
  string(value: string): this {
    const buf = Buffer.from(value, "utf8");
    this.uint32(buf.length);
    this.bytes.push(...buf, 0);
    return this;
  }
  signature(value: string): this {
    this.bytes.push(value.length, ...Buffer.from(value, "ascii"), 0);
    return this;
  }
  byteArray(value: Uint8Array): this {
    this.uint32(value.length);
    this.bytes.push(...value);
    return this;
  }
  /** An array whose elements align to `align`: its length counts the elements, not the padding before them. */
  array(align: number, elements: (writer: this) => void): this {
    this.uint32(0);
    const lengthAt = this.bytes.length - 4;
    this.pad(align);
    const start = this.bytes.length;
    elements(this);
    const length = Buffer.alloc(4);
    length.writeUInt32LE(this.bytes.length - start);
    this.bytes.splice(lengthAt, 4, ...length);
    return this;
  }
  /** The secret struct `(oayays)`: session, parameters, value, content type. */
  secret(session: string, value: Uint8Array, contentType = "text/plain"): this {
    return this.pad(8).string(session).byteArray(new Uint8Array()).byteArray(value).string(contentType);
  }
  buffer(): Buffer {
    return Buffer.from(this.bytes);
  }
}

export class Reader {
  private at = 0;
  constructor(private readonly buf: Buffer) {}

  pad(align: number): this {
    this.at = Math.ceil(this.at / align) * align;
    return this;
  }
  byte(): number {
    return this.buf[this.at++] as number;
  }
  uint32(): number {
    this.pad(4);
    const value = this.buf.readUInt32LE(this.at);
    this.at += 4;
    return value;
  }
  string(): string {
    const length = this.uint32();
    const value = this.buf.toString("utf8", this.at, this.at + length);
    this.at += length + 1;
    return value;
  }
  signature(): string {
    const length = this.byte();
    const value = this.buf.toString("ascii", this.at, this.at + length);
    this.at += length + 1;
    return value;
  }
  byteArray(): Buffer {
    const length = this.uint32();
    const value = this.buf.subarray(this.at, this.at + length);
    this.at += length;
    return value;
  }
  /** A variant of one of the basic types the header uses. */
  variant(): string | number {
    const type = this.signature();
    if (type === "s" || type === "o") return this.string();
    if (type === "g") return this.signature();
    if (type === "u") return this.uint32();
    throw new Error(`variant of type ${type} is not supported`);
  }
  get offset(): number {
    return this.at;
  }
}

export interface Message {
  type: number;
  serial: number;
  fields: Record<number, string | number>;
  /** The body, read from its start. */
  body: Reader;
}

/** One message: the header with its fields, then `body`, whose signature is `signature`. */
export function encode(
  type: number,
  serial: number,
  fields: Array<[code: number, type: string, value: string | number]>,
  signature = "",
  body: Buffer = Buffer.alloc(0),
): Buffer {
  const all: typeof fields = signature ? [...fields, [FIELD.signature, "g", signature]] : fields;
  const header = new Writer()
    .byte(0x6c)
    .byte(type)
    .byte(0)
    .byte(1)
    .uint32(body.length)
    .uint32(serial)
    .array(8, (w) => {
      for (const [code, fieldType, value] of all) {
        w.pad(8).byte(code).signature(fieldType);
        if (fieldType === "u") w.uint32(value as number);
        else if (fieldType === "g") w.signature(value as string);
        else w.string(value as string);
      }
    })
    .pad(8)
    .buffer();
  return Buffer.concat([header, body]);
}

/** The first whole message of `buf` and its length, or undefined while it is incomplete. */
export function decode(buf: Buffer): { message: Message; length: number } | undefined {
  if (buf.length < 16) return undefined;
  const bodyLength = buf.readUInt32LE(4);
  const fieldsLength = buf.readUInt32LE(12);
  const length = Math.ceil((16 + fieldsLength) / 8) * 8 + bodyLength;
  if (buf.length < length) return undefined;
  const header = new Reader(buf.subarray(0, length));
  header.byte();
  const type = header.byte();
  header.byte();
  header.byte();
  header.uint32();
  const serial = header.uint32();
  const end = header.uint32() + 16;
  const fields: Record<number, string | number> = {};
  header.pad(8);
  while (header.offset < end) {
    header.pad(8);
    const code = header.byte();
    fields[code] = header.variant();
  }
  header.pad(8);
  return { message: { type, serial, fields, body: new Reader(buf.subarray(header.offset, length)) }, length };
}

/** A client connection to a bus at `socket`, authenticated and introduced (`Hello`). */
export async function connect(socket: string): Promise<BusClient> {
  const client = new BusClient(net.connect(socket));
  await client.start();
  return client;
}

export class BusClient {
  private pending = Buffer.alloc(0);
  private waiting: (() => void) | undefined;
  private serial = 0;

  constructor(private readonly sock: net.Socket) {
    sock.on("data", (data) => {
      this.pending = Buffer.concat([this.pending, data]);
      this.waiting?.();
    });
  }

  private more(): Promise<void> {
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  async start(): Promise<void> {
    this.sock.write(`\0AUTH EXTERNAL ${Buffer.from(String(process.getuid?.() ?? 0)).toString("hex")}\r\n`);
    while (!this.pending.includes("\r\n")) await this.more();
    const line = this.pending.toString("utf8", 0, this.pending.indexOf("\r\n"));
    if (!line.startsWith("OK ")) throw new Error(`bus refused: ${line}`);
    this.pending = this.pending.subarray(this.pending.indexOf("\r\n") + 2);
    this.sock.write("BEGIN\r\n");
    await this.call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "Hello");
  }

  /** Call a method and return its reply; an error reply throws its name and message. */
  async call(
    destination: string,
    path: string,
    iface: string,
    member: string,
    signature = "",
    body: Buffer = Buffer.alloc(0),
  ): Promise<Message> {
    const serial = ++this.serial;
    this.sock.write(
      encode(
        METHOD_CALL,
        serial,
        [
          [FIELD.path, "o", path],
          [FIELD.interface, "s", iface],
          [FIELD.member, "s", member],
          [FIELD.destination, "s", destination],
        ],
        signature,
        body,
      ),
    );
    for (;;) {
      let next = decode(this.pending);
      while (!next) {
        await this.more();
        next = decode(this.pending);
      }
      this.pending = this.pending.subarray(next.length);
      const { message } = next;
      if (message.fields[FIELD.replySerial] !== serial) continue;
      if (message.type === ERROR) {
        throw new Error(
          `${message.fields[FIELD.errorName]}: ${message.fields[FIELD.signature] ? message.body.string() : ""}`,
        );
      }
      return message;
    }
  }

  close(): void {
    this.sock.end();
  }
}
