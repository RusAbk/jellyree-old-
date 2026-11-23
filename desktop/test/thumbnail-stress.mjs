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
const profile = await mkdtemp(
  path.join(os.tmpdir(), "jellyree-thumbnail-stress-"),
);
const png = [
  ...(await readFile(path.join(directory, "test/fixtures/editor.png"))),
];
const mp4 = [
  ...(await readFile(path.join(directory, "test/fixtures/preview.mp4"))),
];
let app;
try {
  app = await _electron.launch({
    executablePath: process.env.JELLYREE_EXECUTABLE || undefined,
    args: [
      ...(process.env.JELLYREE_EXECUTABLE ? [] : [directory]),
      `--user-data-dir=${profile}`,
    ],
    cwd: directory,
    env: { ...process.env, JELLYREE_DEV_URL: "" },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page
    .getByRole("heading", { name: "Cloudflare connection", exact: true })
    .waitFor();
  await page.evaluate(() => {
    localStorage.setItem("jellyree-desktop-preview-size", "120");
  });
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      postMessage(message, transfer) {
        if (
          window.__stallThumbnailWorker &&
          message.key?.startsWith("worker-hang:")
        ) {
          window.__stallThumbnailWorker = false;
          window.__stalledThumbnailWorkers =
            (window.__stalledThumbnailWorkers || 0) + 1;
          return;
        }
        super.postMessage(message, transfer);
      }
    };
  });
  await app.evaluate(
    ({ ipcMain, protocol, nativeImage }, input) => {
      const require = process
        .getBuiltinModule("module")
        .createRequire(input.cacheModule);
      const { ThumbnailCache, thumbnailKey } = require(input.cacheModule),
        { ThumbnailMedia } = require(input.mediaModule);
      const cache = new ThumbnailCache(input.cache);
      const largePng = nativeImage
        .createFromBuffer(Buffer.from(input.png))
        .resize({ width: 2400, height: 1600 })
        .toPNG();
      const state = {
        active: 0,
        peak: 0,
        requests: 0,
        attempts: {},
        hits: 0,
        cancels: 0,
        files: Array.from({ length: 24 }, (_, index) => ({
          id: `photo-${index}`,
          name: `Photo ${index}.png`,
          mime_type: "image/png",
          object_key: `v1-${index}`,
          size_bytes: largePng.length,
          folder_id: null,
          tags: [],
          adjustments: {},
          favorite: false,
          trashed_at: null,
          created_at: "2026-11-24",
          updated_at: "2026-11-24",
        })),
      };
      const base = state.files[0];
      state.makeFile = (id, processed = false, video = false) => ({
        ...base,
        id,
        name: id + (video ? ".mp4" : ".png"),
        object_key: `v1/${id}`,
        mime_type: video ? "video/mp4" : "image/png",
        size_bytes: video ? input.mp4.length : largePng.length,
        adjustments: processed ? { cropWidth: 0.8 } : {},
      });
      globalThis.__thumbnailStress = state;
      const media = new ThumbnailMedia(async (url, options) => {
        state.requests++;
        const video = url.includes("video"),
          bytes = Buffer.from(video ? input.mp4 : largePng);
        const match = options.headers
            .get("range")
            ?.match(/^bytes=(\d+)-(\d*)$/),
          start = match ? Number(match[1]) : 0,
          end = match?.[2]
            ? Math.min(bytes.length - 1, Number(match[2]))
            : bytes.length - 1;
        return new Response(bytes.subarray(start, end + 1), {
          status: match ? 206 : 200,
          headers: {
            "Content-Type": video ? "video/mp4" : "image/png",
            "Content-Length": String(end - start + 1),
            "Accept-Ranges": "bytes",
            ...(match
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
        bucket: "stress",
      }));
      replace("files:list", () => ({
        items: state.files,
        total: state.files.length,
        hasMore: false,
        page: 1,
      }));
      replace("folders:list", () => []);
      replace("stats", () => ({
        files: state.files.length,
        bytes: 1000,
        tags: [],
        trashed: 0,
      }));
      replace("thumbnails:get", async (revision) => {
        if (revision.id === "cache-hang") return new Promise(() => {});
        const value = await cache.get(thumbnailKey("stress", revision));
        if (value.entry) state.hits++;
        return value;
      });
      replace("thumbnails:put", (revision, entry, epoch) =>
        cache.put(thumbnailKey("stress", revision), entry, epoch),
      );
      replace("thumbnails:source", async (revision) => {
        state.active++;
        state.peak = Math.max(state.active, state.peak);
        state.attempts[revision.id] = (state.attempts[revision.id] || 0) + 1;
        try {
          await new Promise((resolve) => setTimeout(resolve, 120));
          if (revision.id === "photo-0" && state.attempts[revision.id] === 1)
            throw new Error("Temporary D1 error");
          if (revision.id === "bad-photo" && !state.allowBad)
            throw new Error("Temporary R2 failure");
          return media.create(`https://fixture.invalid/${revision.id}`);
        } finally {
          state.active--;
        }
      });
      replace("files:url", () => {
        throw new Error("Unexpected original fallback");
      });
      replace("files:image-source", async (id, requestId) => {
        if (id === "source-hang")
          return new Promise((resolve) => {
            state.hangingRequest = requestId;
            state.hangResolve = () =>
              resolve({
                data: new Uint8Array(largePng),
                mimeType: "image/png",
              });
          });
        return { data: new Uint8Array(largePng), mimeType: "image/png" };
      });
      replace("previews:cancel", () => {
        state.cancels++;
      });
      state.stats = () => cache.stats();
      state.sources = () => media.sources.size;
    },
    {
      cacheModule: path.join(directory, "electron/thumbnail-cache.mjs"),
      mediaModule: path.join(directory, "electron/thumbnail-media.mjs"),
      cache: path.join(profile, "stress-cache"),
      png,
      mp4,
    },
  );
  await page.reload();
  await page.locator(".file-card").nth(23).scrollIntoViewIfNeeded();
  await page.locator(".file-card").first().scrollIntoViewIfNeeded();
  for (let i = 0; i < 80; i++) {
    const state = await app.evaluate(async () => ({
      peak: globalThis.__thumbnailStress.peak,
      count: (await globalThis.__thumbnailStress.stats()).count,
    }));
    if (state.peak > 3)
      assert.fail(
        `Unbounded thumbnail source burst: ${state.peak} concurrent requests`,
      );
    if (state.count === 24) break;
    await page.waitForTimeout(100);
  }
  const result = await app.evaluate(async () => ({
    peak: globalThis.__thumbnailStress.peak,
    count: (await globalThis.__thumbnailStress.stats()).count,
    attempts: globalThis.__thumbnailStress.attempts,
    sources: globalThis.__thumbnailStress.sources(),
  }));
  assert.equal(
    result.count,
    24,
    "transient errors recover without refreshing the application",
  );
  assert.ok(result.attempts["photo-0"] >= 2);
  assert.ok(result.peak <= 3);
  assert.ok(result.sources < 5, "completed thumbnail sources are released");
  const liveSizes = await page
    .locator(".file-thumb img")
    .evaluateAll((images) =>
      images
        .filter((image) => image.complete)
        .map((image) => Math.max(image.naturalWidth, image.naturalHeight)),
    );
  assert.ok(liveSizes.every((size) => size <= 640));
  const refresh = () =>
    page
      .locator(".topbar")
      .getByRole("button", { name: "Refresh", exact: true })
      .click();
  await app.evaluate(() => {
    const s = globalThis.__thumbnailStress;
    s.files = [
      s.makeFile("source-hang", true),
      s.makeFile("queued-edited", true),
      s.makeFile("queued-video", false, true),
    ];
  });
  await refresh();
  let hanging = false;
  for (let i = 0; i < 80; i++) {
    hanging = await app.evaluate(
      () => !!globalThis.__thumbnailStress.hangResolve,
    );
    if (hanging) break;
    await page.waitForTimeout(30);
  }
  assert.ok(hanging, "simulate an S3 read that never settles");
  await app.evaluate(() => {
    const s = globalThis.__thumbnailStress;
    s.files = [
      s.makeFile("after-source-edited", true),
      s.makeFile("after-source-photo"),
      s.makeFile("after-source-video", false, true),
    ];
  });
  await refresh();
  // One queued video may have finished before switching; use per-file hits for deterministic checks.
  await page
    .locator(".file-card")
    .filter({ hasText: "after-source-edited.png" })
    .locator("img.cached-thumbnail")
    .waitFor();
  await page
    .locator(".file-card")
    .filter({ hasText: "after-source-photo.png" })
    .locator("img.cached-thumbnail")
    .waitFor();
  await page
    .locator(".file-card")
    .filter({ hasText: "after-source-video.mp4" })
    .locator("img.cached-thumbnail")
    .waitFor();
  assert.ok(
    (await app.evaluate(() => globalThis.__thumbnailStress.cancels)) > 0,
  );
  await app.evaluate(() => {
    globalThis.__thumbnailStress.hangResolve();
  });
  await page.evaluate(() => {
    window.__stallThumbnailWorker = true;
  });
  await app.evaluate(() => {
    const s = globalThis.__thumbnailStress;
    s.files = [
      s.makeFile("worker-hang", true),
      s.makeFile("queued-worker", true),
    ];
  });
  await refresh();
  await page.waitForFunction(() => window.__stalledThumbnailWorkers === 1);
  await app.evaluate(() => {
    const s = globalThis.__thumbnailStress;
    s.files = [
      s.makeFile("after-worker-edited", true),
      s.makeFile("after-worker-photo"),
      s.makeFile("after-worker-video", false, true),
    ];
  });
  await refresh();
  for (const name of [
    "after-worker-edited.png",
    "after-worker-photo.png",
    "after-worker-video.mp4",
  ])
    await page
      .locator(".file-card")
      .filter({ hasText: name })
      .locator("img.cached-thumbnail")
      .waitFor();
  await app.evaluate(() => {
    const s = globalThis.__thumbnailStress;
    s.files = [s.makeFile("bad-photo"), s.makeFile("healthy-with-error")];
  });
  await refresh();
  await page
    .locator(".file-card")
    .filter({ hasText: "healthy-with-error.png" })
    .locator("img.cached-thumbnail")
    .waitFor();
  const bad = page.locator(".file-card").filter({ hasText: "bad-photo.png" });
  for (let i = 0; i < 100; i++) {
    if (
      (await app.evaluate(
        () => globalThis.__thumbnailStress.attempts["bad-photo"],
      )) >= 3
    )
      break;
    await page.waitForTimeout(40);
  }
  await bad.getByRole("button", { name: "Retry", exact: true }).waitFor();
  await app.evaluate(() => {
    globalThis.__thumbnailStress.allowBad = true;
  });
  await bad.getByRole("button", { name: "Retry", exact: true }).click();
  await bad.locator("img.cached-thumbnail").waitFor();
  assert.equal(
    await page
      .getByRole("dialog", { name: "File preview", exact: true })
      .count(),
    0,
    "retry must not open the file viewer",
  );
  assert.equal(await page.locator("video.video-decoder").count(), 0);
  await app.evaluate(() => {
    const s = globalThis.__thumbnailStress;
    s.files = [s.makeFile("cache-hang"), s.makeFile("healthy-cache")];
  });
  await refresh();
  for (const name of ["healthy-cache.png", "cache-hang.png"])
    await page
      .locator(".file-card")
      .filter({ hasText: name })
      .locator("img.cached-thumbnail")
      .waitFor();
  await page.screenshot({
    path: path.join(os.tmpdir(), "jellyree-thumbnail-recovery.png"),
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: 24 large photos with at most 3 source requests; transient errors; small decoded thumbnails; canceled S3 and worker hangs; subsequent edited/photo/video previews; bounded retries and manual recovery",
    { peak: result.peak, count: result.count, sources: result.sources },
  );
} finally {
  await app?.close();
  await rm(profile, { recursive: true, force: true });
}
