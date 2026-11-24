import {
  Reader,
  Uint8ArrayReader,
  ZipReader,
} from "@zip.js/zip.js/index-native.js";

export const PXZ_LIMIT = 128 * 1024 * 1024;
const MEMBER_LIMIT = 64 * 1024 * 1024;
const INFLATED_LIMIT = 192 * 1024 * 1024;

export class PxzRangeReader extends Reader {
  constructor(size, readRange) {
    super();
    this.size = size;
    this.readRange = readRange;
    this.transferred = 0;
  }
  async readUint8Array(offset, length) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > this.size ||
      !Number.isSafeInteger(length) ||
      length < 0
    )
      throw new Error("pxz-invalid");
    length = Math.min(length, this.size - offset);
    this.transferred += length;
    if (this.transferred > 8 * 1024 * 1024) throw new Error("pxz-too-large");
    if (!length) return new Uint8Array();
    const bytes = await this.readRange(offset, length);
    if (bytes.byteLength !== length) throw new Error("pxz-invalid");
    return new Uint8Array(bytes);
  }
}

export async function readPxz(source, inspect, signal) {
  const reader = new ZipReader(
    source instanceof Uint8Array ? new Uint8ArrayReader(source) : source,
    { useWebWorkers: false, signal },
  );
  try {
    const entries = new Map();
    let inflated = 0;
    let count = 0;
    for await (const entry of reader.getEntriesGenerator()) {
      signal?.throwIfAborted();
      if (++count > 1024) throw new Error("pxz-invalid");
      if (entry.directory) continue;
      if (entries.has(entry.filename)) throw new Error("pxz-invalid");
      entries.set(entry.filename, entry);
    }
    if (!entries.has("manifest.json")) throw new Error("pxz-invalid");
    return await inspect(async (name, limit = MEMBER_LIMIT) => {
      const entry = entries.get(name);
      if (!entry) return;
      const size = entry.uncompressedSize;
      if (
        entry.encrypted ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > limit ||
        inflated + size > INFLATED_LIMIT
      )
        throw new Error("pxz-too-large");
      const bytes = new Uint8Array(size);
      let written = 0;
      await entry.getData(
        new WritableStream({
          write(chunk) {
            if (chunk.byteLength > size - written)
              throw new Error("pxz-invalid");
            bytes.set(chunk, written);
            written += chunk.byteLength;
          },
        }),
        { checkSignature: true, signal },
      );
      if (written !== size) throw new Error("pxz-invalid");
      inflated += size;
      return bytes;
    });
  } finally {
    await reader.close();
  }
}
