import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
