// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * One member of a gzip-compressed tar archive, streamed to a file. This is all
 * akm needs of tar: the OpenCode binary is a single regular file of about 240 MB
 * inside its package tarball, so it is never held in memory and no tar library
 * is a dependency.
 */

import fs from "node:fs";
import { pipeline } from "node:stream";
import zlib from "node:zlib";

const BLOCK_BYTES = 512;

/** Exact reads from a stream of chunks. */
class ByteReader {
  readonly #chunks: AsyncIterator<Buffer>;
  #pending: Buffer = Buffer.alloc(0);

  constructor(source: AsyncIterable<Buffer>) {
    this.#chunks = source[Symbol.asyncIterator]();
  }

  /** Up to `max` bytes, at least one unless the stream has ended (`undefined`). */
  async read(max: number): Promise<Buffer | undefined> {
    if (this.#pending.length === 0) {
      const next = await this.#chunks.next();
      if (next.done) return undefined;
      this.#pending = next.value;
    }
    const taken = this.#pending.subarray(0, max);
    this.#pending = this.#pending.subarray(taken.length);
    return taken;
  }

  async exact(count: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    for (let left = count; left > 0; ) {
      const part = await this.read(left);
      if (!part) throw new Error("the archive ends inside an entry");
      parts.push(part);
      left -= part.length;
    }
    return Buffer.concat(parts);
  }

  async skip(count: number): Promise<void> {
    for (let left = count; left > 0; ) {
      const part = await this.read(left);
      if (!part) throw new Error("the archive ends inside an entry");
      left -= part.length;
    }
  }
}

/** A header field of NUL-terminated text. */
const field = (header: Buffer, start: number, end: number): string => {
  const bytes = header.subarray(start, end);
  const stop = bytes.indexOf(0);
  return bytes.subarray(0, stop < 0 ? bytes.length : stop).toString("utf8");
};

/**
 * Write the regular file `member` of the `.tgz` at `archive` to `destination` (mode 0755) and return its size. Entries
 * are matched by the header's name field alone, which holds up to 100 bytes; a longer name, which tar keeps in the
 * ustar prefix field or a PAX `path` record, is not read, so such a member is never found. The one member akm reads,
 * `package/bin/opencode`, is short. Extended headers are skipped like any other entry that is not the member.
 */
export async function extractTarGzMember(archive: string, member: string, destination: string): Promise<number> {
  const gunzip = zlib.createGunzip();
  pipeline(fs.createReadStream(archive), gunzip, () => {});
  const reader = new ByteReader(gunzip);
  try {
    return await extractFrom(reader, archive, member, destination);
  } finally {
    // The rest of the archive is not read: close it now rather than when the stream is collected.
    gunzip.destroy();
  }
}

async function extractFrom(reader: ByteReader, archive: string, member: string, destination: string): Promise<number> {
  for (;;) {
    const header = await reader.exact(BLOCK_BYTES);
    if (header.every((byte) => byte === 0)) throw new Error(`${archive} has no ${member}`);
    const name = field(header, 0, 100).replace(/^\.\//, "");
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const size = Number.parseInt(field(header, 124, 136).trim() || "0", 8);
    if (!Number.isSafeInteger(size)) throw new Error(`${archive} is not a tar archive this reader understands`);
    const padding = (BLOCK_BYTES - (size % BLOCK_BYTES)) % BLOCK_BYTES;
    if (name !== member || (typeflag !== "0" && typeflag !== "\0")) {
      await reader.skip(size + padding);
      continue;
    }
    const out = await fs.promises.open(destination, "w", 0o755);
    try {
      for (let left = size; left > 0; ) {
        const part = await reader.read(left);
        if (!part) throw new Error(`${archive} ends inside ${member}`);
        await out.writeFile(part);
        left -= part.length;
      }
    } finally {
      await out.close();
    }
    return size;
  }
}
