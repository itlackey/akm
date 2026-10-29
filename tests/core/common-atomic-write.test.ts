// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic } from "../../src/core/common";

function makeFixture(): { dir: string; target: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-atomic-write-"));
  return { dir, target: path.join(dir, "target.txt") };
}

function tempFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.includes(".tmp."));
}

function errno(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

describe("writeFileAtomic", () => {
  let fixture: { dir: string; target: string } | undefined;

  function useFixture(): { dir: string; target: string } {
    fixture = makeFixture();
    return fixture;
  }

  afterEach(() => {
    if (fixture) fs.rmSync(fixture.dir, { recursive: true, force: true });
    fixture = undefined;
  });

  test("completes partial writes and preserves the requested mode", () => {
    const { target } = useFixture();
    const content = Buffer.from("content longer than one partial write");
    const originalWrite = fs.writeSync;
    let calls = 0;
    spyOn(fs, "writeSync").mockImplementation(((fd: number, buffer: Uint8Array, offset: number, length: number) => {
      calls += 1;
      return originalWrite(fd, buffer, offset, Math.max(1, Math.floor(length / 2)));
    }) as typeof fs.writeSync);

    const previousUmask = process.umask();
    try {
      if (process.platform !== "win32") process.umask(0o077);
      writeFileAtomic(target, content, 0o640);
    } finally {
      process.umask(previousUmask);
    }

    expect(calls).toBeGreaterThan(1);
    expect(fs.readFileSync(target)).toEqual(content);
    if (process.platform !== "win32") expect(fs.statSync(target).mode & 0o777).toBe(0o640);
  });

  test("propagates file sync errors, closes the descriptor, and removes the temp file", () => {
    const { dir, target } = useFixture();
    fs.writeFileSync(target, "original");
    const originalClose = fs.closeSync;
    let fileFd: number | undefined;
    let closedFileFd = false;
    spyOn(fs, "fdatasyncSync").mockImplementation((fd) => {
      fileFd = fd;
      throw new Error("injected file sync failure");
    });
    spyOn(fs, "closeSync").mockImplementation((fd) => {
      if (fd === fileFd) closedFileFd = true;
      return originalClose(fd);
    });

    expect(() => writeFileAtomic(target, "replacement")).toThrow("injected file sync failure");
    expect(closedFileFd).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("original");
    expect(tempFiles(dir)).toEqual([]);
  });

  test("removes the temp file after a write failure", () => {
    const { dir, target } = useFixture();
    spyOn(fs, "writeSync").mockImplementation(() => {
      throw new Error("injected write failure");
    });

    expect(() => writeFileAtomic(target, "secret-value", 0o600)).toThrow("injected write failure");
    expect(fs.existsSync(target)).toBe(false);
    expect(tempFiles(dir)).toEqual([]);
  });

  test("removes the temp file after a close failure", () => {
    const { dir, target } = useFixture();
    const originalClose = fs.closeSync;
    let failed = false;
    spyOn(fs, "closeSync").mockImplementation((fd) => {
      if (!failed && !fs.fstatSync(fd).isDirectory()) {
        failed = true;
        originalClose(fd);
        throw new Error("injected close failure");
      }
      return originalClose(fd);
    });

    expect(() => writeFileAtomic(target, "secret-value", 0o600)).toThrow("injected close failure");
    expect(fs.existsSync(target)).toBe(false);
    expect(tempFiles(dir)).toEqual([]);
  });

  test("removes the temp file after a rename failure", () => {
    const { dir, target } = useFixture();
    spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("injected rename failure");
    });

    expect(() => writeFileAtomic(target, "secret-value", 0o600)).toThrow("injected rename failure");
    expect(fs.existsSync(target)).toBe(false);
    expect(tempFiles(dir)).toEqual([]);
  });

  test("does not remove a colliding temp path it did not create", () => {
    const { target } = useFixture();
    const originalOpen = fs.openSync;
    const originalWrite = fs.writeSync;
    const originalClose = fs.closeSync;
    let collisionPath: string | undefined;
    spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags: string | number, mode?: number) => {
      if (!collisionPath && String(file).includes(".tmp.")) {
        collisionPath = String(file);
        const plantedFd = originalOpen(file, "wx", 0o600);
        originalWrite(plantedFd, Buffer.from("not-owned"));
        originalClose(plantedFd);
      }
      return originalOpen(file, flags, mode);
    }) as typeof fs.openSync);

    expect(() => writeFileAtomic(target, "replacement")).toThrow();
    expect(collisionPath).toBeDefined();
    if (!collisionPath) throw new Error("Expected a colliding temp path.");
    expect(fs.readFileSync(collisionPath, "utf8")).toBe("not-owned");
    expect(fs.existsSync(target)).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "propagates unexpected directory sync errors and closes the directory descriptor",
    () => {
      const { dir, target } = useFixture();
      const originalClose = fs.closeSync;
      let directoryFd: number | undefined;
      let closedDirectoryFd = false;
      spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        directoryFd = fd;
        throw errno("EIO", "injected directory sync failure");
      });
      spyOn(fs, "closeSync").mockImplementation((fd) => {
        if (fd === directoryFd) closedDirectoryFd = true;
        return originalClose(fd);
      });

      expect(() => writeFileAtomic(target, "replacement")).toThrow("injected directory sync failure");
      expect(closedDirectoryFd).toBe(true);
      expect(fs.readFileSync(target, "utf8")).toBe("replacement");
      expect(tempFiles(dir)).toEqual([]);
    },
  );

  test.skipIf(process.platform === "win32")("writes on a filesystem that refuses chmod (CIFS)", () => {
    const { dir, target } = useFixture();
    spyOn(fs, "fchmodSync").mockImplementation(() => {
      throw errno("EPERM", "operation not permitted");
    });

    expect(() => writeFileAtomic(target, "replacement", 0o644)).not.toThrow();
    expect(fs.readFileSync(target, "utf8")).toBe("replacement");
    expect(tempFiles(dir)).toEqual([]);
  });

  test.skipIf(process.platform === "win32")("propagates unexpected chmod errors and removes the temp file", () => {
    const { dir, target } = useFixture();
    spyOn(fs, "fchmodSync").mockImplementation(() => {
      throw errno("EIO", "injected chmod failure");
    });

    expect(() => writeFileAtomic(target, "replacement")).toThrow("injected chmod failure");
    expect(fs.existsSync(target)).toBe(false);
    expect(tempFiles(dir)).toEqual([]);
  });

  test.skipIf(process.platform === "win32")("ignores an explicitly unsupported directory sync error", () => {
    const { target } = useFixture();
    spyOn(fs, "fsyncSync").mockImplementation(() => {
      throw errno("EINVAL", "directory sync unsupported");
    });

    expect(() => writeFileAtomic(target, "replacement")).not.toThrow();
    expect(fs.readFileSync(target, "utf8")).toBe("replacement");
  });
});
