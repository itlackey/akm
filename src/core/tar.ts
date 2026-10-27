// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Named members of a gzip-compressed tar archive, streamed to files. This is all
 * akm needs of tar: a few regular files out of an npm package tarball (the
 * OpenCode binary, about 240 MB; onnxruntime-node's binding and library), so
 * nothing is held in memory and no tar library is a dependency.
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
 * Write each regular file of the `.tgz` at `archive` that `members` names (archive path → destination, mode 0755) and
 * return each one's size, in one pass that stops once the last is written. Entries are matched by the header's name
 * field alone, which holds up to 100 bytes; a longer name, which tar keeps in the ustar prefix field or a PAX `path`
 * record, is not read, so such a member is never found. The members akm reads (`package/bin/opencode`,
 * `package/bin/napi-v6/<platform>/<arch>/<file>`) are short. Extended headers are skipped like any other entry that is
 * not a member.
 */
export async function extractTarGzMembers(
  archive: string,
  members: ReadonlyMap<string, string>,
): Promise<Map<string, number>> {
  const gunzip = zlib.createGunzip();
  pipeline(fs.createReadStream(archive), gunzip, () => {});
  const reader = new ByteReader(gunzip);
  try {
    return await extractFrom(reader, archive, members);
  } finally {
    // The rest of the archive is not read: close it now rather than when the stream is collected.
    gunzip.destroy();
  }
}

async function extractFrom(
  reader: ByteReader,
  archive: string,
  members: ReadonlyMap<string, string>,
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  for (;;) {
    const header = await reader.exact(BLOCK_BYTES);
    if (header.every((byte) => byte === 0)) {
      const missing = [...members.keys()].filter((member) => !sizes.has(member));
      throw new Error(`${archive} has no ${missing.join(", ")}`);
    }
    const name = field(header, 0, 100).replace(/^\.\//, "");
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const size = Number.parseInt(field(header, 124, 136).trim() || "0", 8);
    if (!Number.isSafeInteger(size)) throw new Error(`${archive} is not a tar archive this reader understands`);
    const padding = (BLOCK_BYTES - (size % BLOCK_BYTES)) % BLOCK_BYTES;
    const destination = members.get(name);
    if (destination === undefined || sizes.has(name) || (typeflag !== "0" && typeflag !== "\0")) {
      await reader.skip(size + padding);
      continue;
    }
    const out = await fs.promises.open(destination, "w", 0o755);
    try {
      for (let left = size; left > 0; ) {
        const part = await reader.read(left);
        if (!part) throw new Error(`${archive} ends inside ${name}`);
        await out.writeFile(part);
        left -= part.length;
      }
    } finally {
      await out.close();
    }
    sizes.set(name, size);
    if (sizes.size === members.size) return sizes;
    await reader.skip(padding);
  }
}
