import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, writeFile, rm, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setLanguage } from "../electron/locales.mjs";
setLanguage("ru");
import { Library } from "../electron/library.mjs";
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
      scope: library.id,
      ...options,
    };
    sqlite
      .prepare(
        "INSERT INTO jr_files (id, library_id, folder_id, object_key, name, mime_type, size_bytes, tags, favorite, trashed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
        "2026-01-01",
        "2026-01-01",
      );
  };
  return { library, sqlite, requests, deleted, insert, db };
}

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

test("credentials are encrypted, redacted, reloaded and never persisted using basic_text", async (t) => {
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
  const { readFile } = await import("node:fs/promises");
  assert.equal(
    (await readFile(path.join(dir, "connection.enc"), "utf8")).includes(
      config.apiToken,
    ),
    false,
  );
  const next = new ConfigStore(dir, safe);
  await next.load();
  assert.deepEqual(next.current, config);
  assert.equal(
    next.merge({ ...config, apiToken: "" }).apiToken,
    config.apiToken,
  );
  safe.isAsyncEncryptionAvailable = async () => false;
  await next.save(config);
  assert.equal(next.summary().persisted, false);
  await assert.rejects(readFile(path.join(dir, "connection.enc")), {
    code: "ENOENT",
  });
  await next.clear();
  assert.equal(next.summary().configured, false);
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
  insert("one", { favorite: 1, tags: ["keep"] });
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
