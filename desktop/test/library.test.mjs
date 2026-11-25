import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  mkdir,
  mkdtemp,
  writeFile,
  rm,
  readFile,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  TextReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipWriter,
} from "@zip.js/zip.js/index-native.js";
import { setLanguage } from "../electron/locales.mjs";
setLanguage("ru");
import { Library } from "../electron/library.mjs";
import { catalogListing } from "../electron/catalog-query.mjs";
import { readCaptureDate } from "../electron/capture-date.mjs";
import { D1 } from "../electron/d1.mjs";
import {
  ConfigStore,
  normalizeConfig,
  libraryId,
} from "../electron/config.mjs";

const config = normalizeConfig({
  accountId: "a".repeat(32),
  databaseId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  bucket: "test-drive",
  prefix: "jellyree",
  apiToken: "super-private-token",
  accessKeyId: "r2-access",
  secretAccessKey: "r2-secret",
});
const captureDate = "2012-05-02T01:26:00.125Z";
function fixture(t, overrides = {}) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const requests = [],
    deleted = [];
  const request = async (url, init) => {
    assert.equal(init.headers.Authorization, `Bearer ${config.apiToken}`);
    const body = JSON.parse(init.body);
    requests.push(body);
    try {
      const run = ({ sql, params = [] }) => {
        if (sql.includes("CREATE TABLE")) {
          sqlite.exec(sql);
          return { success: true, results: [] };
        }
        return { success: true, results: sqlite.prepare(sql).all(...params) };
      };
      const result = body.batch ? body.batch.map(run) : [run(body)];
      return Response.json({ success: true, result });
    } catch (e) {
      return Response.json(
        { success: false, errors: [{ message: e.message }] },
        { status: 400 },
      );
    }
  };
  const db = new D1(config, request);
  const s3 = {
    send: async (command) => {
      if (command.constructor.name === "DeleteObjectCommand")
        deleted.push(command.input.Key);
      return {};
    },
    destroy() {},
  };
  const library = new Library(config, { db, s3, ...overrides });
  const insert = (id, options = {}) => {
    const row = {
      name: `${id}.jpg`,
      folder: null,
      tags: [],
      favorite: 0,
      mime: "image/jpeg",
      size: 1024,
      trash: null,
      captured: null,
      scope: library.id,
      ...options,
    };
    sqlite
      .prepare(
        "INSERT INTO jr_files (id, library_id, folder_id, object_key, name, mime_type, size_bytes, tags, favorite, trashed_at, captured_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        row.scope,
        row.folder,
        `objects/${id}`,
        row.name,
        row.mime,
        row.size,
        JSON.stringify(row.tags),
        row.favorite,
        row.trash,
        row.captured,
        "2026-01-01",
        "2026-01-01",
      );
  };
  return { library, sqlite, requests, deleted, insert, db };
}

test("PXZ preview reads only ZIP ranges for embedded thumbnails and validates the source revision", async (t) => {
  const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  const thumbnail = Uint8Array.of(82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80);
  await zip.add(
    "manifest.json",
    new TextReader('{"width":1200,"height":800,"stack":[]}'),
  );
  await zip.add("thumbnail.webp", new Uint8ArrayReader(thumbnail), {
    level: 0,
  });
  await zip.add("layer.png", new Uint8ArrayReader(new Uint8Array(400000)), {
    level: 0,
  });
  const data = await zip.close();
  const { library, insert } = fixture(t);
  await library.initialize();
  insert("project", {
    name: "Poster.PXZ",
    mime: "application/octet-stream",
    size: data.length,
  });
  let downloaded = 0;
  const calls = [];
  library.s3.send = async ({ input }) => {
    assert.equal(input.Key, "objects/project");
    calls.push(input.Range);
    if (!input.Range) return { ContentLength: data.length, Body: [data] };
    const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(input.Range);
    const segment = data.slice(+first, +last + 1);
    downloaded += segment.length;
    return {
      ContentRange: `bytes ${first}-${last}/${data.length}`,
      Body: [segment],
    };
  };
  await assert.rejects(
    library.imageSource("project", {
      expectedObjectKey: "old",
      thumbnail: true,
    }),
  );
  assert.equal(calls.length, 0);
  const small = await library.imageSource("project", {
    expectedObjectKey: "objects/project",
    thumbnail: true,
  });
  assert.deepEqual(small, { data: thumbnail, mimeType: "image/webp" });
  assert.ok(
    calls.length > 1 && calls.every(Boolean) && downloaded < data.length / 2,
  );
  const full = await library.imageSource("project", {
    expectedObjectKey: "objects/project",
  });
  assert.deepEqual(full, { data, mimeType: "application/pxz" });
  const photos = await library.list({ section: "photos", page: 1 });
  assert.ok(photos.items.some(({ id }) => id === "project"));
});

test("document source validates type, library scope, version and declared size before reading R2", async (t) => {
  const { library, insert } = fixture(t);
  await library.initialize();
  insert("text", { name: "Notes.TXT", mime: "application/octet-stream" });
  insert("md", { name: "readme.md", mime: "text/plain" });
  insert("pdf", { name: "guide.pdf", mime: "application/pdf" });
  insert("foreign", {
    name: "secret.txt",
    mime: "text/plain",
    scope: "another-library",
  });
  insert("huge", {
    name: "huge.txt",
    mime: "text/plain",
    size: 5 * 1024 * 1024,
  });
  insert("image");
  const reads = [];
  let closed = 0;
  library.s3.send = async (command) => {
    reads.push(command.input.Key);
    return {
      ContentLength: 5,
      Body: Object.assign(
        (async function* () {
          yield Buffer.from("hello");
        })(),
        {
          destroy() {
            closed++;
          },
        },
      ),
    };
  };
  for (const [id, kind] of [
    ["text", "text"],
    ["md", "markdown"],
    ["pdf", "pdf"],
  ]) {
    const result = await library.documentSource(id, `objects/${id}`);
    assert.equal(result.kind, kind);
    assert.equal(Buffer.from(result.data).toString(), "hello");
  }
  assert.equal(closed, 3);
  for (const [id, key] of [
    ["foreign", "objects/foreign"],
    ["huge", "objects/huge"],
    ["text", "old-key"],
    ["image", "objects/image"],
  ])
    await assert.rejects(library.documentSource(id, key));
  assert.equal(reads.length, 3);
});
test("document source bounds streamed bytes even when R2 reports an incorrect length and destroys the body", async (t) => {
  const { library, insert } = fixture(t);
  await library.initialize();
  insert("text", { name: "test.txt", mime: "text/plain" });
  let destroyed = false;
  library.s3.send = async () => ({
    ContentLength: 1,
    Body: Object.assign(
      (async function* () {
        yield Buffer.alloc(4 * 1024 * 1024);
        yield Buffer.from("too much");
      })(),
      {
        destroy() {
          destroyed = true;
        },
      },
    ),
  });
  await assert.rejects(
    library.documentSource("text", "objects/text"),
    /до 4 МБ/,
  );
  assert.equal(destroyed, true);
});
test("text editor saves a new R2 version in place, preserves metadata and cleans up temporary bytes", async (t) => {
  const uploads = [],
    paths = [];
  const { library, insert, deleted } = fixture(t, {
    createUpload: ({ params }) => ({
      on() {},
      async done() {
        paths.push(params.Body.path);
        const chunks = [];
        for await (const chunk of params.Body) chunks.push(chunk);
        uploads.push({ ...params, Body: Buffer.concat(chunks) });
      },
    }),
  });
  await library.initialize();
  const folder = await library.createFolder("Docs");
  insert("doc", {
    name: "Readme.MD",
    mime: "text/plain",
    folder: folder.id,
    favorite: 1,
    tags: ["keep"],
  });
  const data = new TextEncoder().encode("# Привет\r\nEspaña\r\n");
  const { file } = await library.saveTextDocument("doc", "objects/doc", data);
  assert.equal(file.id, "doc");
  assert.equal(file.name, "Readme.MD");
  assert.equal(file.folder_id, folder.id);
  assert.equal(file.favorite, true);
  assert.deepEqual(file.tags, ["keep"]);
  assert.equal(file.created_at, "2026-01-01");
  assert.equal(file.mime_type, "text/markdown");
  assert.equal(file.size_bytes, data.length);
  assert.notEqual(file.object_key, "objects/doc");
  assert.deepEqual(uploads[0].Body, Buffer.from(data));
  assert.equal(uploads[0].ContentType, "text/markdown");
  assert.deepEqual(deleted, ["objects/doc"]);
  const second = await library.saveTextDocument(
    "doc",
    file.object_key,
    new Uint8Array(),
  );
  assert.equal(second.file.size_bytes, 0);
  for (const source of paths)
    await assert.rejects(stat(source), { code: "ENOENT" });
});
test("photo and video metadata prefer recording dates to later creation, digitization, or export dates", async () => {
  const fixtures = new URL("fixtures/", import.meta.url);
  const examples = JSON.parse(
    await readFile(new URL("media-dates.json", fixtures)),
  );
  for (const [name, type, expected] of examples) {
    assert.equal(
      await readCaptureDate(fileURLToPath(new URL(name, fixtures)), type),
      expected,
      name,
    );
  }
});

test("photo and video uploads retain media dates separately after migrating an existing database and cache", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jr-capture-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = path.join(directory, "catalog.sqlite");
  const { library, db, sqlite, insert, requests } = fixture(t, {
    createUpload: ({ params }) => ({
      on() {},
      async done() {
        for await (const chunk of params.Body) assert.ok(chunk.length);
      },
    }),
  });
  await library.initialize();
  insert("legacy");
  sqlite.exec("ALTER TABLE jr_files DROP COLUMN captured_at");
  library.enableCatalogCache(cache);
  library.catalog.local.exec("ALTER TABLE jr_files DROP COLUMN captured_at");
  library.catalog.close();

  const reopened = new Library(config, {
    db,
    s3: library.s3,
    createUpload: library.createUpload,
  });
  reopened.enableCatalogCache(cache);
  t.after(() => reopened.catalog.close());
  assert.equal((await reopened.list()).items[0].id, "legacy");
  await Promise.all(
    ["capture-date.jpg", "capture-date.heic", "dates-quicktime.mov"].map(
      (name) =>
        reopened.uploadFile(
          fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)),
          null,
        ),
    ),
  );
  const { items } = await reopened.list({ section: "timeline" });
  assert.equal(items[0].id, "legacy");
  assert.equal(items[0].captured_at, null);
  assert.equal(items.length, 4);
  assert.equal(items[1].name, "dates-quicktime.mov");
  assert.equal(items[1].captured_at, "2019-08-12T10:04:05.000Z");
  for (const item of items.slice(2))
    assert.equal(item.captured_at, captureDate);
  for (const item of items.slice(1)) {
    assert.notEqual(item.created_at, item.captured_at);
    assert.equal(item.updated_at, item.created_at);
  }
  insert("old-video", { name: "dates-header.mp4", mime: "video/mp4" });
  const { file } = await reopened.uploadFile(
    fileURLToPath(new URL("fixtures/dates-header.mp4", import.meta.url)),
    null,
    () => {},
    { replaceId: "old-video" },
  );
  assert.equal(file.captured_at, "2024-11-28T10:30:00.000Z");
  assert.equal(file.created_at, "2026-01-01");
  assert.equal(
    requests.filter(({ sql }) => sql?.startsWith("ALTER TABLE")).length,
    1,
  );
});

test("saving photo edits replaces the bytes and resets adjustments while keeping library metadata", async (t) => {
  const uploads = [];
  const { library, insert, deleted } = fixture(t, {
    createUpload: ({ params }) => ({
      on() {},
      async done() {
        const chunks = [];
        for await (const chunk of params.Body) chunks.push(chunk);
        uploads.push({ ...params, bytes: Buffer.concat(chunks) });
      },
    }),
  });
  await library.initialize();
  const folder = await library.createFolder("Photos");
  insert("photo", {
    name: "Photo.PNG",
    mime: "image/png",
    folder: folder.id,
    tags: ["kept"],
    favorite: 1,
    captured: captureDate,
  });
  await library.updateFiles(["photo"], { adjustments: { rotate: 90 } });
  const bytes = await readFile(new URL("fixtures/editor.png", import.meta.url));
  const { file } = await library.saveEditedImage(
    "photo",
    "objects/photo",
    bytes,
  );
  assert.deepEqual(file.adjustments, {});
  assert.equal(file.id, "photo");
  assert.equal(file.name, "Photo.PNG");
  assert.equal(file.folder_id, folder.id);
  assert.equal(file.favorite, true);
  assert.equal(file.created_at, "2026-01-01");
  assert.equal(file.captured_at, captureDate);
  assert.deepEqual(file.tags, ["kept"]);
  assert.equal(file.mime_type, "image/png");
  assert.equal(file.size_bytes, bytes.length);
  assert.equal(file.object_key, uploads[0].Key);
  assert.deepEqual(uploads[0].bytes, bytes);
  assert.equal(uploads[0].ContentType, "image/png");
  assert.deepEqual(deleted, ["objects/photo"]);
  await assert.rejects(
    library.saveEditedImage("photo", "objects/photo", bytes),
    /Изображение изменилось/,
  );
  await assert.rejects(
    library.saveEditedImage(
      "photo",
      file.object_key,
      Uint8Array.of(255, 216, 1, 255, 217),
    ),
    /закодировать изображение/,
  );
  assert.equal(uploads.length, 1);

  insert("heic", {
    name: "Photo.heic",
    mime: "image/heic",
    folder: folder.id,
    tags: ["heic"],
  });
  insert("other", { name: "Photo.png", mime: "image/png", folder: folder.id });
  const converted = (
    await library.saveEditedImage("heic", "objects/heic", bytes)
  ).file;
  assert.equal(converted.name, "Photo (1).png");
  assert.equal(converted.id, "heic");
  assert.equal(converted.mime_type, "image/png");
  assert.deepEqual(converted.tags, ["heic"]);
  assert.equal(uploads[1].ContentType, "image/png");
  assert.equal((await library.file("other")).object_key, "objects/other");
});
test("text editor refuses stale, foreign, unsupported or invalid content without uploading", async (t) => {
  let count = 0;
  const { library, insert } = fixture(t, {
    createUpload: () => {
      count++;
      throw new Error("should not upload");
    },
  });
  await library.initialize();
  insert("text", { name: "notes.txt", mime: "text/plain" });
  insert("foreign", { scope: "other", name: "notes.txt", mime: "text/plain" });
  insert("pdf", { name: "guide.pdf", mime: "application/pdf" });
  const data = new TextEncoder().encode("changed");
  for (const [id, key, bytes] of [
    ["text", "old-version", data],
    ["foreign", "objects/foreign", data],
    ["pdf", "objects/pdf", data],
    ["text", "objects/text", new Uint8Array([0xff])],
    ["text", "objects/text", new Uint8Array(4 * 1024 * 1024 + 1)],
  ])
    await assert.rejects(library.saveTextDocument(id, key, bytes));
  assert.equal(count, 0);
});
test("text editor checks the expected version again before upload, closing the lookup race", async (t) => {
  let uploads = 0;
  const { library, insert, sqlite, deleted } = fixture(t, {
    createUpload: () => {
      uploads++;
      throw new Error("unexpected upload");
    },
  });
  await library.initialize();
  insert("text", { name: "notes.txt", mime: "text/plain" });
  const file = library.file.bind(library);
  let reads = 0;
  library.file = async (id) => {
    if (++reads === 2)
      sqlite
        .prepare("UPDATE jr_files SET object_key = ? WHERE id = ?")
        .run("other-version", id);
    return file(id);
  };
  await assert.rejects(
    library.saveTextDocument(
      "text",
      "objects/text",
      new TextEncoder().encode("changes"),
    ),
    /Файл изменился/,
  );
  assert.equal(uploads, 0);
  assert.deepEqual(deleted, []);
  assert.equal((await library.file("text")).object_key, "other-version");
});
test("text editor rolls back its upload on a simultaneous write and keeps the winning version intact", async (t) => {
  let uploaded, temporary;
  const { library, insert, sqlite, deleted } = fixture(t, {
    createUpload: ({ params }) => ({
      on() {},
      async done() {
        uploaded = params.Key;
        temporary = params.Body.path;
        for await (const _chunk of params.Body) {
        }
        sqlite
          .prepare("UPDATE jr_files SET object_key = ? WHERE id = ?")
          .run("other-version", "text");
      },
    }),
  });
  await library.initialize();
  insert("text", { name: "notes.txt", mime: "text/plain" });
  await assert.rejects(
    library.saveTextDocument(
      "text",
      "objects/text",
      new TextEncoder().encode("changes"),
    ),
    /Файл изменился/,
  );
  assert.equal((await library.file("text")).object_key, "other-version");
  assert.deepEqual(deleted, [uploaded]);
  await assert.rejects(stat(temporary), { code: "ENOENT" });
});
test("preview cancellation reaches D1 fetch and the R2 image stream", async (t) => {
  const controller = new AbortController();
  let d1Signal;
  const client = new D1(config, async (_url, options) => {
    d1Signal = options.signal;
    return new Promise((_, reject) =>
      options.signal.addEventListener(
        "abort",
        () => reject(options.signal.reason),
        { once: true },
      ),
    );
  });
  const pending = client.query("SELECT 1", [], { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  controller.abort();
  await rejected;
  assert.equal(d1Signal.aborted, true);
  const { library, insert } = fixture(t);
  await library.initialize();
  insert("image");
  const imageController = new AbortController();
  let r2Signal,
    destroyed = false;
  library.s3.send = async (_command, options) => {
    r2Signal = options.abortSignal;
    return {
      Body: Object.assign(
        (async function* () {
          yield Buffer.from([1]);
          imageController.abort();
          yield Buffer.from([2]);
        })(),
        {
          destroy() {
            destroyed = true;
          },
        },
      ),
    };
  };
  await assert.rejects(
    library.imageSource("image", { signal: imageController.signal }),
    { name: "AbortError" },
  );
  assert.equal(r2Signal, imageController.signal);
  assert.equal(destroyed, true);
});
test("legacy HEIC objects appear in photos and allow scoped original reads without changing their stored bytes", async (t) => {
  const { library, insert } = fixture(t);
  await library.initialize();
  insert("heic", { name: "IMG.HEIC", mime: "application/octet-stream" });
  insert("heif", { name: "IMG.HeIf", mime: "application/octet-stream" });
  insert("foreign-heic", {
    name: "Foreign.heic",
    mime: "image/heic",
    scope: "other",
  });
  insert("text", { name: "notes.txt", mime: "text/plain" });
  const bytes = await readFile(
    new URL("fixtures/preview.heic", import.meta.url),
  );
  let reads = 0;
  library.s3.send = async () => {
    reads++;
    return {
      ContentLength: bytes.length,
      Body: (async function* () {
        yield bytes;
      })(),
    };
  };
  assert.deepEqual(
    (await library.list({ section: "photos" })).items.map((f) => f.id).sort(),
    ["heic", "heif"],
  );
  const result = await library.imageSource("heic");
  assert.equal(result.mimeType, "image/heic");
  assert.deepEqual(Buffer.from(result.data), bytes);
  await assert.rejects(library.imageSource("foreign-heic"));
  await assert.rejects(library.imageSource("text"));
  assert.equal(reads, 1);
  assert.equal(
    (await library.file("heic")).mime_type,
    "application/octet-stream",
  );
  assert.equal((await library.file("heic")).object_key, "objects/heic");
});
test("D1 checks HTTP, envelope and individual query errors without leaking the token", async () => {
  for (const response of [
    Response.json(
      { success: false, errors: [{ message: config.apiToken }] },
      { status: 403 },
    ),
    Response.json({
      success: true,
      result: [{ success: false, error: "bad query" }],
    }),
    Response.json({ success: true }),
  ]) {
    const db = new D1(config, async () => response);
    await assert.rejects(
      db.query("SELECT 1"),
      (error) =>
        error.message.includes("Cloudflare D1") &&
        !error.message.includes(config.apiToken),
    );
  }
});

test("folder hierarchy rejects cycles, foreign parents and deletion of nonempty folders", async (t) => {
  const { library, insert } = fixture(t);
  await library.initialize();
  await library.initialize();
  const root = await library.createFolder("Photos"),
    child = await library.createFolder("Trips", root.id);
  await assert.rejects(
    library.updateFolder(root.id, { parentId: child.id }),
    /самой себя/,
  );
  await assert.rejects(library.createFolder("Other", "missing"), /не найдена/);
  await assert.rejects(library.deleteFolder(root.id), /пустую/);
  await library.updateFolder(child.id, { parentId: null, name: "Travel" });
  insert("photo", { folder: root.id, trash: "2026-01-02" });
  await assert.rejects(library.deleteFolder(root.id), /пустую/);
  assert.equal(
    (await library.folders()).find((f) => f.id === child.id).name,
    "Travel",
  );
});

test("drive queries paginate, scope storage, escape wildcards and search tags", async (t) => {
  const { library, insert } = fixture(t);
  await library.initialize();
  insert("literal", {
    name: "100%_complete.jpg",
    tags: ["mountains"],
    favorite: 1,
  });
  insert("other", { name: "100AAcomplete.jpg" });
  insert("gone", { trash: "2026-02-01" });
  insert("foreign", { scope: "other-bucket" });
  insert("document", { mime: "text/plain" });
  assert.equal((await library.list({ search: "%_" })).total, 1);
  assert.equal(
    (await library.list({ search: "mountains" })).items[0].id,
    "literal",
  );
  assert.equal((await library.list({ tag: "mountains" })).total, 1);
  assert.equal((await library.list({ tag: "mount" })).total, 0);
  assert.equal((await library.list({ section: "favorites" })).total, 1);
  assert.equal((await library.list({ section: "trash" })).total, 1);
  assert.equal((await library.list({ section: "photos" })).total, 2);
  for (let i = 0; i < 85; i++) insert(`page-${i}`);
  const first = await library.list({ section: "all" }),
    second = await library.list({ section: "all", page: 2 });
  assert.equal(first.items.length, 80);
  assert.equal(first.hasMore, true);
  assert.equal(second.items.length, 8);
  assert.equal(second.hasMore, false);
  assert.equal(
    new Set([...first.items, ...second.items].map((f) => f.id)).size,
    88,
  );
});

test("D1 listing refreshes five pages with a single count and skips counts on continuation", async (t) => {
  const { library, insert, requests } = fixture(t);
  await library.initialize();
  for (let i = 0; i < 480; i++) insert(`file-${String(i).padStart(3, "0")}`);
  await library.list({ includeTotal: false });
  requests.length = 0;
  const first = await library.list({ throughPage: 5 });
  assert.equal(first.page, 5);
  assert.equal(first.items.length, 400);
  assert.equal(first.total, 480);
  assert.equal(first.hasMore, true);
  assert.equal(requests.length, 2);
  assert.equal(
    requests.filter(({ sql }) => sql.includes("COUNT(*)")).length,
    1,
  );
  requests.length = 0;
  const last = await library.list({ page: 6, includeTotal: false });
  assert.equal(last.hasMore, false);
  assert.equal(last.items.length, 80);
  assert.equal(last.items[0].id, "file-079");
  assert.equal("total" in last, false);
  assert.equal(requests.length, 1);
  assert.doesNotMatch(requests[0].sql, /COUNT/i);
  requests.length = 0;
  const small = await library.list({ search: "file-479" });
  assert.equal(small.total, 1);
  assert.equal(requests.length, 1);
});

test("media timeline seeks both ways by date and indexes only active media", async (t) => {
  const { library, insert, sqlite, requests } = fixture(t);
  await library.initialize();
  for (const [id, mime, added, options] of [
    ["audio", "audio/mpeg", "2016-02-03", {}],
    ["heic", "application/octet-stream", "2019-03-08", { name: "import.HEIC" }],
    ["video", "video/mp4", "2021-04-08", {}],
    ["photo", "image/png", "2026-02-01", {}],
    ["archive", "image/jpeg", "2026-02-02", { captured: captureDate }],
    ["document", "text/plain", "2001-01-01", {}],
    ["trashed", "image/jpeg", "2027-02-20", { trash: "2027-03-02" }],
  ]) {
    insert(id, { mime, ...options });
    sqlite
      .prepare("UPDATE jr_files SET created_at = ? WHERE id = ?")
      .run(`${added}T12:00:00.000Z`, id);
  }
  assert.deepEqual(await library.timelineBounds(), {
    oldest: captureDate,
    newest: "2026-02-01T12:00:00.000Z",
  });
  const boundary = "2020-01-01T00:00:00.000Z";
  const older = await library.list({
    section: "timeline",
    timelineBefore: boundary,
    includeTotal: false,
  });
  const newer = await library.list({
    section: "timeline",
    timelineSince: boundary,
    includeTotal: false,
  });
  assert.deepEqual(
    older.items.map(({ id }) => id),
    ["heic", "audio", "archive"],
  );
  assert.deepEqual(
    newer.items.map(({ id }) => id),
    ["video", "photo"],
  );
  const lookup = requests.at(-1);
  assert.doesNotMatch(lookup.sql, /COUNT|OFFSET/i);
  const plan = sqlite
    .prepare(`EXPLAIN QUERY PLAN ${lookup.sql}`)
    .all(...lookup.params);
  assert.ok(
    plan.some(({ detail }) => detail.includes("jr_media_capture_date")),
  );
  assert.ok(plan.every(({ detail }) => !detail.includes("TEMP B-TREE")));
  const photos = await library.list({ section: "photos", includeTotal: false });
  assert.deepEqual(
    photos.items.map(({ id }) => id),
    ["photo", "video", "heic", "archive"],
  );
  assert.deepEqual(
    catalogListing({ section: "photos" }, library.id).cursor(
      photos.items.at(-1),
    ),
    {
      id: "archive",
      value: captureDate,
    },
  );
  const all = await library.list({ section: "all", includeTotal: false });
  assert.equal(all.items[0].id, "archive");

  for (const section of ["timeline", "photos"]) {
    const onlyPhotos = await library.list({
      section,
      mediaKind: "photo",
      includeTotal: false,
    });
    assert.deepEqual(
      onlyPhotos.items.map(({ id }) => id),
      ["photo", "heic", "archive"],
    );
    const onlyVideo = await library.list({
      section,
      mediaKind: "video",
      includeTotal: false,
    });
    assert.deepEqual(
      onlyVideo.items.map(({ id }) => id),
      ["video"],
    );
    const videoQuery = requests.at(-1);
    const videoPlan = sqlite
      .prepare(`EXPLAIN QUERY PLAN ${videoQuery.sql}`)
      .all(...videoQuery.params);
    assert.ok(
      videoPlan.some(({ detail }) => detail.includes("jr_video_capture_date")),
    );
  }
  const beforeVideos = await library.list({
    section: "timeline",
    mediaKind: "video",
    timelineBefore: boundary,
  });
  assert.deepEqual(beforeVideos.items, []);
  const sincePhotos = await library.list({
    section: "timeline",
    mediaKind: "photo",
    timelineSince: boundary,
  });
  assert.deepEqual(
    sincePhotos.items.map(({ id }) => id),
    ["photo"],
  );

  const directory = await mkdtemp(path.join(os.tmpdir(), "jr-media-filter-"));
  library.enableCatalogCache(path.join(directory, "catalog.sqlite"));
  t.after(async () => {
    library.catalog.close();
    await rm(directory, { recursive: true, force: true });
  });
  const videoDate = "2021-04-08T12:00:00.000Z";
  assert.deepEqual(await library.timelineBounds("video"), {
    oldest: videoDate,
    newest: videoDate,
  });
  assert.deepEqual(await library.timelineBounds("photo"), {
    oldest: captureDate,
    newest: "2026-02-01T12:00:00.000Z",
  });
  assert.deepEqual(await library.timelineBounds(), {
    oldest: captureDate,
    newest: "2026-02-01T12:00:00.000Z",
  });
  const cachedAll = await library.list({ section: "timeline" });
  assert.ok(cachedAll.items.some(({ id }) => id === "audio"));
  const cachedVideo = await library.list({
    section: "timeline",
    mediaKind: "video",
  });
  assert.deepEqual(
    cachedVideo.items.map(({ id }) => id),
    ["video"],
  );
  const requestCount = requests.length;
  assert.deepEqual(await library.timelineBounds("video"), {
    oldest: videoDate,
    newest: videoDate,
  });
  assert.equal(requests.length, requestCount);
});

test("catalog cache persists pages and reconciles updates, moves and deletions by revision", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jr-catalog-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, "catalog.sqlite");
  const { library, insert, requests, sqlite, db } = fixture(t);
  await library.initialize();
  const album = await library.createFolder("Album");
  for (let index = 1; index <= 180; index++) {
    insert(`file-${String(index).padStart(3, "0")}`);
  }
  library.enableCatalogCache(filename);
  t.after(() => library.close());
  const first = await library.list({ includeTotal: false });
  assert.equal(first.items[0].id, "file-180");
  assert.equal(first.items.at(-1).id, "file-101");
  assert.equal(first.hasMore, true);
  assert.deepEqual(
    (await library.cachedFolders()).map((folder) => folder.id),
    [album.id],
  );
  await library.cachedStats();

  requests.length = 0;
  assert.deepEqual(await library.list({ includeTotal: false }), first);
  await library.cachedFolders();
  await library.cachedStats();
  assert.equal(requests.length, 0);

  library.close();
  library.enableCatalogCache(filename);
  assert.deepEqual(await library.list({ includeTotal: false }), first);
  await library.cachedFolders();
  await library.cachedStats();
  assert.equal(
    requests.filter(({ sql }) => /SELECT \* FROM jr_files/i.test(sql)).length,
    0,
  );
  assert.equal(
    requests.filter(({ sql }) => /SELECT revision, token/.test(sql)).length,
    2,
  );

  requests.length = 0;
  const second = await library.list({ page: 2, includeTotal: false });
  assert.equal(second.items[0].id, "file-100");
  assert.equal(second.items.at(-1).id, "file-021");
  assert.equal(requests.length, 1);
  assert.match(requests[0].sql, /\(created_at, id\) < \(\?, \?\)/);
  assert.doesNotMatch(requests[0].sql, /OFFSET|COUNT/i);
  assert.equal(requests[0].params.at(-1), 80);
  const plan = sqlite
    .prepare(`EXPLAIN QUERY PLAN ${requests[0].sql}`)
    .all(...requests[0].params);
  assert.ok(
    plan.some(({ detail }) => detail.includes("jr_active_folder_date")),
  );
  assert.ok(plan.every(({ detail }) => !detail.includes("TEMP B-TREE")));

  // Simulate another client, including two updates with no updated_at change.
  sqlite
    .prepare("UPDATE jr_files SET name = ? WHERE id = ?")
    .run("first name", "file-180");
  sqlite
    .prepare("UPDATE jr_files SET name = ? WHERE id = ?")
    .run("final name", "file-180");
  sqlite
    .prepare("UPDATE jr_files SET folder_id = ? WHERE id = ?")
    .run(album.id, "file-179");
  sqlite.prepare("DELETE FROM jr_files WHERE id = ?").run("file-178");
  sqlite
    .prepare("UPDATE jr_folders SET name = ? WHERE id = ?")
    .run("Updated album", album.id);
  insert("file-181");
  library.catalog.invalidate();
  requests.length = 0;
  const changed = await library.list({ includeTotal: false });
  assert.deepEqual(
    changed.items.slice(0, 3).map(({ id }) => id),
    ["file-181", "file-180", "file-177"],
  );
  assert.equal(changed.items[1].name, "final name");
  assert.equal(changed.items[1].updated_at, first.items[0].updated_at);
  assert.equal(requests.length, 3);
  assert.match(requests[0].sql, /SELECT revision, token/);
  assert.match(requests[1].sql, /revision > \?/);
  assert.equal((await library.cachedFolders())[0].name, "Updated album");

  const all = await library.list({ throughPage: 3, includeTotal: false });
  assert.equal(all.hasMore, false);
  assert.equal(all.items.length, 179);
  requests.length = 0;
  const searched = await library.list({
    search: "final name",
    sort: "name",
    includeTotal: false,
  });
  assert.equal(searched.items[0].id, "file-180");
  assert.equal(requests.length, 1);
  assert.match(requests[0].sql, /SELECT revision, token/);
  const moved = await library.list({ folderId: album.id, includeTotal: false });
  assert.deepEqual(
    moved.items.map(({ id }) => id),
    ["file-179"],
  );

  // An exhausted D1 quota still permits browsing data already on disk.
  db.request = async () => {
    throw new Error("D1 row read limit exceeded");
  };
  library.catalog.invalidate();
  assert.deepEqual(
    await library.list({ throughPage: 3, includeTotal: false }),
    all,
  );
  assert.deepEqual(
    await library.list({ folderId: album.id, includeTotal: false }),
    moved,
  );
  await assert.rejects(
    library.list({ section: "trash", includeTotal: false }),
    /D1 row read limit exceeded/,
  );
});

test("catalog checks only the open folder and requested ranges, then validates a different view on navigation", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jr-catalog-scope-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { library, insert, requests, sqlite } = fixture(t);
  await library.initialize();
  const first = await library.createFolder("First");
  const second = await library.createFolder("Second");
  const third = await library.createFolder("Third");
  for (let i = 1; i <= 165; i++) {
    insert(`first-${String(i).padStart(3, "0")}`, { folder: first.id });
  }
  insert("second-file", { folder: second.id });
  library.enableCatalogCache(path.join(dir, "catalog.sqlite"));
  t.after(() => library.close());
  const list = (folder, page = 1) =>
    library.list({ folderId: folder.id, page, includeTotal: false });
  await list(first, 2);
  await list(second);

  const rename = sqlite.prepare("UPDATE jr_files SET name = ? WHERE id = ?");
  rename.run("changed in second", "second-file");
  library.catalog.invalidate();
  requests.length = 0;
  await list(first);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].params, [library.id, `folder:${first.id}`]);
  const plan = sqlite
    .prepare(`EXPLAIN QUERY PLAN ${requests[0].sql}`)
    .all(...requests[0].params);
  assert.ok(plan.some(({ detail }) => detail.includes("jr_change_by_scope")));

  rename.run("changed on first page", "first-164");
  rename.run("changed on second page", "first-040");
  library.catalog.invalidate();
  requests.length = 0;
  const top = await list(first);
  assert.equal(
    top.items.find(({ id }) => id === "first-164").name,
    "changed on first page",
  );
  assert.equal(requests.length, 2);
  assert.ok(
    requests.every(({ params }) => !params.includes(`folder:${second.id}`)),
  );
  const deltaPlan = sqlite
    .prepare(`EXPLAIN QUERY PLAN ${requests[1].sql}`)
    .all(...requests[1].params);
  assert.ok(
    deltaPlan.some(({ detail }) => detail.includes("jr_change_by_scope")),
  );
  const cachedName = library.catalog.local.prepare(
    "SELECT name FROM jr_files WHERE id = ?",
  );
  assert.equal(cachedName.get("first-040").name, "first-040.jpg");
  assert.equal(cachedName.get("second-file").name, "second-file.jpg");
  assert.equal(
    (await list(first, 2)).items.find(({ id }) => id === "first-040").name,
    "changed on second page",
  );

  requests.length = 0;
  assert.equal((await list(second)).items[0].name, "changed in second");
  assert.equal(requests.length, 2);
  assert.ok(
    requests.every(({ params }) => params[1] === `folder:${second.id}`),
  );

  const move = sqlite.prepare("UPDATE jr_files SET folder_id = ? WHERE id = ?");
  move.run(third.id, "second-file");
  move.run(first.id, "second-file");
  assert.equal((await list(first)).items[0].id, "second-file");
  assert.deepEqual((await list(second)).items, []);
});

test("bulk metadata and trash restoration preserve object keys and isolate libraries", async (t) => {
  const { library, insert } = fixture(t);
  await library.initialize();
  insert("one");
  insert("foreign", { scope: "other-bucket" });
  const folder = await library.createFolder("Destination");
  await library.updateFiles(["one", "foreign"], {
    folderId: folder.id,
    favorite: true,
    tags: ["a", "a", "b"],
    adjustments: { brightness: 120 },
    trashed: true,
  });
  const file = await library.file("one");
  assert.deepEqual(file.tags, ["a", "b"]);
  assert.equal(file.adjustments.brightness, 120);
  assert.equal(file.object_key, "objects/one");
  assert.equal(file.folder_id, folder.id);
  assert.equal((await library.list({ section: "all" })).total, 0);
  await library.updateFiles(["one"], { trashed: false, name: "Renamed.jpg" });
  assert.equal(
    (await library.list({ section: "all" })).items[0].name,
    "Renamed.jpg",
  );
  await assert.rejects(library.file("foreign"), /не найден/);
  await assert.rejects(
    library.updateFiles(["one"], { adjustments: { brightness: Number.NaN } }),
    /Некорректные/,
  );
  assert.deepEqual(await library.stats(), {
    files: 1,
    bytes: 1024,
    trashed: 0,
    tags: ["a", "b"],
  });
});

test("image edits round-trip all controls and reject saves against a replaced original", async (t) => {
  const { library, insert, sqlite } = fixture(t);
  await library.initialize();
  insert("edited");
  const adjustments = {
    temperature: 30,
    exposure: 20,
    flipX: true,
    cropX: 0.1,
    cropWidth: 0.8,
    stretchAmount: 25,
    strokes: [{ x: 0.4, y: 0.5, dx: 0.1, dy: 0, radius: 0.2, strength: 0.5 }],
  };
  await library.updateFiles(["edited"], {
    adjustments,
    expectedObjectKey: "objects/edited",
  });
  let file = await library.file("edited");
  assert.equal(file.adjustments.temperature, 30);
  assert.deepEqual(file.adjustments.strokes, adjustments.strokes);
  sqlite
    .prepare("UPDATE jr_files SET object_key = ? WHERE id = ?")
    .run("replacement", "edited");
  await assert.rejects(
    library.updateFiles(["edited"], {
      adjustments: { temperature: -50 },
      expectedObjectKey: "objects/edited",
    }),
    /Изображение изменилось/,
  );
  file = await library.file("edited");
  assert.equal(file.adjustments.temperature, 30);
  assert.equal(file.object_key, "replacement");
});

test("photo duplication copies the object, tags and edits to an independent file in the same folder", async (t) => {
  const { library, insert, deleted } = fixture(t);
  await library.initialize();
  const folder = await library.createFolder("Photos");
  insert("sea # день", {
    folder: folder.id,
    name: "Море.jpg",
    tags: ["отпуск"],
    favorite: 1,
    captured: captureDate,
  });
  insert("existing", { folder: folder.id, name: "Море (1).jpg" });
  const original = await library.file("sea # день");
  await library.updateFiles([original.id], {
    adjustments: { temperature: 25 },
  });
  const uploads = [];
  library.s3.send = async (command) => {
    if (command.constructor.name === "CopyObjectCommand")
      uploads.push(command.input);
    if (command.constructor.name === "DeleteObjectCommand")
      deleted.push(command.input.Key);
    return {};
  };
  const copy = await library.duplicatePhoto(original.id, original.object_key);
  assert.equal(copy.name, "Море (2).jpg");
  assert.equal(copy.folder_id, folder.id);
  assert.equal(copy.mime_type, original.mime_type);
  assert.equal(copy.size_bytes, original.size_bytes);
  assert.deepEqual(copy.tags, original.tags);
  assert.equal(copy.favorite, original.favorite);
  assert.equal(copy.captured_at, captureDate);
  assert.equal(copy.adjustments.temperature, 25);
  assert.notEqual(copy.id, original.id);
  assert.notEqual(copy.object_key, original.object_key);
  assert.deepEqual(uploads, [
    {
      Bucket: config.bucket,
      Key: copy.object_key,
      CopySource: "test-drive/objects/sea%20%23%20%D0%B4%D0%B5%D0%BD%D1%8C",
    },
  ]);
  await library.updateFiles([copy.id], {
    adjustments: { temperature: -10 },
    tags: [],
  });
  assert.equal((await library.file(original.id)).adjustments.temperature, 25);
  assert.deepEqual((await library.file(original.id)).tags, ["отпуск"]);
  assert.deepEqual(deleted, []);
});

test("photo duplication discards only the copied object if the source changes before the catalog write", async (t) => {
  const { library, insert, sqlite, deleted } = fixture(t);
  await library.initialize();
  insert("photo");
  let copied;
  library.s3.send = async (command) => {
    if (command.constructor.name === "CopyObjectCommand") {
      copied = command.input.Key;
      sqlite
        .prepare("UPDATE jr_files SET object_key = ? WHERE id = ?")
        .run("replacement", "photo");
    } else if (command.constructor.name === "DeleteObjectCommand") {
      deleted.push(command.input.Key);
    }
    return {};
  };
  await assert.rejects(
    library.duplicatePhoto("photo", "objects/photo"),
    /Изображение изменилось/,
  );
  assert.deepEqual(deleted, [copied]);
  assert.equal((await library.file("photo")).object_key, "replacement");
  assert.equal((await library.list({ section: "all" })).items.length, 1);
});

test("video frames create distinct PNG files in the video's folder without changing the original", async (t) => {
  const uploads = [],
    paths = [];
  const { library, insert } = fixture(t, {
    createUpload: ({ params }) => ({
      on() {},
      async done() {
        paths.push(params.Body.path);
        const chunks = [];
        for await (const chunk of params.Body) chunks.push(chunk);
        uploads.push({ ...params, Body: Buffer.concat(chunks) });
      },
    }),
  });
  await library.initialize();
  const folder = await library.createFolder("Movies");
  insert("video", {
    name: "Holiday.mp4",
    mime: "video/mp4",
    folder: folder.id,
  });
  insert("foreign", { mime: "video/mp4", scope: "another-library" });
  insert("photo");
  const png = new Uint8Array(
    await readFile(new URL("fixtures/editor.png", import.meta.url)),
  );
  const first = await library.saveVideoFrame(
    "video",
    "objects/video",
    1.25,
    png,
  );
  const second = await library.saveVideoFrame(
    "video",
    "objects/video",
    1.25,
    png,
  );
  assert.equal(first.mime_type, "image/png");
  assert.equal(first.folder_id, folder.id);
  assert.equal(first.name, "Holiday-frame-00-00-01.250.png");
  assert.equal(second.name, "Holiday-frame-00-00-01.250 (1).png");
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.object_key, second.object_key);
  assert.equal((await library.file("video")).object_key, "objects/video");
  assert.equal(uploads[0].ContentType, "image/png");
  assert.deepEqual(new Uint8Array(uploads[0].Body), png);
  for (const file of paths)
    await assert.rejects(stat(file), { code: "ENOENT" });
  await assert.rejects(
    library.saveVideoFrame("video", "stale-version", 0, png),
    /Видео изменилось/,
  );
  await assert.rejects(
    library.saveVideoFrame("photo", "objects/photo", 0, png),
    /Выберите видео/,
  );
  await assert.rejects(
    library.saveVideoFrame("foreign", "objects/foreign", 0, png),
    /не найден/,
  );
  assert.equal(uploads.length, 2);
});

test("failed video frame metadata writes roll back the new object and clean temporary PNGs", async (t) => {
  const paths = [];
  const { library, insert, db, deleted } = fixture(t, {
    createUpload: ({ params }) => ({
      on() {},
      async done() {
        paths.push(params.Body.path);
        for await (const _ of params.Body) {
        }
      },
    }),
  });
  await library.initialize();
  insert("video", { mime: "video/mp4" });
  const query = db.query.bind(db);
  db.query = async (sql, params) => {
    if (sql.startsWith("INSERT INTO jr_files"))
      throw new Error("D1 unavailable");
    return query(sql, params);
  };
  const png = new Uint8Array(
    await readFile(new URL("fixtures/editor.png", import.meta.url)),
  );
  await assert.rejects(
    library.saveVideoFrame("video", "objects/video", 0, png),
    /D1 unavailable/,
  );
  assert.equal(deleted.length, 1);
  assert.notEqual(deleted[0], "objects/video");
  for (const file of paths)
    await assert.rejects(stat(file), { code: "ENOENT" });
  assert.equal((await library.file("video")).object_key, "objects/video");
});

test("image source reads private R2 bytes with size limits and library isolation", async (t) => {
  let destroyed = 0,
    requested = 0,
    oversized = false;
  const body = () => ({
    async *[Symbol.asyncIterator]() {
      yield oversized
        ? { length: 64 * 1024 * 1024 + 1 }
        : Buffer.from([1, 2, 3]);
    },
    destroy() {
      destroyed++;
    },
  });
  const { library, insert } = fixture(t, {
    s3: {
      async send(command) {
        requested++;
        assert.equal(command.constructor.name, "GetObjectCommand");
        return { Body: body() };
      },
      destroy() {},
    },
  });
  await library.initialize();
  insert("photo");
  insert("foreign", { scope: "other-library" });
  insert("video", { mime: "video/mp4" });
  insert("large", { size: 65 * 1024 * 1024 });
  assert.deepEqual(await library.imageSource("photo"), {
    data: new Uint8Array([1, 2, 3]),
    mimeType: "image/jpeg",
  });
  await assert.rejects(library.imageSource("foreign"), /не найден/);
  await assert.rejects(library.imageSource("video"), /Выберите изображение/);
  await assert.rejects(library.imageSource("large"), /64 МБ/);
  assert.equal(requested, 1);
  oversized = true;
  await assert.rejects(library.imageSource("photo"), /64 МБ/);
  assert.equal(destroyed, 2);
});

test("permanent deletion refuses active files and keeps records when R2 fails", async (t) => {
  const { library, insert, deleted } = fixture(t);
  await library.initialize();
  insert("one");
  await assert.rejects(library.deletePermanently(["one"]), /Сначала/);
  await library.updateFiles(["one"], { trashed: true });
  const send = library.s3.send;
  library.s3.send = async () => {
    throw new Error("R2 offline");
  };
  await assert.rejects(library.deletePermanently(["one"]), /offline/);
  assert.equal((await library.file("one")).id, "one");
  library.s3.send = send;
  await library.deletePermanently(["one"]);
  assert.deepEqual(deleted, ["objects/one"]);
  await assert.rejects(library.file("one"), /не найден/);
});

test("upload removes orphan on definite D1 failure but keeps an object after ambiguous timeout", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jr-upload-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "photo.jpg");
  await writeFile(source, "image data");
  const createUpload = (options) => ({
    on() {},
    async done() {
      options.params.Body.destroy();
    },
  });
  const { library, deleted, db } = fixture(t, { createUpload });
  await library.initialize();
  const query = db.query.bind(db);
  db.query = async (sql, params) => {
    if (sql.startsWith("INSERT INTO jr_files"))
      throw new Error("D1 unavailable");
    return query(sql, params);
  };
  await assert.rejects(library.uploadFile(source, null), /D1 unavailable/);
  assert.equal(deleted.length, 1);
  db.query = async () => {
    throw new Error("timeout");
  };
  await assert.rejects(
    library.uploadFile(source, null),
    /Объект сохранён в R2/,
  );
  assert.equal(deleted.length, 1);
});

test("upload recognizes a committed INSERT after a lost D1 response", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jr-commit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "photo.jpg");
  await writeFile(source, "data");
  const { library, db, deleted } = fixture(t, {
    createUpload: (options) => ({
      on() {},
      async done() {
        options.params.Body.destroy();
      },
    }),
  });
  await library.initialize();
  const query = db.query.bind(db);
  db.query = async (sql, params) => {
    const result = await query(sql, params);
    if (sql.startsWith("INSERT INTO jr_files"))
      throw new Error("connection lost");
    return result;
  };
  const result = await library.uploadFile(source, null);
  assert.equal((await library.file(result.id)).name, "photo.jpg");
  assert.equal(deleted.length, 0);
});

test("R2 indexing paginates and does not duplicate or change metadata", async (t) => {
  let calls = 0;
  const { library } = fixture(t, {
    s3: {
      send: async (command) => {
        calls++;
        assert.equal(command.input.Prefix, "jellyree/");
        return {
          Contents: [{ Key: "jellyree/existing.jpg", Size: 80 }],
          IsTruncated: calls === 1,
          NextContinuationToken: calls === 1 ? "next" : undefined,
        };
      },
      destroy() {},
    },
  });
  await library.initialize();
  await library.importBucket();
  const { items } = await library.list();
  assert.equal(items.length, 1);
  await library.updateFiles([items[0].id], {
    name: "Custom name",
    tags: ["keep"],
  });
  await library.importBucket();
  assert.equal((await library.list()).items[0].name, "Custom name");
  assert.deepEqual((await library.list()).items[0].tags, ["keep"]);
});

test("credentials are encrypted and session changes preserve the saved profile while the keychain is unavailable", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jr-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const safe = {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptStringAsync: async (value) => Buffer.from(value).reverse(),
    decryptStringAsync: async (value) => ({
      result: Buffer.from(value).reverse().toString(),
    }),
  };
  const store = new ConfigStore(dir, safe);
  await store.save(config);
  assert.equal(store.summary().persisted, true);
  assert.equal("apiToken" in store.summary(), false);
  assert.equal("accessKeyId" in store.summary(), false);
  const filename = path.join(dir, "connection.enc");
  const encrypted = await readFile(filename);
  assert.equal(encrypted.toString().includes(config.apiToken), false);
  const next = new ConfigStore(dir, safe);
  await next.load();
  assert.deepEqual(next.current, config);
  assert.equal(
    next.merge({ ...config, apiToken: "" }).apiToken,
    config.apiToken,
  );
  safe.isAsyncEncryptionAvailable = async () => false;
  await next.save({ ...config, apiToken: "only-in-memory" });
  assert.equal(next.summary().persisted, false);
  assert.deepEqual(await readFile(filename), encrypted);
  await next.clear();
  assert.equal(next.summary().configured, false);
  await assert.rejects(readFile(filename), { code: "ENOENT" });
});

test("connection profiles migrate legacy credentials, isolate edits, persist selection and remove independently", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jr-profiles-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let unlocked = true;
  const encrypt = async (value) => Buffer.from(value).reverse();
  const safe = {
    isAsyncEncryptionAvailable: async () => unlocked,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptStringAsync: encrypt,
    decryptStringAsync: async (value) => ({
      result: Buffer.from(value).reverse().toString(),
    }),
  };
  const filename = path.join(dir, "connection.enc");
  await writeFile(filename, await encrypt(JSON.stringify(config)));
  const store = new ConfigStore(dir, safe);
  const legacy = await store.load();
  assert.equal(legacy.profiles.length, 1);
  assert.equal(legacy.profiles[0].name, config.bucket);
  assert.deepEqual(store.current, config);
  const firstId = legacy.activeProfileId;
  const other = normalizeConfig({
    ...config,
    databaseId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
    apiToken: "another-private-token",
    bucket: "other-bucket",
    accessKeyId: "other-r2-access",
    secretAccessKey: "other-r2-secret",
  });
  assert.throws(
    () => store.merge({ ...other, profileId: null, apiToken: "" }),
    /apiToken/,
  );
  const created = await store.save(store.merge({ ...other, profileId: null }), {
    profileId: null,
    name: "Archive",
  });
  const secondId = created.activeProfileId;
  assert.notEqual(firstId, secondId);
  assert.equal(created.profiles.length, 2);
  assert.equal(
    store.merge({
      ...config,
      profileId: firstId,
      apiToken: "",
      accessKeyId: "",
    }).apiToken,
    config.apiToken,
  );
  assert.equal(
    store.merge({ ...other, profileId: secondId, apiToken: "" }).apiToken,
    other.apiToken,
  );
  assert.equal(
    store
      .redact(`${config.apiToken}: ${other.secretAccessKey}`)
      .includes(other.secretAccessKey),
    false,
  );
  for (const profile of created.profiles) {
    assert.equal("apiToken" in profile, false);
    assert.equal("secretAccessKey" in profile, false);
  }
  assert.deepEqual(store.current, other);
  safe.encryptStringAsync = async () => {
    throw new Error("Keychain error");
  };
  await assert.rejects(store.select(firstId), /Keychain error/);
  assert.equal(store.activeId, secondId);
  safe.encryptStringAsync = encrypt;
  await store.select(firstId);
  const restarted = new ConfigStore(dir, safe);
  assert.equal((await restarted.load()).activeProfileId, firstId);
  assert.deepEqual(restarted.current, config);
  assert.equal(restarted.summary().profiles.length, 2);
  const beforeLock = await readFile(filename);
  unlocked = false;
  await assert.rejects(restarted.clear(secondId));
  assert.deepEqual(await readFile(filename), beforeLock);
  const locked = new ConfigStore(dir, safe);
  await assert.rejects(locked.load());
  await locked.save(other, { profileId: null, name: "Session only" });
  assert.equal(locked.summary().persisted, false);
  await locked.clear();
  assert.deepEqual(await readFile(filename), beforeLock);
  unlocked = true;
  assert.equal((await restarted.clear(firstId)).activeProfileId, secondId);
  assert.deepEqual(restarted.current, other);
  await restarted.clear(secondId);
  assert.equal(restarted.summary().configured, false);
  await assert.rejects(readFile(filename), { code: "ENOENT" });
});

test("configuration validates endpoints indirectly and namespaces each bucket/prefix", () => {
  assert.throws(() =>
    normalizeConfig({ ...config, accountId: "http://attacker.test" }),
  );
  assert.throws(() => normalizeConfig({ ...config, prefix: "../other" }));
  assert.equal(
    normalizeConfig({ ...config, prefix: "/photos/" }).prefix,
    "photos",
  );
  assert.notEqual(libraryId(config), libraryId({ ...config, bucket: "other" }));
  assert.notEqual(libraryId(config), libraryId({ ...config, prefix: "other" }));
});

test("upload collisions: skip all applies only to this batch and counts every duplicate", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jr-skip-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { mkdir } = await import("node:fs/promises");
  for (const sub of ["a", "b"]) {
    await mkdir(path.join(dir, sub));
    await writeFile(path.join(dir, sub, "one.jpg"), "new");
  }
  let uploads = 0,
    prompts = 0;
  const { library, insert } = fixture(t, {
    createUpload: () => {
      uploads++;
      throw new Error("must skip");
    },
  });
  await library.initialize();
  insert("one");
  const result = await library.uploadPaths(
    ["a", "b"].map((sub) => path.join(dir, sub, "one.jpg")),
    null,
    () => {},
    async (info) => {
      prompts++;
      assert.equal(info.remaining, 2);
      assert.equal(info.total, 2);
      return { action: "skip", applyToAll: true };
    },
  );
  assert.equal(prompts, 1);
  assert.equal(uploads, 0);
  assert.equal(result.skipped, 2);
  assert.equal(result.done, 0);
  assert.equal(result.failures.length, 0);
  await library.uploadPaths(
    [path.join(dir, "a", "one.jpg")],
    null,
    () => {},
    async () => {
      prompts++;
      return { action: "skip" };
    },
  );
  assert.equal(prompts, 2);
});

test("upload collisions: rename reserves names from existing files and the entire incoming batch", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jr-rename-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { mkdir } = await import("node:fs/promises");
  for (const sub of ["a", "b"]) {
    await mkdir(path.join(dir, sub));
    await writeFile(path.join(dir, sub, "one.jpg"), "new");
  }
  await writeFile(path.join(dir, "one (2).jpg"), "new");
  const { library, insert } = fixture(t, {
    createUpload: (options) => ({
      on() {},
      async done() {
        options.params.Body.destroy();
      },
    }),
  });
  await library.initialize();
  insert("one");
  insert("numbered", { name: "one (1).jpg" });
  let prompts = 0;
  const result = await library.uploadPaths(
    [
      path.join(dir, "a", "one.jpg"),
      path.join(dir, "b", "one.jpg"),
      path.join(dir, "one (2).jpg"),
    ],
    null,
    () => {},
    async (info) => {
      prompts++;
      assert.equal(info.suggestedName, "one (3).jpg");
      return { action: "rename", applyToAll: true };
    },
  );
  assert.equal(result.done, 3);
  assert.equal(prompts, 1);
  assert.equal(result.failures.length, 0);
  const names = (await library.list()).items.map((f) => f.name).sort();
  assert.deepEqual(names, [
    "one (1).jpg",
    "one (2).jpg",
    "one (3).jpg",
    "one (4).jpg",
    "one.jpg",
  ]);
});

test("upload replacement preserves metadata and deletes old bytes only after D1 points to the new object", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jr-replace-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "one.jpg");
  await writeFile(source, "replacement");
  const { library, insert, sqlite, deleted } = fixture(t, {
    createUpload: (options) => ({
      on() {},
      async done() {
        options.params.Body.destroy();
      },
    }),
  });
  await library.initialize();
  insert("one", { favorite: 1, tags: ["keep"], captured: captureDate });
  sqlite
    .prepare("UPDATE jr_files SET adjustments = ? WHERE id = ?")
    .run(JSON.stringify({ rotate: 90 }), "one");
  const result = await library.uploadPaths(
    [source],
    null,
    () => {},
    async () => ({ action: "replace" }),
  );
  const current = await library.file("one");
  assert.equal(result.done, 1);
  assert.equal((await library.list()).total, 1);
  assert.equal(current.favorite, true);
  assert.deepEqual(current.tags, ["keep"]);
  assert.deepEqual(current.adjustments, {});
  assert.equal(current.created_at, "2026-01-01");
  assert.equal(current.captured_at, null);
  assert.equal(current.size_bytes, 11);
  assert.notEqual(current.object_key, "objects/one");
  assert.deepEqual(deleted, ["objects/one"]);
});

test("failed replacement keeps the original file and rolls back only the new R2 object", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jr-replace-fail-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "one.jpg");
  await writeFile(source, "replacement");
  const { library, insert, db, deleted } = fixture(t, {
    createUpload: (options) => ({
      on() {},
      async done() {
        options.params.Body.destroy();
      },
    }),
  });
  await library.initialize();
  insert("one");
  const query = db.query.bind(db);
  db.query = async (sql, params) => {
    if (sql.startsWith("UPDATE jr_files SET object_key"))
      throw new Error("D1 write failed");
    return query(sql, params);
  };
  await assert.rejects(
    library.uploadFile(source, null, () => {}, { replaceId: "one" }),
    /D1 write failed/,
  );
  assert.equal((await library.file("one")).object_key, "objects/one");
  assert.equal(deleted.length, 1);
  assert.notEqual(deleted[0], "objects/one");
});

test("a lost replacement response is verified before cleaning up the previous object", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jr-replace-commit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "one.jpg");
  await writeFile(source, "replacement");
  const { library, insert, db, deleted } = fixture(t, {
    createUpload: (options) => ({
      on() {},
      async done() {
        options.params.Body.destroy();
      },
    }),
  });
  await library.initialize();
  insert("one");
  const query = db.query.bind(db);
  db.query = async (sql, params) => {
    const rows = await query(sql, params);
    if (sql.startsWith("UPDATE jr_files SET object_key"))
      throw new Error("response lost");
    return rows;
  };
  await library.uploadFile(source, null, () => {}, { replaceId: "one" });
  assert.notEqual((await library.file("one")).object_key, "objects/one");
  assert.deepEqual(deleted, ["objects/one"]);
});

test("names in different folders do not conflict, while duplicate incoming basenames do", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jr-folders-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { mkdir } = await import("node:fs/promises");
  for (const sub of ["a", "b"]) {
    await mkdir(path.join(dir, sub));
    await writeFile(path.join(dir, sub, "same.txt"), sub);
  }
  const { library } = fixture(t, {
    createUpload: (options) => ({
      on() {},
      async done() {
        options.params.Body.destroy();
      },
    }),
  });
  await library.initialize();
  let prompts = 0;
  const result = await library.uploadPaths(
    [path.join(dir, "a"), path.join(dir, "b")],
    null,
    () => {},
    async () => {
      throw new Error("different folders");
    },
  );
  assert.equal(result.done, 2);
  assert.equal(result.failures.length, 0);
  const flat = await library.uploadPaths(
    [path.join(dir, "a", "same.txt"), path.join(dir, "b", "same.txt")],
    null,
    () => {},
    async (info) => {
      prompts++;
      assert.equal(info.remaining, 1);
      return { action: "rename" };
    },
  );
  assert.equal(flat.done, 2);
  assert.equal(prompts, 1);
});

test("retry uses the original source and destination for each failed upload", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jr-retry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const sub of ["a", "b", "c"]) {
    await mkdir(path.join(dir, sub));
    await writeFile(path.join(dir, sub, "same.txt"), sub);
  }
  const { library } = fixture(t);
  await library.initialize();
  const target = await library.createFolder("Target");
  const boundUploadFile = library.uploadFile.bind(library);
  const attempts = [];
  library.uploadFile = async (source, folder, report, options) => {
    const sub = path.basename(path.dirname(source));
    attempts.push({ sub, folder, name: options.name });
    if (
      attempts.filter((attempt) => attempt.sub === sub).length === 1 &&
      sub !== "a"
    )
      throw new Error("Network interrupted");
    return boundUploadFile(source, folder, report, options);
  };
  library.createUpload = ({ params }) => ({
    on() {},
    async done() {
      params.Body.destroy();
    },
  });
  const result = await library.uploadPaths(
    ["a", "b", "c"].map((sub) => path.join(dir, sub)),
    target.id,
  );
  assert.equal(result.done, 1);
  const [b, c] = result.failures;
  assert.equal(b.fileIndex, 1);
  assert.equal(c.fileIndex, 2);
  assert.notEqual(b.retryId, c.retryId);
  assert.equal(JSON.stringify(result).includes(dir), false);
  await assert.rejects(library.retryUploads([path.join(dir, "a", "same.txt")]));
  const folders = await library.folders();
  const folderB = folders.find((folder) => folder.name === "b");
  const folderC = folders.find((folder) => folder.name === "c");
  assert.equal(folderB.parent_id, target.id);
  assert.equal(folderC.parent_id, target.id);

  const single = await library.retryUploads([c.retryId, c.retryId]);
  assert.equal(single.done, 1);
  assert.deepEqual(single.resolvedRetryIds, [c.retryId]);
  await assert.rejects(library.retryUploads([c.retryId]));

  // Another device may have created a same-name file before the retry.
  await boundUploadFile(path.join(dir, "b", "same.txt"), folderB.id);
  const canceled = await library.retryUploads(
    [b.retryId],
    () => {},
    async () => ({
      action: "cancel",
    }),
  );
  assert.equal(canceled.canceled, true);
  const retried = await library.retryUploads(
    [b.retryId],
    () => {},
    async (info) => {
      assert.equal(info.targetPath, "Target / b");
      return { action: "rename", name: "renamed.txt" };
    },
  );
  assert.equal(retried.done, 1);
  assert.deepEqual(retried.resolvedRetryIds, [b.retryId]);
  assert.deepEqual(
    attempts.map(({ sub }) => sub),
    ["a", "b", "c", "c", "b"],
  );
  assert.deepEqual(attempts.slice(-2), [
    { sub: "c", folder: folderC.id, name: "same.txt" },
    { sub: "b", folder: folderB.id, name: "renamed.txt" },
  ]);
});

test("canceling a duplicate decision stops the remaining batch without changing originals", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jr-cancel-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = path.join(dir, "one.jpg"),
    second = path.join(dir, "two.jpg");
  await writeFile(first, "new");
  await writeFile(second, "new");
  const { library, insert } = fixture(t, {
    createUpload: () => {
      throw new Error("must not upload");
    },
  });
  await library.initialize();
  insert("one");
  const result = await library.uploadPaths(
    [first, second],
    null,
    () => {},
    async () => ({ action: "cancel" }),
  );
  assert.equal(result.canceled, true);
  assert.equal(result.done, 0);
  assert.equal(result.failures.length, 0);
  assert.equal((await library.list()).total, 1);
});

test("uncertain replacement retains both R2 objects until the D1 outcome can be confirmed", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jr-uncertain-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "one.jpg");
  await writeFile(source, "new");
  const { library, insert, db, deleted } = fixture(t, {
    createUpload: (options) => ({
      on() {},
      async done() {
        options.params.Body.destroy();
      },
    }),
  });
  await library.initialize();
  insert("one");
  const query = db.query.bind(db);
  let uncertain = false;
  db.query = async (sql, params) => {
    if (sql.startsWith("UPDATE jr_files SET object_key")) uncertain = true;
    if (uncertain) throw new Error("timeout");
    return query(sql, params);
  };
  await assert.rejects(
    library.uploadFile(source, null, () => {}, { replaceId: "one" }),
    /Объект сохранён в R2/,
  );
  assert.deepEqual(deleted, []);
});

test("a custom duplicate name may omit the extension without losing the source media type", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jr-custom-name-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "one.jpg");
  await writeFile(source, "new");
  const { library, insert } = fixture(t, {
    createUpload: (options) => ({
      on() {},
      async done() {
        options.params.Body.destroy();
      },
    }),
  });
  await library.initialize();
  insert("one");
  const result = await library.uploadPaths(
    [source],
    null,
    () => {},
    async () => ({ action: "rename", name: " Copy " }),
  );
  assert.equal(result.done, 1);
  const copy = (await library.list()).items.find(
    (file) => file.name === "Copy",
  );
  assert.equal(copy.mime_type, "image/jpeg");
});
