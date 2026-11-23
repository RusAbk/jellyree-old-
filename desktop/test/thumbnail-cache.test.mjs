import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ThumbnailCache, thumbnailKey } from "../electron/thumbnail-cache.mjs";
import { ThumbnailMedia } from "../electron/thumbnail-media.mjs";
const revision = {
  id: "photo",
  objectKey: "objects/one",
  sizeBytes: 200,
  mimeType: "image/jpeg",
  adjustments: {},
};
const entry = {
  width: 600,
  height: 400,
  duration: 0,
  data: new Uint8Array(Buffer.from("RIFF0000WEBPtest bytes for cache")),
};
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jellyree-thumbs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, cache: new ThumbnailCache(directory, options) };
}
test("thumbnail keys track cloud namespace, object version and edits but ignore unrelated file metadata", () => {
  const key = thumbnailKey("library/database", revision);
  assert.equal(key.length, 64);
  assert.equal(
    thumbnailKey("library/database", {
      ...revision,
      favorite: true,
      updatedAt: "later",
      folderId: "other",
      adjustments: { brightness: 100 },
    }),
    key,
  );
  for (const change of [
    { objectKey: "objects/replacement" },
    { sizeBytes: 201 },
    { adjustments: { cropWidth: 0.5 } },
    { adjustments: { brightness: 110 } },
  ])
    assert.notEqual(
      thumbnailKey("library/database", { ...revision, ...change }),
      key,
    );
  assert.notEqual(thumbnailKey("other-library/database", revision), key);
  assert.throws(() =>
    thumbnailKey("library", { ...revision, adjustments: { cropX: 2 } }),
  );
});
test("thumbnail bytes and natural dimensions survive a fresh cache instance", async (t) => {
  const { cache, directory } = await fixture(t),
    key = thumbnailKey("one", revision);
  const miss = await cache.get(key);
  assert.equal(miss.entry, null);
  assert.equal(await cache.put(key, entry, miss.epoch), true);
  const fresh = new ThumbnailCache(directory);
  assert.deepEqual((await fresh.get(key)).entry, entry);
  assert.equal((await fresh.stats()).count, 1);
  assert.ok((await fresh.stats()).bytes > entry.data.length);
});
test("cache uses least recently used eviction and never grows beyond its budget", async (t) => {
  let now = Date.now();
  const { cache } = await fixture(t, { maxBytes: 190, now: () => now++ });
  const keys = [0, 1, 2].map((id) =>
    thumbnailKey("one", { ...revision, id: String(id) }),
  );
  await cache.put(keys[0], entry, 0);
  await cache.put(keys[1], entry, 0);
  await cache.get(keys[0]);
  await cache.put(keys[2], entry, 0);
  assert.ok((await cache.stats()).bytes <= 190);
  assert.equal((await cache.get(keys[1])).entry, null);
  assert.ok((await cache.get(keys[0])).entry);
});
test("clear rejects writes from old generators and corrupt entries are discarded", async (t) => {
  const { cache, directory } = await fixture(t),
    key = thumbnailKey("one", revision);
  const { epoch } = await cache.get(key);
  await cache.clear();
  assert.equal(await cache.put(key, entry, epoch), false);
  const current = await cache.get(key);
  await cache.put(key, entry, current.epoch);
  await writeFile(path.join(directory, `${key}.thumb`), "broken cache entry");
  assert.equal((await cache.get(key)).entry, null);
  assert.equal((await cache.stats()).count, 0);
  await assert.rejects(cache.get("../../connection.enc"));
  await assert.rejects(
    cache.put(key, { ...entry, data: new Uint8Array(20) }, current.epoch),
  );
});
test("local media proxy forwards byte ranges with readable CORS without exposing source URLs", async () => {
  let captured,
    now = 100;
  const media = new ThumbnailMedia(
    async (url, options) => {
      captured = { url, options };
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Range": "bytes 0-2/50",
          "Accept-Ranges": "bytes",
        },
      });
    },
    { now: () => now },
  );
  const url = media.create(
    "https://private.r2.cloudflarestorage.com/signed-secret",
  );
  assert.ok(!url.includes("signed-secret"));
  const result = await media.handle(
    new Request(url, { headers: { Range: "bytes=0-2" } }),
  );
  assert.equal(result.status, 206);
  assert.equal(result.headers.get("access-control-allow-origin"), "*");
  assert.equal(result.headers.get("content-range"), "bytes 0-2/50");
  assert.equal(captured.options.headers.get("range"), "bytes=0-2");
  assert.equal(captured.options.credentials, "omit");
  assert.deepEqual(
    new Uint8Array(await result.arrayBuffer()),
    new Uint8Array([1, 2, 3]),
  );
  now += 51 * 60 * 1000;
  assert.equal((await media.handle(new Request(url))).status, 404);
  assert.equal(
    (await media.handle(new Request("jellyree-media://preview/not-a-token")))
      .status,
    404,
  );
});
