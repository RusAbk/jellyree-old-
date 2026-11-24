import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  rename,
  unlink,
  stat,
  utimes,
} from "node:fs/promises";
import path from "node:path";
import { normalizeImageAdjustments } from "./image-adjustments.mjs";
import { isHeicFile } from "./image-formats.mjs";
export const THUMBNAIL_LIMIT = 256 * 1024 * 1024;
const ENTRY_LIMIT = 2 * 1024 * 1024;
const filenamePattern = /^[a-f0-9]{64}\.thumb$/;
export function thumbnailKey(namespace, revision) {
  if (
    typeof namespace !== "string" ||
    !namespace ||
    !revision ||
    typeof revision.id !== "string" ||
    !revision.id ||
    typeof revision.objectKey !== "string" ||
    revision.objectKey.length > 4096 ||
    !Number.isFinite(revision.sizeBytes) ||
    revision.sizeBytes < 0 ||
    !/^(image|video)\//.test(revision.mimeType)
  )
    throw new TypeError("Invalid thumbnail revision");
  return createHash("sha256")
    .update(
      JSON.stringify({
        // HEIC previews now bake in orientation and edits in the decoder worker.
        version: isHeicFile({ name: "", mime_type: revision.mimeType }) ? 2 : 1,
        namespace,
        id: revision.id,
        objectKey: revision.objectKey,
        sizeBytes: revision.sizeBytes,
        mimeType: revision.mimeType,
        adjustments: revision.mimeType.startsWith("image/")
          ? normalizeImageAdjustments(revision.adjustments)
          : {},
      }),
    )
    .digest("hex");
}
function validEntry(entry) {
  return (
    entry &&
    Number.isInteger(entry.width) &&
    entry.width > 0 &&
    entry.width <= 100000 &&
    Number.isInteger(entry.height) &&
    entry.height > 0 &&
    entry.height <= 100000 &&
    Number.isFinite(entry.duration) &&
    entry.duration >= 0 &&
    entry.duration < 1e9 &&
    entry.data instanceof Uint8Array &&
    entry.data.length > 12 &&
    entry.data.length <= ENTRY_LIMIT &&
    Buffer.from(entry.data.subarray(0, 4)).toString() === "RIFF" &&
    Buffer.from(entry.data.subarray(8, 12)).toString() === "WEBP"
  );
}
export class ThumbnailCache {
  constructor(directory, { maxBytes = THUMBNAIL_LIMIT, now = Date.now } = {}) {
    this.directory = directory;
    this.maxBytes = maxBytes;
    this.now = now;
    this.entries = new Map();
    this.bytes = 0;
    this.epoch = 0;
    this.ready = false;
    this.tail = Promise.resolve();
  }
  run(fn) {
    const result = this.tail.then(async () => {
      await this.initialize();
      return fn();
    });
    this.tail = result.catch(() => {});
    return result;
  }
  async initialize() {
    if (this.ready) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const files = await readdir(this.directory, { withFileTypes: true });
    for (let offset = 0; offset < files.length; offset += 32) {
      await Promise.all(
        files.slice(offset, offset + 32).map(async (file) => {
          if (!file.isFile() || !filenamePattern.test(file.name)) return;
          const info = await stat(path.join(this.directory, file.name)).catch(
            () => null,
          );
          if (!info) return;
          if (info.size > ENTRY_LIMIT + 1024) {
            await unlink(path.join(this.directory, file.name)).catch(() => {});
            return;
          }
          this.entries.set(file.name, {
            size: info.size,
            touched: info.mtimeMs,
            persisted: info.mtimeMs,
          });
          this.bytes += info.size;
        }),
      );
    }
    this.ready = true;
    await this.prune();
  }
  async prune() {
    if (this.bytes <= this.maxBytes) return;
    for (const [name] of [...this.entries].sort(
      (a, b) => a[1].touched - b[1].touched,
    )) {
      await this.remove(name);
      if (this.bytes <= this.maxBytes) break;
    }
  }
  async remove(name) {
    const entry = this.entries.get(name);
    await unlink(path.join(this.directory, name)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    this.entries.delete(name);
    if (entry) this.bytes -= entry.size;
  }
  get(key) {
    return this.run(async () => {
      const name = this.name(key),
        info = this.entries.get(name);
      if (!info) return { epoch: this.epoch, entry: null };
      try {
        const file = await readFile(path.join(this.directory, name)),
          separator = file.indexOf(10);
        if (separator < 0 || separator > 1024)
          throw new Error("Invalid thumbnail");
        const metadata = JSON.parse(file.subarray(0, separator).toString()),
          entry = {
            ...metadata,
            data: new Uint8Array(file.subarray(separator + 1)),
          };
        if (!validEntry(entry)) throw new Error("Invalid thumbnail");
        info.touched = this.now();
        if (info.touched - info.persisted > 60000) {
          info.persisted = info.touched;
          const date = new Date(info.touched);
          await utimes(path.join(this.directory, name), date, date).catch(
            () => {},
          );
        }
        return { epoch: this.epoch, entry };
      } catch {
        await this.remove(name);
        return { epoch: this.epoch, entry: null };
      }
    });
  }
  put(key, entry, epoch) {
    return this.run(async () => {
      const name = this.name(key);
      if (epoch !== this.epoch) return false;
      if (!validEntry(entry)) throw new TypeError("Invalid thumbnail entry");
      const header = Buffer.from(
        JSON.stringify({
          width: entry.width,
          height: entry.height,
          duration: entry.duration,
        }) + "\n",
      );
      const file = Buffer.concat([header, entry.data]);
      if (file.length > this.maxBytes) return false;
      const temporary = path.join(this.directory, `${key}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, file, { mode: 0o600, flag: "wx" });
        await rename(temporary, path.join(this.directory, name));
      } finally {
        await unlink(temporary).catch(() => {});
      }
      this.bytes += file.length - (this.entries.get(name)?.size || 0);
      this.entries.set(name, {
        size: file.length,
        touched: this.now(),
        persisted: this.now(),
      });
      await this.prune();
      return true;
    });
  }
  stats() {
    return this.run(() => ({
      count: this.entries.size,
      bytes: this.bytes,
      maxBytes: this.maxBytes,
    }));
  }
  clear() {
    return this.run(async () => {
      this.epoch++;
      for (const name of [...this.entries.keys()]) await this.remove(name);
      return { count: 0, bytes: 0, maxBytes: this.maxBytes };
    });
  }
  name(key) {
    if (!/^[a-f0-9]{64}$/.test(key))
      throw new TypeError("Invalid thumbnail key");
    return `${key}.thumb`;
  }
}
