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
  CopyObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import mime from "mime";
import { D1 } from "./d1.mjs";
import { CatalogCache } from "./catalog-cache.mjs";
import { catalogListing, timelineMedia } from "./catalog-query.mjs";
import { libraryId } from "./config.mjs";
import { normalizeImageAdjustments } from "./image-adjustments.mjs";
import { validateVideoFrame, videoFrameName } from "./video-frames.mjs";
import { documentKind, documentLimits } from "./document-preview.mjs";
import {
  isImageFile,
  isPxzFile,
  imageMimeType,
  imageSaveFormat,
  matchesEncodedImage,
  IMAGE_EDIT_MAX_BYTES,
} from "./image-formats.mjs";
import { PXZ_LIMIT, PxzRangeReader, readPxz } from "./pxz-archive.mjs";

const schema = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
const catalogIndexes = {
  timeline: `CREATE INDEX IF NOT EXISTS jr_media_date ON jr_files(library_id, created_at DESC, id DESC) WHERE trashed_at IS NULL AND ${timelineMedia}`,
  folderDate:
    "CREATE INDEX IF NOT EXISTS jr_active_folder_date ON jr_files(library_id, folder_id, created_at DESC, id DESC) WHERE trashed_at IS NULL",
  date: "CREATE INDEX IF NOT EXISTS jr_active_date ON jr_files(library_id, created_at DESC, id DESC) WHERE trashed_at IS NULL",
  folderName:
    "CREATE INDEX IF NOT EXISTS jr_active_folder_name ON jr_files(library_id, folder_id, name, created_at DESC, id DESC) WHERE trashed_at IS NULL",
};
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
  #failedUploads = new Map();
  #indexAttempts = new Map();

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
  #ensureIndex(key) {
    const previous = this.#indexAttempts.get(key);
    if (previous && Date.now() < previous.retryAt) return previous.ready;
    const attempt = { retryAt: Infinity };
    attempt.ready = this.db.query(catalogIndexes[key]).then(
      () => true,
      () => {
        // Keep the queries usable while D1 limits delay an index build.
        attempt.retryAt = Date.now() + 60 * 60 * 1000;
        return false;
      },
    );
    this.#indexAttempts.set(key, attempt);
    return attempt.ready;
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
  enableCatalogCache(filename) {
    this.catalog = new CatalogCache(filename, this.db, this.id, schema);
  }
  cachedFolders() {
    return this.catalog?.folders(() => this.folders()) ?? this.folders();
  }
  cachedStats() {
    return this.catalog?.stats(() => this.stats()) ?? this.stats();
  }
  timelineBounds() {
    const fetch = async () => {
      await this.#ensureIndex("timeline");
      const match = `FROM jr_files WHERE library_id = ? AND trashed_at IS NULL AND ${timelineMedia}`;
      const [bounds] = await this.db.query(
        `SELECT (SELECT created_at ${match} ORDER BY created_at ASC LIMIT 1) AS oldest,
                (SELECT created_at ${match} ORDER BY created_at DESC LIMIT 1) AS newest`,
        [this.id, this.id],
      );
      return bounds;
    };
    return this.catalog?.timelineBounds(fetch) ?? fetch();
  }
  async list(input = {}) {
    const query = catalogListing(input, this.id);
    if (input.refresh) this.catalog?.invalidate();
    const fetchRows = async (sql, params) => {
      if (query.section === "timeline") await this.#ensureIndex("timeline");
      else if (query.sortName === "date" && query.section !== "trash")
        await this.#ensureIndex(
          query.section === "drive" ? "folderDate" : "date",
        );
      return this.db.query(sql, params);
    };
    let rows, hasMore;
    if (this.catalog) {
      ({ rows, hasMore } = await this.catalog.list(query, fetchRows));
    } else {
      rows = await fetchRows(
        ...query.select({
          after: query.after,
          limit: query.limit + 1,
          offset: query.offset,
        }),
      );
      hasMore = rows.length > query.limit;
    }
    let total;
    if (query.includeTotal) {
      if (query.page === 1 && !query.after && !hasMore) total = rows.length;
      else {
        const [count] = await this.db.query(...query.count);
        total = count.total;
      }
    }
    return {
      items: rows.slice(0, query.limit).map(fileRow),
      ...(total === undefined ? {} : { total }),
      page: query.throughPage,
      hasMore,
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
  async file(id, options) {
    const [row] = await this.db.query(
      "SELECT * FROM jr_files WHERE id = ? AND library_id = ?",
      [id, this.id],
      options,
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
    return this.urlForFile(file, download);
  }
  async urlForFile(file, download = false) {
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
      return { file: result.file, warning: result.warning };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  async saveEditedImage(id, expectedObjectKey, data) {
    if (
      !(data instanceof Uint8Array) ||
      !data.length ||
      data.length > IMAGE_EDIT_MAX_BYTES
    )
      throw new Error(t("Для сохранения доступны изображения до 64 МБ."));
    const file = await this.file(id);
    if (!isImageFile(file)) throw new Error(t("Выберите изображение."));
    if (file.trashed_at || file.object_key !== expectedObjectKey)
      throw new Error(t("Изображение изменилось. Откройте его заново."));
    const { format, convertsToPng } = imageSaveFormat(file);
    if (!matchesEncodedImage(data, format))
      throw new Error(t("Не удалось закодировать изображение для сохранения."));
    const replacementName = convertsToPng
      ? await this.#availableFileName(
          file.folder_id,
          path.basename(file.name, path.extname(file.name)) + ".png",
          0,
        )
      : undefined;
    const directory = await mkdtemp(path.join(os.tmpdir(), "jellyree-image-"));
    try {
      const source = path.join(directory, "edited." + format);
      await writeFile(source, data, { flag: "wx", mode: 0o600 });
      const result = await this.uploadFile(source, file.folder_id, () => {}, {
        name: file.name,
        replaceId: id,
        expectedObjectKey,
        mimeType: "image/" + format,
        replacementName,
      });
      return { file: result.file, warning: result.warning };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  async pxzThumbnail(file, signal) {
    const reader = new PxzRangeReader(
      file.size_bytes,
      async (start, length) => {
        const end = start + length - 1;
        const response = await this.s3.send(
          new GetObjectCommand({
            Bucket: this.config.bucket,
            Key: file.object_key,
            Range: `bytes=${start}-${end}`,
          }),
          { abortSignal: signal },
        );
        try {
          if (
            response.ContentRange !== `bytes ${start}-${end}/${file.size_bytes}`
          )
            throw new Error("Unexpected PXZ range");
          const data = new Uint8Array(length);
          let written = 0;
          for await (const chunk of response.Body) {
            signal?.throwIfAborted();
            if (chunk.length > length - written)
              throw new Error("Invalid PXZ range");
            data.set(chunk, written);
            written += chunk.length;
          }
          if (written !== length) throw new Error("Incomplete PXZ range");
          return data;
        } finally {
          response.Body?.destroy?.();
        }
      },
    );
    return readPxz(
      reader,
      (read) => read("thumbnail.webp", 2 * 1024 * 1024),
      signal,
    );
  }
  async imageSource(id, { signal, expectedObjectKey, thumbnail } = {}) {
    const file = await this.file(id, { signal });
    const pxz = isPxzFile(file);
    if (!pxz && !isImageFile(file)) throw new Error(t("Выберите изображение."));
    if (
      expectedObjectKey !== undefined &&
      file.object_key !== expectedObjectKey
    )
      throw new Error(
        t(
          "Изображение изменилось. Откройте его заново перед сохранением правок.",
        ),
      );
    if (pxz && thumbnail) {
      try {
        const data = await this.pxzThumbnail(file, signal);
        if (data) return { data, mimeType: "image/webp" };
      } catch {
        signal?.throwIfAborted();
        // A missing or unreadable embedded image can be rendered from the layers.
      }
    }
    const limit = pxz ? PXZ_LIMIT : IMAGE_EDIT_MAX_BYTES;
    const tooLarge = () =>
      new Error(
        t(
          pxz
            ? "Для просмотра PXZ доступны проекты до 128 МБ и 48 мегапикселей."
            : "Для редактирования доступны изображения до 64 МБ.",
        ),
      );
    if (file.size_bytes > limit) throw tooLarge();
    const result = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: file.object_key,
      }),
      { abortSignal: signal },
    );
    const chunks = [];
    let length = 0;
    try {
      if (result.ContentLength > limit) throw tooLarge();
      for await (const chunk of result.Body) {
        signal?.throwIfAborted();
        length += chunk.length;
        if (length > limit) throw tooLarge();
        chunks.push(chunk);
      }
      return {
        data: new Uint8Array(Buffer.concat(chunks)),
        mimeType: imageMimeType(file),
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
    await this.#ensureIndex("folderName");
    let suffix = 0,
      name = videoFrameName(video.name, timestamp);
    while ((await this.#filesNamed(video.folder_id, name)).length)
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
  async duplicatePhoto(id, expectedObjectKey) {
    const source = await this.file(id);
    if (!isImageFile(source) && !isPxzFile(source))
      throw new Error(t("Выберите изображение."));
    const changed = () =>
      new Error(t("Изображение изменилось. Откройте его заново."));
    if (source.trashed_at || source.object_key !== expectedObjectKey)
      throw changed();

    const name = await this.#availableFileName(
      source.folder_id,
      source.name,
      1,
    );
    const copyId = randomUUID();
    const key = [this.config.prefix, "objects", copyId]
      .filter(Boolean)
      .join("/");
    const bucket = this.config.bucket;
    const discardCopy = () =>
      this.s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    try {
      await this.s3.send(
        new CopyObjectCommand({
          Bucket: bucket,
          Key: key,
          CopySource: [bucket, ...source.object_key.split("/")]
            .map(encodeURIComponent)
            .join("/"),
        }),
      );
    } catch (error) {
      await discardCopy().catch(() => {});
      throw error;
    }

    const now = new Date().toISOString();
    try {
      const [copy] = await this.db.query(
        `INSERT INTO jr_files
          (id, library_id, folder_id, object_key, name, mime_type, size_bytes, favorite, tags, adjustments, created_at, updated_at)
         SELECT ?, library_id, folder_id, ?, ?, mime_type, size_bytes, favorite, tags, adjustments, ?, ?
         FROM jr_files WHERE id = ? AND library_id = ? AND object_key = ? AND folder_id IS ? AND trashed_at IS NULL
         RETURNING *`,
        [
          copyId,
          key,
          name,
          now,
          now,
          id,
          this.id,
          expectedObjectKey,
          source.folder_id,
        ],
      );
      if (!copy) throw changed();
      return fileRow(copy);
    } catch (error) {
      let saved;
      try {
        [saved] = await this.db.query(
          "SELECT * FROM jr_files WHERE id = ? AND library_id = ?",
          [copyId, this.id],
        );
      } catch {
        throw new Error(
          t(
            "Не удалось подтвердить запись D1 для {0}. Объект сохранён в R2; проверьте подключение. Ключ: {1}",
            { 0: name, 1: key },
          ),
        );
      }
      if (saved?.object_key === key) return fileRow(saved);
      await discardCopy();
      throw error;
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
    const newName =
      previous && options.replacementName
        ? cleanName(options.replacementName)
        : name;
    const rename = previous && newName !== name;
    // Always upload to a new object, including replacement. The previous bytes
    // remain available until D1 has committed and the result has been verified.
    const key = [this.config.prefix, "objects", randomUUID(), newName]
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
    let replacement;
    try {
      if (previous) {
        const [saved] = await this.db.query(
          `UPDATE jr_files SET object_key = ?, mime_type = ?, size_bytes = ?, adjustments = '{}', updated_at = ?${rename ? ", name = ?" : ""}
           WHERE id = ? AND library_id = ? AND object_key = ? AND trashed_at IS NULL
           ${rename ? "AND name = ? AND folder_id IS ? AND NOT EXISTS (SELECT 1 FROM jr_files AS other WHERE other.library_id = ? AND other.folder_id IS ? AND other.name = ? AND other.trashed_at IS NULL)" : ""}
           RETURNING *`,
          [
            key,
            mimeType,
            info.size,
            now,
            ...(rename ? [newName] : []),
            id,
            this.id,
            previous.object_key,
            ...(rename
              ? [name, previous.folder_id, this.id, previous.folder_id, newName]
              : []),
          ],
        );
        if (saved?.object_key !== key)
          throw new Error(
            t("Файл изменился во время загрузки. Повторите операцию."),
          );
        replacement = fileRow(saved);
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
          "SELECT * FROM jr_files WHERE id = ? AND library_id = ?",
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
      if (previous) replacement = fileRow(saved);
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
          { 0: newName },
        );
      }
    }
    return { id, name: newName, warning, file: replacement };
  }
  async uploadPaths(paths, folderId, report = () => {}, resolveConflict) {
    if (!Array.isArray(paths) || paths.length > 10000)
      throw new Error(t("Некорректный список файлов."));
    await this.folder(folderId);
    const jobs = [];
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
    return this.#uploadJobs(jobs, report, resolveConflict);
  }
  async retryUploads(ids, report = () => {}, resolveConflict) {
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.some((id) => !this.#failedUploads.has(id))
    )
      throw new Error(t("Эти загрузки больше недоступны для повтора."));
    const jobs = [];
    for (const retryId of new Set(ids)) {
      const job = this.#failedUploads.get(retryId);
      const info = await stat(job.source).catch(() => null);
      jobs.push({
        ...job,
        retryId,
        size: info?.isFile() ? info.size : job.size,
      });
    }
    return this.#uploadJobs(jobs, report, resolveConflict);
  }
  async #uploadJobs(jobs, report, resolveConflict) {
    const failures = [],
      warnings = [],
      resolvedRetryIds = [];
    const indexed = jobs.length && (await this.#ensureIndex("folderName"));
    const reserved = new Map(),
      seen = new Map();
    for (const job of jobs) {
      if (!reserved.has(job.folder)) reserved.set(job.folder, new Set());
      reserved.get(job.folder).add(job.name);
    }
    for (const [parent, incoming] of reserved) {
      const found = new Set();
      seen.set(parent, found);
      const names = [...incoming];
      const select =
        "SELECT DISTINCT name FROM jr_files WHERE library_id = ? AND folder_id IS ? AND trashed_at IS NULL";
      if (indexed) {
        const chunkSize = 98;
        for (let start = 0; start < names.length; start += chunkSize) {
          const chunk = names.slice(start, start + chunkSize);
          const rows = await this.db.query(
            `${select} AND name IN (${chunk.map(() => "?").join(", ")})`,
            [this.id, parent, ...chunk],
          );
          for (const row of rows) found.add(row.name);
        }
      } else {
        for (const row of await this.db.query(select, [this.id, parent])) {
          found.add(row.name);
          incoming.add(row.name);
        }
      }
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
    const uniqueName = async (name, names, parent) => {
      const extension = path.extname(name),
        stem = path.basename(name, extension);
      let suffix = 1;
      for (;;) {
        const tail = ` (${suffix++})${extension}`;
        const candidate = `${stem.slice(0, Math.max(1, 255 - tail.length))}${tail}`;
        if (names.has(candidate)) continue;
        if (!(await this.#filesNamed(parent, candidate)).length)
          return candidate;
        names.add(candidate);
      }
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
        const matches = await this.#filesNamed(job.folder, name);
        if (matches.length) {
          if (!job.conflict) {
            remaining++;
            totalConflicts++;
          }
          const names = reserved.get(job.folder);
          const suggestedName = await uniqueName(name, names, job.folder);
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
                (await this.#filesNamed(job.folder, candidate)).length
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
        const retryId = job.retryId ?? randomUUID();
        this.#failedUploads.set(retryId, {
          source: job.source,
          folder: job.folder,
          size: job.size,
          name,
        });
        failures.push({
          name,
          message: fileMessage,
          retryId,
          fileIndex: processed,
          targetPath: folderPath(job.folder),
          sizeBytes: job.size,
        });
      } finally {
        if (
          job.retryId &&
          (fileState === "uploaded" || fileState === "skipped")
        ) {
          this.#failedUploads.delete(job.retryId);
          resolvedRetryIds.push(job.retryId);
        }
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
    return {
      done,
      skipped,
      canceled,
      failures,
      warnings,
      ...(resolvedRetryIds.length ? { resolvedRetryIds } : {}),
    };
  }
  async #availableFileName(folderId, filename, suffix) {
    await this.#ensureIndex("folderName");
    const extension = path.extname(filename);
    let name;
    do {
      const number = suffix ? ` (${suffix})` : "";
      const keepExtension = extension.length + number.length < 255;
      const tail = number + (keepExtension ? extension : "");
      const stem = keepExtension
        ? path.basename(filename, extension)
        : filename;
      name =
        stem.slice(0, 255 - tail.length).replace(/[\uD800-\uDBFF]$/, "") + tail;
      suffix++;
    } while ((await this.#filesNamed(folderId, name)).length);
    return name;
  }
  #filesNamed(parent, name) {
    return this.db.query(
      "SELECT id, name, size_bytes, updated_at FROM jr_files WHERE library_id = ? AND folder_id IS ? AND name = ? AND trashed_at IS NULL ORDER BY created_at DESC, id DESC",
      [this.id, parent, name],
    );
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
  close(clearCatalog = false) {
    this.catalog?.close(clearCatalog);
    this.s3.destroy();
  }
}
