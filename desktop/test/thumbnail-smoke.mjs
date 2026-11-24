import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "@playwright/test";
const directory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const profile = await mkdtemp(path.join(os.tmpdir(), "jellyree-thumbnail-"));
const png = await readFile(path.join(directory, "test/fixtures/editor.png")),
  mp4 = await readFile(path.join(directory, "test/fixtures/preview.mp4"));
let electron;
try {
  electron = await _electron.launch({
    executablePath: process.env.JELLYREE_EXECUTABLE || undefined,
    args: [
      ...(process.env.JELLYREE_EXECUTABLE ? [] : [directory]),
      `--user-data-dir=${profile}`,
    ],
    cwd: directory,
    env: { ...process.env, JELLYREE_DEV_URL: "" },
  });
  const page = await electron.firstWindow();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page
    .getByRole("heading", { name: "Cloudflare connection", exact: true })
    .waitFor();
  await page.evaluate(() =>
    localStorage.setItem("jellyree-desktop-language", "ru"),
  );
  await electron.evaluate(
    ({ ipcMain, protocol }, input) => {
      const require = process
        .getBuiltinModule("module")
        .createRequire(input.module);
      const { ThumbnailCache, thumbnailKey } = require(input.module),
        { ThumbnailMedia } = require(input.media);
      const state = {
        requests: 0,
        sourceCalls: 0,
        imageReads: 0,
        hits: 0,
        files: [
          {
            id: "photo",
            object_key: "photo-v1",
            name: "Cached.png",
            mime_type: "image/png",
            adjustments: {},
          },
          {
            id: "video",
            object_key: "video-v1",
            name: "Cached.mp4",
            mime_type: "video/mp4",
            adjustments: {},
          },
          {
            id: "edited",
            object_key: "edited-v1",
            name: "Edited.png",
            mime_type: "image/png",
            adjustments: { temperature: 30, cropWidth: 0.5, rotate: 45 },
          },
        ].map((file) => ({
          ...file,
          size_bytes: 1000,
          folder_id: null,
          tags: [],
          favorite: false,
          trashed_at: null,
          created_at: "2026-11-24",
          updated_at: "2026-11-24",
        })),
      };
      let cache = new ThumbnailCache(input.cache);
      const media = new ThumbnailMedia(async (url, options) => {
        state.requests++;
        const video = url.endsWith("video"),
          bytes = Buffer.from(video ? input.mp4 : input.png);
        const range = options.headers
          .get("range")
          ?.match(/^bytes=(\d+)-(\d*)$/);
        const start = range ? Number(range[1]) : 0,
          end = range?.[2]
            ? Math.min(bytes.length - 1, Number(range[2]))
            : bytes.length - 1;
        return new Response(bytes.subarray(start, end + 1), {
          status: range ? 206 : 200,
          headers: {
            "Content-Type": video ? "video/mp4" : "image/png",
            "Content-Length": String(end - start + 1),
            "Accept-Ranges": "bytes",
            ...(range
              ? { "Content-Range": `bytes ${start}-${end}/${bytes.length}` }
              : {}),
          },
        });
      });
      protocol.unhandle("jellyree-media");
      protocol.handle("jellyree-media", (request) => media.handle(request));
      const replace = (name, fn) => {
        ipcMain.removeHandler(`jellyree:${name}`);
        ipcMain.handle(`jellyree:${name}`, async (_event, ...args) => {
          try {
            return { ok: true, value: await fn(...args) };
          } catch (error) {
            return { ok: false, error: error.message };
          }
        });
      };
      replace("media:release", (url) => media.release(url));
      replace("settings:get", () => ({
        configured: true,
        persisted: false,
        bucket: "cache-fixture",
      }));
      replace("files:list", () => ({
        items: state.files,
        total: state.files.length,
        hasMore: false,
        page: 1,
      }));
      replace("folders:list", () => []);
      replace("stats", () => ({ files: 3, bytes: 3000, tags: [], trashed: 0 }));
      replace("files:url", () => {
        throw new Error("Thumbnail unexpectedly requested an original URL");
      });
      replace("files:image-source", () => {
        state.imageReads++;
        return { data: new Uint8Array(input.png), mimeType: "image/png" };
      });
      replace("thumbnails:get", async (revision) => {
        const result = await cache.get(thumbnailKey("fixture", revision));
        if (result.entry) state.hits++;
        return result;
      });
      replace("thumbnails:put", (revision, entry, epoch) =>
        cache.put(thumbnailKey("fixture", revision), entry, epoch),
      );
      replace("thumbnails:source", (revision) => {
        state.sourceCalls++;
        return media.create(
          `https://fixture.invalid/${revision.id === "video" ? "video" : "image"}`,
        );
      });
      replace("thumbnails:stats", () => cache.stats());
      replace("thumbnails:clear", () => cache.clear());
      state.stats = () => cache.stats();
      state.restart = () => {
        cache = new ThumbnailCache(input.cache);
      };
      globalThis.__thumbnailFixture = state;
    },
    {
      module: path.join(directory, "electron/thumbnail-cache.mjs"),
      media: path.join(directory, "electron/thumbnail-media.mjs"),
      cache: path.join(profile, "cache-fixture"),
      png: [...png],
      mp4: [...mp4],
    },
  );
  await page.reload();
  const stats = () =>
    electron.evaluate(() => globalThis.__thumbnailFixture.stats());
  await page.getByText("Cached.png", { exact: true }).waitFor();
  const waitCached = async (count) => {
    for (let index = 0; index < 80; index++) {
      if ((await stats()).count >= count) return;
      await page.waitForTimeout(100);
    }
    assert.fail(`Expected ${count} cached thumbnails`);
  };
  await waitCached(3);
  const cold = await electron.evaluate(() => ({
    requests: globalThis.__thumbnailFixture.requests,
    reads: globalThis.__thumbnailFixture.imageReads,
    sources: globalThis.__thumbnailFixture.sourceCalls,
  }));
  assert.ok(cold.requests >= 2);
  assert.equal(cold.reads, 1);
  await electron.evaluate(() => globalThis.__thumbnailFixture.restart());
  await page.reload();
  await page.locator("img.cached-thumbnail").nth(2).waitFor();
  const dimensions = await page
    .locator("img.cached-thumbnail")
    .evaluateAll(async (images) => {
      await Promise.all(images.map((image) => image.decode()));
      return images.map((image) =>
        Math.max(image.naturalWidth, image.naturalHeight),
      );
    });
  assert.ok(dimensions.every((value) => value <= 640));
  const warm = await electron.evaluate(() => ({
    requests: globalThis.__thumbnailFixture.requests,
    reads: globalThis.__thumbnailFixture.imageReads,
    sources: globalThis.__thumbnailFixture.sourceCalls,
    hits: globalThis.__thumbnailFixture.hits,
  }));
  assert.equal(warm.requests, cold.requests);
  assert.equal(warm.reads, cold.reads);
  assert.equal(warm.sources, cold.sources);
  assert.equal(warm.hits, 3);
  assert.equal(await page.locator(".video-badge").innerText(), "0:02");
  assert.equal(await page.locator("video.video-decoder").count(), 0);
  await electron.evaluate(() => {
    globalThis.__thumbnailFixture.files[0].adjustments = { cropWidth: 0.75 };
    globalThis.__thumbnailFixture.files[1].object_key = "video-v2";
  });
  await page
    .locator(".topbar")
    .getByRole("button", { name: "Обновить", exact: true })
    .click();
  await waitCached(5);
  assert.ok(
    (await electron.evaluate(() => globalThis.__thumbnailFixture.sourceCalls)) >
      warm.sources,
  );
  await page
    .getByRole("button", { name: "Переключить подключение", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Подключения", exact: true })
    .getByRole("button", { name: "Настройки подключения", exact: true })
    .click();
  const settings = page.getByRole("dialog");
  await settings
    .getByRole("heading", { name: "Кэш миниатюр", exact: true })
    .waitFor();
  await settings
    .getByRole("button", { name: "Очистить кэш миниатюр", exact: true })
    .click();
  await settings.getByText("Кэш миниатюр очищен.", { exact: true }).waitFor();
  assert.equal((await stats()).count, 0);
  await page.screenshot({
    path: path.join(os.tmpdir(), "jellyree-thumbnail-cache.png"),
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: photo/video/edited thumbnails persist across cache and renderer restarts; warm loads avoid original requests and video decoders; replacement/edit invalidation; cache clear in settings",
  );
} finally {
  await electron?.close();
  await rm(profile, { recursive: true, force: true });
}
