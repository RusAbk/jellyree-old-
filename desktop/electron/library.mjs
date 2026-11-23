import { t } from "./locales.mjs";
import { randomUUID } from "node:crypto";
import {
  readFile,
  stat,
  readdir,
  mkdtemp,
  writeFile,
  rm,
} from "node:fs/promises";
import os from "node:os";
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
import { normalizeImageAdjustments } from "./image-adjustments.mjs";
import { validateVideoFrame, videoFrameName } from "./video-frames.mjs";
import { documentKind, documentLimits } from "./document-preview.mjs";

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
      t(
        "Имя должно содержать от 1 до 255 символов без слешей и управляющих символов.",
      ),
    );
  return name;
}
export function normalizeAdjustments(input) {
  try {
    return normalizeImageAdjustments(input);
  } catch {
    throw new Error(t("Некорректные параметры изображения."));
  }
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
    if (!row) throw new Error(t("Папка не найдена в этом хранилище."));
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
          throw new Error(t("Нельзя переместить папку внутрь самой себя."));
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
        t(
          "Удалить можно только пустую папку. Переместите файлы, включая файлы в корзине, и вложенные папки.",
        ),
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
    if (!row) throw new Error(t("Файл не найден в этом хранилище."));
    return fileRow(row);
  }
  async updateFiles(ids, patch) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000)
      throw new Error(t("Выберите от 1 до 1000 файлов."));
    const guarded = patch.expectedObjectKey !== undefined;
    if (
      guarded &&
      (ids.length !== 1 ||
        typeof patch.expectedObjectKey !== "string" ||
        !("adjustments" in patch))
    )
      throw new Error(t("Некорректные параметры изображения."));
    const sets = ["updated_at = ?"],
      params = [new Date().toISOString()];
    if ("name" in patch) {
      if (ids.length !== 1)
        throw new Error(t("Переименовывать можно по одному файлу."));
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
        throw new Error(t("Не более 50 тегов."));
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
      const updated = await this.db.query(
        `UPDATE jr_files SET ${sets.join(", ")} WHERE library_id = ? AND id IN (${part.map(() => "?").join(",")})${guarded ? " AND object_key = ? AND trashed_at IS NULL RETURNING id" : ""}`,
        [
          ...params,
          this.id,
          ...part,
          ...(guarded ? [patch.expectedObjectKey] : []),
        ],
      );
      if (guarded && updated.length !== 1)
        throw new Error(
          t(
            "Изображение изменилось. Откройте его заново перед сохранением правок.",
          ),
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
  async documentSource(id, expectedObjectKey) {
    const file = await this.file(id),
      kind = documentKind(file);
    if (!kind) throw new Error(t("Выберите PDF, TXT или Markdown."));
    if (file.object_key !== expectedObjectKey)
      throw new Error(t("Документ изменился. Откройте его заново."));
    const limit = documentLimits[kind];
    const tooLarge = () =>
      new Error(
        t("Для просмотра доступны PDF до 64 МБ и текстовые файлы до 4 МБ."),
      );
    if (file.size_bytes > limit) throw tooLarge();
    const result = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: file.object_key,
      }),
    );
    const chunks = [];
    let length = 0;
    try {
      if (result.ContentLength > limit) throw tooLarge();
      for await (const chunk of result.Body) {
        length += chunk.length;
        if (length > limit) throw tooLarge();
        chunks.push(chunk);
      }
      return { data: new Uint8Array(Buffer.concat(chunks)), kind };
    } finally {
      result.Body?.destroy?.();
    }
  }
  async saveTextDocument(id, expectedObjectKey, data) {
    if (!(data instanceof Uint8Array) || data.length > documentLimits.text)
      throw new Error(
        t("Для редактирования доступны текстовые файлы до 4 МБ."),
      );
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      throw new Error(t("Документ должен быть в кодировке UTF-8."));
    }
    const file = await this.file(id),
      kind = documentKind(file);
    if (!["text", "markdown"].includes(kind))
      throw new Error(t("Редактирование доступно только для TXT и Markdown."));
    if (file.object_key !== expectedObjectKey)
      throw new Error(t("Документ изменился. Откройте его заново."));
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "jellyree-document-"),
    );
    try {
      const source = path.join(directory, "document.txt");
      await writeFile(source, data, { flag: "wx", mode: 0o600 });
      const result = await this.uploadFile(source, file.folder_id, () => {}, {
        name: file.name,
        replaceId: id,
        expectedObjectKey,
        mimeType: kind === "markdown" ? "text/markdown" : "text/plain",
      });
      return { file: await this.file(id), warning: result.warning };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  async imageSource(id) {
    const file = await this.file(id),
      limit = 64 * 1024 * 1024;
    if (!file.mime_type.startsWith("image/"))
      throw new Error(t("Выберите изображение."));
    if (file.size_bytes > limit)
      throw new Error(t("Для редактирования доступны изображения до 64 МБ."));
    const result = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: file.object_key,
      }),
    );
    const chunks = [];
    let length = 0;
    try {
      if (result.ContentLength > limit)
        throw new Error(t("Для редактирования доступны изображения до 64 МБ."));
      for await (const chunk of result.Body) {
        length += chunk.length;
        if (length > limit)
          throw new Error(
            t("Для редактирования доступны изображения до 64 МБ."),
          );
        chunks.push(chunk);
      }
      return {
        data: new Uint8Array(Buffer.concat(chunks)),
        mimeType: file.mime_type,
      };
    } finally {
      result.Body?.destroy?.();
    }
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
      throw new Error(t("Слишком много файлов."));
    let done = 0;
    for (const id of ids) {
      const file = await this.file(id);
      if (!file.trashed_at)
        throw new Error(t("Сначала переместите файл в корзину."));
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
  async saveVideoFrame(id, expectedObjectKey, timestamp, data) {
    try {
      validateVideoFrame(data, timestamp);
    } catch {
      throw new Error(t("Некорректный стопкадр видео."));
    }
    const video = await this.file(id);
    if (!video.mime_type.startsWith("video/"))
      throw new Error(t("Выберите видео."));
    if (
      typeof expectedObjectKey !== "string" ||
      expectedObjectKey !== video.object_key
    )
      throw new Error(t("Видео изменилось. Откройте его заново."));
    const rows = await this.db.query(
      "SELECT name FROM jr_files WHERE library_id = ? AND folder_id IS ? AND trashed_at IS NULL",
      [this.id, video.folder_id],
    );
    const names = new Set(rows.map((row) => row.name));
    let suffix = 0,
      name = videoFrameName(video.name, timestamp);
    while (names.has(name))
      name = videoFrameName(video.name, timestamp, ++suffix);
    const directory = await mkdtemp(path.join(os.tmpdir(), "jellyree-frame-"));
    try {
      const source = path.join(directory, "frame.png");
      await writeFile(source, data, { flag: "wx", mode: 0o600 });
      const result = await this.uploadFile(source, video.folder_id, () => {}, {
        name,
      });
      return this.file(result.id);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  async uploadFile(source, folderId, report = () => {}, options = {}) {
    await this.folder(folderId);
    const info = await stat(source);
    if (!info.isFile()) throw new Error(t("Ожидался обычный файл."));
    const name = cleanName(options.name || path.basename(source));
    const previous = options.replaceId
      ? await this.file(options.replaceId)
      : null;
    if (
      (options.expectedObjectKey !== undefined &&
        previous?.object_key !== options.expectedObjectKey) ||
      (previous &&
        (previous.trashed_at ||
          previous.folder_id !== (folderId || null) ||
          previous.name !== name))
    )
      throw new Error(
        t("Файл изменился во время загрузки. Повторите операцию."),
      );
    const id = previous?.id || randomUUID();
    // Always upload to a new object, including replacement. The previous bytes
    // remain available until D1 has committed and the result has been verified.
    const key = [this.config.prefix, "objects", randomUUID(), name]
      .filter(Boolean)
      .join("/");
    const mimeType =
      options.mimeType ||
      mime.getType(path.basename(source)) ||
      "application/octet-stream";
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
      if (previous) {
        await this.db.query(
          "UPDATE jr_files SET object_key = ?, mime_type = ?, size_bytes = ?, adjustments = '{}', updated_at = ? WHERE id = ? AND library_id = ? AND object_key = ? AND trashed_at IS NULL",
          [key, mimeType, info.size, now, id, this.id, previous.object_key],
        );
        const [verified] = await this.db.query(
          "SELECT id, object_key FROM jr_files WHERE id = ? AND library_id = ?",
          [id, this.id],
        );
        if (verified?.object_key !== key)
          throw new Error(
            t("Файл изменился во время загрузки. Повторите операцию."),
          );
      } else {
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
      }
    } catch (error) {
      let saved;
      try {
        [saved] = await this.db.query(
          "SELECT id, object_key FROM jr_files WHERE id = ? AND library_id = ?",
          [id, this.id],
        );
      } catch {
        throw new Error(
          t(
            "Не удалось подтвердить запись D1 для {0}. Объект сохранён в R2; проверьте подключение. Ключ: {1}",
            { 0: name, 1: key },
          ),
        );
      }
      if (saved?.object_key !== key) {
        await this.s3.send(
          new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
        );
        throw error;
      }
    }
    let warning;
    if (previous) {
      try {
        await this.s3.send(
          new DeleteObjectCommand({
            Bucket: this.config.bucket,
            Key: previous.object_key,
          }),
        );
      } catch {
        warning = t(
          "Файл {0} заменён, но предыдущий объект не удалось удалить из R2.",
          { 0: name },
        );
      }
    }
    return { id, name, warning };
  }
  async uploadPaths(paths, folderId, report = () => {}, resolveConflict) {
    if (!Array.isArray(paths) || paths.length > 10000)
      throw new Error(t("Некорректный список файлов."));
    await this.folder(folderId);
    const jobs = [],
      failures = [],
      warnings = [];
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
        for (const entry of await readdir(source, { withFileTypes: true }))
          if (!entry.isSymbolicLink())
            await walk(path.join(source, entry.name), folder);
      } else if (info.isFile())
        jobs.push({
          source,
          folder: parent || null,
          size: info.size,
          name: cleanName(path.basename(source)),
        });
    };
    for (const source of paths) await walk(String(source), folderId || null);
    const reserved = new Map(),
      seen = new Map();
    for (const parent of new Set(jobs.map((job) => job.folder))) {
      const rows = await this.db.query(
        "SELECT name FROM jr_files WHERE library_id = ? AND folder_id IS ? AND trashed_at IS NULL",
        [this.id, parent],
      );
      reserved.set(parent, new Set(rows.map((row) => row.name)));
      seen.set(parent, new Set(rows.map((row) => row.name)));
    }
    let totalConflicts = 0;
    for (const job of jobs) {
      job.conflict = seen.get(job.folder).has(job.name);
      if (job.conflict) totalConflicts++;
      seen.get(job.folder).add(job.name);
      reserved.get(job.folder).add(job.name);
    }
    const folders = await this.folders(),
      byId = new Map(folders.map((f) => [f.id, f]));
    const folderPath = (id) => {
      const parts = [],
        visited = new Set();
      while (id && !visited.has(id)) {
        visited.add(id);
        const folder = byId.get(id);
        if (!folder) break;
        parts.unshift(folder.name);
        id = folder.parent_id;
      }
      return parts.join(" / ");
    };
    const existingFile = async (parent, name) =>
      await this.db.query(
        "SELECT id, name, size_bytes, updated_at FROM jr_files WHERE library_id = ? AND folder_id IS ? AND name = ? AND trashed_at IS NULL ORDER BY created_at DESC, id DESC",
        [this.id, parent, name],
      );
    const uniqueName = (name, names) => {
      const extension = path.extname(name),
        stem = path.basename(name, extension);
      let suffix = 1,
        candidate;
      do {
        const tail = ` (${suffix++})${extension}`;
        candidate = `${stem.slice(0, Math.max(1, 255 - tail.length))}${tail}`;
      } while (names.has(candidate));
      return candidate;
    };
    let processed = 0,
      done = 0,
      skipped = 0,
      bytes = 0,
      remaining = totalConflicts,
      policy = null,
      canceled = false;
    const totalBytes = jobs.reduce((sum, job) => sum + job.size, 0);
    report({ done: 0, total: jobs.length, loaded: 0, totalBytes });
    for (const job of jobs) {
      let name = job.name,
        replaceId,
        fileState = "failed",
        fileMessage;
      try {
        const matches = await existingFile(job.folder, name);
        if (matches.length) {
          if (!job.conflict) {
            remaining++;
            totalConflicts++;
          }
          const names = reserved.get(job.folder);
          const suggestedName = uniqueName(name, names);
          let decision = policy ? { action: policy } : null;
          if (!decision) {
            if (!resolveConflict)
              throw new Error(
                t("Для совпадающих имён требуется решение пользователя."),
              );
            const validate = async (answer) => {
              if (answer.action !== "rename") return;
              const candidate = cleanName(answer.name || suggestedName);
              if (
                names.has(candidate) ||
                (await existingFile(job.folder, candidate)).length
              )
                throw new Error(t("Это имя уже занято. Введите другое имя."));
            };
            decision = await resolveConflict(
              {
                name,
                targetPath: folderPath(job.folder),
                suggestedName,
                remaining,
                total: totalConflicts,
                incomingBytes: job.size,
                existing: {
                  name: matches[0].name,
                  sizeBytes: matches[0].size_bytes,
                  updatedAt: matches[0].updated_at,
                },
                existingCount: matches.length,
              },
              validate,
            );
            if (
              !decision ||
              !["skip", "rename", "replace", "cancel"].includes(decision.action)
            )
              throw new Error(
                t("Некорректное решение для совпадающего файла."),
              );
            await validate(decision);
            if (decision.applyToAll) policy = decision.action;
          }
          remaining = Math.max(0, remaining - 1);
          if (decision.action === "cancel") {
            canceled = true;
            fileState = "canceled";
            break;
          }
          if (decision.action === "skip") {
            skipped++;
            fileState = "skipped";
            continue;
          }
          if (decision.action === "rename") {
            name = cleanName(decision.name || suggestedName);
            names.add(name);
          }
          if (decision.action === "replace") replaceId = matches[0].id;
        } else if (job.conflict) remaining = Math.max(0, remaining - 1);
        const result = await this.uploadFile(
          job.source,
          job.folder,
          (p) =>
            report({
              name,
              done: processed,
              total: jobs.length,
              loaded: bytes + p.loaded,
              totalBytes,
              failures: failures.length,
              fileIndex: processed,
              fileState: "uploading",
              sizeBytes: job.size,
              targetPath: folderPath(job.folder),
            }),
          { name, replaceId },
        );
        done++;
        fileState = "uploaded";
        if (result.warning) warnings.push(result.warning);
      } catch (error) {
        fileMessage = error.message;
        failures.push({ name, message: error.message });
      } finally {
        processed++;
        bytes += job.size;
        report({
          name,
          done: processed,
          total: jobs.length,
          loaded: bytes,
          totalBytes,
          failures: failures.length,
          fileIndex: processed - 1,
          fileState,
          sizeBytes: job.size,
          targetPath: folderPath(job.folder),
          message: fileMessage,
        });
      }
    }
    return { done, skipped, canceled, failures, warnings };
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
