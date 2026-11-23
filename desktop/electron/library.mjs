import { randomUUID } from "node:crypto";
import { readFile, stat, readdir } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import {
  S3Client,
  HeadBucketCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import mime from "mime";
import { D1 } from "./d1.mjs";
import { libraryId } from "./config.mjs";

const schema = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
export function cleanName(value) {
  const name = String(value ?? "").trim();
  if (
    !name ||
    name.length > 255 ||
    /[/\\\x00-\x1f]/.test(name) ||
    name === "." ||
    name === ".."
  )
    throw new Error(
      "Имя должно содержать от 1 до 255 символов без слешей и управляющих символов.",
    );
  return name;
}
export function normalizeAdjustments(input) {
  return Object.fromEntries(
    Object.entries({
      brightness: [0, 200, 100],
      contrast: [0, 200, 100],
      saturation: [0, 200, 100],
      rotate: [-180, 180, 0],
    }).map(([key, [min, max, fallback]]) => {
      const value = Number(input?.[key] ?? fallback);
      if (!Number.isFinite(value) || value < min || value > max)
        throw new Error("Некорректные параметры изображения.");
      return [key, value];
    }),
  );
}
export function fileRow(row) {
  return {
    ...row,
    favorite: Boolean(row.favorite),
    tags: JSON.parse(row.tags),
    adjustments: JSON.parse(row.adjustments),
  };
}
export class Library {
  constructor(config, { db, s3, createUpload } = {}) {
    this.createUpload = createUpload ?? ((options) => new Upload(options));
    this.config = config;
    this.id = libraryId(config);
    this.db = db ?? new D1(config);
    this.s3 =
      s3 ??
      new S3Client({
        region: "auto",
        endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
      });
  }
  async check() {
    await Promise.all([
      this.db.query("SELECT 1 AS ok"),
      this.s3.send(new HeadBucketCommand({ Bucket: this.config.bucket })),
    ]);
    return { ok: true };
  }
  async initialize() {
    await this.db.query(schema);
    return { ok: true };
  }
  async folders() {
    return this.db.query(
      "SELECT * FROM jr_folders WHERE library_id = ? ORDER BY name COLLATE NOCASE",
      [this.id],
    );
  }
  async folder(id) {
    if (!id) return null;
    const [row] = await this.db.query(
      "SELECT * FROM jr_folders WHERE id = ? AND library_id = ?",
      [id, this.id],
    );
    if (!row) throw new Error("Папка не найдена в этом хранилище.");
    return row;
  }
  async createFolder(name, parentId = null) {
    name = cleanName(name);
    await this.folder(parentId);
    const id = randomUUID();
    await this.db.query(
      "INSERT INTO jr_folders (id, library_id, parent_id, name, created_at) VALUES (?, ?, ?, ?, ?)",
      [id, this.id, parentId || null, name, new Date().toISOString()],
    );
    return { id, name, parent_id: parentId };
  }
  async updateFolder(id, input) {
    await this.folder(id);
    const sets = [],
      params = [];
    if ("name" in input) {
      sets.push("name = ?");
      params.push(cleanName(input.name));
    }
    if ("parentId" in input) {
      await this.folder(input.parentId);
      const folders = await this.folders(),
        byId = new Map(folders.map((f) => [f.id, f]));
      let ancestor = input.parentId;
      const seen = new Set();
      while (ancestor) {
        if (ancestor === id || seen.has(ancestor))
          throw new Error("Нельзя переместить папку внутрь самой себя.");
        seen.add(ancestor);
        ancestor = byId.get(ancestor)?.parent_id;
      }
      sets.push("parent_id = ?");
      params.push(input.parentId || null);
    }
    if (sets.length)
      await this.db.query(
        `UPDATE jr_folders SET ${sets.join(", ")} WHERE id = ? AND library_id = ?`,
        [...params, id, this.id],
      );
  }
  async deleteFolder(id) {
    await this.folder(id);
    const [counts] = await this.db.query(
      "SELECT (SELECT COUNT(*) FROM jr_folders WHERE parent_id = ? AND library_id = ?) + (SELECT COUNT(*) FROM jr_files WHERE folder_id = ? AND library_id = ?) AS total",
      [id, this.id, id, this.id],
    );
    if (counts.total)
      throw new Error(
        "Удалить можно только пустую папку. Переместите файлы, включая файлы в корзине, и вложенные папки.",
      );
    await this.db.query(
      "DELETE FROM jr_folders WHERE id = ? AND library_id = ?",
      [id, this.id],
    );
  }
  async list(input = {}) {
    const section = ["drive", "all", "favorites", "photos", "trash"].includes(
      input.section,
    )
      ? input.section
      : "drive";
    const where = [
        "library_id = ?",
        section === "trash" ? "trashed_at IS NOT NULL" : "trashed_at IS NULL",
      ],
      params = [this.id];
    if (section === "drive") {
      where.push("folder_id IS ?");
      params.push(input.folderId || null);
    }
    if (section === "favorites") where.push("favorite = 1");
    if (section === "photos")
      where.push("(mime_type LIKE 'image/%' OR mime_type LIKE 'video/%')");
    if (input.search) {
      where.push(
        "(name LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM json_each(jr_files.tags) WHERE value LIKE ? ESCAPE '\\'))",
      );
      const term = `%${String(input.search).replace(/[\\%_]/g, "\\$&")}%`;
      params.push(term, term);
    }
    if (input.tag) {
      where.push(
        "EXISTS (SELECT 1 FROM json_each(jr_files.tags) WHERE value = ?)",
      );
      params.push(String(input.tag));
    }
    const clause = where.join(" AND ");
    const [count] = await this.db.query(
      `SELECT COUNT(*) AS total FROM jr_files WHERE ${clause}`,
      params,
    );
    const page = Math.max(1, Math.floor(Number(input.page) || 1)),
      limit = 80;
    const sort =
      {
        name: "name COLLATE NOCASE ASC",
        date: "created_at DESC",
        size: "size_bytes DESC",
      }[input.sort] || "created_at DESC";
    const rows = await this.db.query(
      `SELECT * FROM jr_files WHERE ${clause} ORDER BY ${sort}, id LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit],
    );
    return {
      items: rows.map(fileRow),
      total: count.total,
      page,
      hasMore: page * limit < count.total,
    };
  }
  async stats() {
    const [stats] = await this.db.query(
      "SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes, COALESCE(SUM(trashed_at IS NOT NULL), 0) AS trashed FROM jr_files WHERE library_id = ?",
      [this.id],
    );
    const tags = await this.db.query(
      "SELECT DISTINCT value AS name FROM jr_files, json_each(jr_files.tags) WHERE library_id = ? AND trashed_at IS NULL ORDER BY value COLLATE NOCASE",
      [this.id],
    );
    return { ...stats, tags: tags.map((t) => t.name) };
  }
  async file(id) {
    const [row] = await this.db.query(
      "SELECT * FROM jr_files WHERE id = ? AND library_id = ?",
      [id, this.id],
    );
    if (!row) throw new Error("Файл не найден в этом хранилище.");
    return fileRow(row);
  }
  async updateFiles(ids, patch) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000)
      throw new Error("Выберите от 1 до 1000 файлов.");
    const sets = ["updated_at = ?"],
      params = [new Date().toISOString()];
    if ("name" in patch) {
      if (ids.length !== 1)
        throw new Error("Переименовывать можно по одному файлу.");
      sets.push("name = ?");
      params.push(cleanName(patch.name));
    }
    if ("favorite" in patch) {
      sets.push("favorite = ?");
      params.push(patch.favorite ? 1 : 0);
    }
    if ("trashed" in patch) {
      sets.push("trashed_at = ?");
      params.push(patch.trashed ? new Date().toISOString() : null);
    }
    if ("folderId" in patch) {
      await this.folder(patch.folderId);
      sets.push("folder_id = ?");
      params.push(patch.folderId || null);
    }
    if ("tags" in patch) {
      if (!Array.isArray(patch.tags) || patch.tags.length > 50)
        throw new Error("Не более 50 тегов.");
      const tags = [...new Set(patch.tags.map((t) => cleanName(t)))];
      sets.push("tags = ?");
      params.push(JSON.stringify(tags));
    }
    if ("adjustments" in patch) {
      sets.push("adjustments = ?");
      params.push(JSON.stringify(normalizeAdjustments(patch.adjustments)));
    }
    // Small batches stay below D1's bound parameter limit.
    for (let offset = 0; offset < ids.length; offset += 50) {
      const part = ids.slice(offset, offset + 50);
      await this.db.query(
        `UPDATE jr_files SET ${sets.join(", ")} WHERE library_id = ? AND id IN (${part.map(() => "?").join(",")})`,
        [...params, this.id, ...part],
      );
    }
  }
  async url(id, download = false) {
    const file = await this.file(id);
    // URLs are generated locally. Cloudflare API tokens and the R2 secret never reach the UI.
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: file.object_key,
        ...(download
          ? {
              ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
            }
          : {}),
      }),
      { expiresIn: 3600 },
    );
  }
  async download(id, destination) {
    const file = await this.file(id);
    const result = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: file.object_key,
      }),
    );
    const temporary = `${destination}.${randomUUID()}.part`;
    try {
      await pipeline(
        result.Body,
        createWriteStream(temporary, { flags: "wx" }),
      );
      const { rename } = await import("node:fs/promises");
      await rename(temporary, destination);
    } catch (error) {
      const { rm } = await import("node:fs/promises");
      await rm(temporary, { force: true });
      throw error;
    }
  }
  async deletePermanently(ids) {
    if (!Array.isArray(ids) || ids.length > 1000)
      throw new Error("Слишком много файлов.");
    let done = 0;
    for (const id of ids) {
      const file = await this.file(id);
      if (!file.trashed_at)
        throw new Error("Сначала переместите файл в корзину.");
      // Delete object first; keep the record on R2 failure so deletion is retryable.
      await this.s3.send(
        new DeleteObjectCommand({
          Bucket: this.config.bucket,
          Key: file.object_key,
        }),
      );
      await this.db.query(
        "DELETE FROM jr_files WHERE id = ? AND library_id = ?",
        [id, this.id],
      );
      done++;
    }
    return { done };
  }
  async uploadFile(source, folderId, report = () => {}) {
    await this.folder(folderId);
    const info = await stat(source);
    if (!info.isFile()) throw new Error("Ожидался обычный файл.");
    const name = cleanName(path.basename(source)),
      id = randomUUID();
    const key = [this.config.prefix, "objects", id, name]
      .filter(Boolean)
      .join("/");
    const mimeType = mime.getType(name) || "application/octet-stream";
    const upload = this.createUpload({
      client: this.s3,
      params: {
        Bucket: this.config.bucket,
        Key: key,
        Body: createReadStream(source),
        ContentType: mimeType,
        ContentLength: info.size,
      },
      queueSize: 2,
      partSize: 8 * 1024 * 1024,
      leavePartsOnError: false,
    });
    upload.on("httpUploadProgress", (p) =>
      report({ loaded: p.loaded ?? 0, total: info.size }),
    );
    await upload.done();
    const now = new Date().toISOString();
    try {
      await this.db.query(
        "INSERT INTO jr_files (id, library_id, folder_id, object_key, name, mime_type, size_bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          id,
          this.id,
          folderId || null,
          key,
          name,
          mimeType,
          info.size,
          now,
          now,
        ],
      );
    } catch (error) {
      // A timeout may mean D1 committed the INSERT. Check before removing the object.
      let exists;
      try {
        exists =
          (
            await this.db.query(
              "SELECT id FROM jr_files WHERE id = ? AND library_id = ?",
              [id, this.id],
            )
          ).length > 0;
      } catch {
        throw new Error(
          `Не удалось подтвердить запись D1 для ${name}. Объект сохранён в R2; проверьте подключение. Ключ: ${key}`,
        );
      }
      if (!exists) {
        await this.s3.send(
          new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
        );
        throw error;
      }
    }
    return { id, name };
  }
  async uploadPaths(paths, folderId, report = () => {}) {
    if (!Array.isArray(paths) || paths.length > 10000)
      throw new Error("Некорректный список файлов.");
    await this.folder(folderId);
    const jobs = [],
      failures = [];
    const ensureFolder = async (name, parent) => {
      const [existing] = await this.db.query(
        "SELECT id FROM jr_folders WHERE library_id = ? AND parent_id IS ? AND name = ?",
        [this.id, parent || null, name],
      );
      return existing?.id || (await this.createFolder(name, parent)).id;
    };
    const walk = async (source, parent) => {
      const info = await stat(source);
      if (info.isDirectory()) {
        const folder = await ensureFolder(
          cleanName(path.basename(source)),
          parent,
        );
        for (const entry of await readdir(source, { withFileTypes: true })) {
          if (!entry.isSymbolicLink())
            await walk(path.join(source, entry.name), folder);
        }
      } else if (info.isFile())
        jobs.push({ source, folder: parent, size: info.size });
    };
    for (const source of paths) await walk(String(source), folderId || null);
    let done = 0,
      bytes = 0,
      totalBytes = jobs.reduce((sum, j) => sum + j.size, 0);
    for (const job of jobs) {
      const name = path.basename(job.source);
      try {
        await this.uploadFile(job.source, job.folder, (p) =>
          report({
            name,
            done,
            total: jobs.length,
            loaded: bytes + p.loaded,
            totalBytes,
            failures: failures.length,
          }),
        );
      } catch (error) {
        failures.push({ name, message: error.message });
      }
      bytes += job.size;
      done++;
      report({
        name,
        done,
        total: jobs.length,
        loaded: bytes,
        totalBytes,
        failures: failures.length,
      });
    }
    return { done: done - failures.length, failures };
  }
  async importBucket(report = () => {}) {
    let token,
      done = 0;
    do {
      const page = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: this.config.prefix ? `${this.config.prefix}/` : "",
          ContinuationToken: token,
          MaxKeys: 100,
        }),
      );
      for (const object of page.Contents ?? []) {
        if (!object.Key || object.Key.endsWith("/")) continue;
        const name = path.posix.basename(object.Key);
        const timestamp =
          object.LastModified?.toISOString() || new Date().toISOString();
        await this.db.query(
          "INSERT OR IGNORE INTO jr_files (id, library_id, object_key, name, mime_type, size_bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [
            randomUUID(),
            this.id,
            object.Key,
            name,
            mime.getType(name) || "application/octet-stream",
            object.Size || 0,
            timestamp,
            timestamp,
          ],
        );
        done++;
        report({ done });
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return { scanned: done };
  }
  close() {
    this.s3.destroy();
  }
}
