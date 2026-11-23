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
const profile = await mkdtemp(path.join(os.tmpdir(), "jellyree-video-player-"));
const mp4 = await readFile(path.join(directory, "test/fixtures/preview.mp4"));
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
    ({ ipcMain, protocol, nativeImage }, input) => {
      const require = process
        .getBuiltinModule("module")
        .createRequire(input.module);
      const { ThumbnailMedia } = require(input.module),
        { videoFrameName, validateVideoFrame } = require(input.frames);
      const state = {
        files: ["first", "second"].map((id) => ({
          id,
          name: `${id}.mp4`,
          object_key: `${id}-v1`,
          mime_type: "video/mp4",
          folder_id: "movies",
          size_bytes: input.bytes.length,
          adjustments: {},
          favorite: false,
          trashed_at: null,
          tags: [],
          created_at: "2026-11-24",
          updated_at: "2026-11-24",
        })),
        frames: [],
        pngs: {},
        downloads: [],
        pending: null,
        failNext: false,
        cancelDownload: false,
      };
      globalThis.__videoFixture = state;
      const media = new ThumbnailMedia(async (_url, options) => {
        const image = state.pngs[new URL(_url).pathname.slice(1)];
        const bytes = image
            ? Buffer.from(image, "base64")
            : Buffer.from(input.bytes),
          match = options.headers.get("range")?.match(/^bytes=(\d+)-(\d*)$/);
        const start = match ? Number(match[1]) : 0,
          end = match?.[2]
            ? Math.min(bytes.length - 1, Number(match[2]))
            : bytes.length - 1;
        return new Response(bytes.subarray(start, end + 1), {
          status: match ? 206 : 200,
          headers: {
            "Content-Type": image ? "image/png" : "video/mp4",
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
        bucket: "video-fixture",
      }));
      replace("files:list", (input) => {
        const items = state.files.filter(
          (file) =>
            input.section !== "drive" ||
            file.folder_id === (input.folderId || null),
        );
        return { items, total: items.length, hasMore: false, page: 1 };
      });
      replace("folders:list", () => [
        { id: "movies", name: "Movies", parent_id: null },
      ]);
      replace("stats", () => ({
        files: state.files.length,
        bytes: 1000,
        trashed: 0,
        tags: [],
      }));
      replace("thumbnails:source", (revision) =>
        media.create(`https://fixture.invalid/${revision.id}`),
      );
      replace("files:url", (id) => `data:image/png;base64,${state.pngs[id]}`);
      replace("files:video-source", () =>
        media.create(async () => "https://fixture.invalid/playback"),
      );
      const frame = (id, expected, timestamp, bytes) => {
        const source = state.files.find((file) => file.id === id);
        if (source.object_key !== expected) throw new Error("Stale video");
        const dimensions = validateVideoFrame(bytes, timestamp),
          png = nativeImage.createFromBuffer(Buffer.from(bytes));
        if (png.isEmpty()) throw new Error("Invalid encoded PNG");
        return {
          id,
          expected,
          timestamp,
          dimensions,
          size: png.getSize(),
          data: Buffer.from(bytes).toString("base64"),
        };
      };
      replace("files:save-video-frame", async (...args) => {
        if (state.failNext) {
          state.failNext = false;
          throw new Error("Simulated R2 failure");
        }
        const captured = frame(...args);
        state.frames.push(captured);
        await new Promise((resolve) => {
          state.pending = resolve;
        });
        state.pending = null;
        const source = state.files.find((file) => file.id === captured.id),
          suffix = state.frames.length - 1;
        const saved = {
          ...source,
          id: `frame-${state.frames.length}`,
          object_key: `png-${state.frames.length}`,
          name: videoFrameName(source.name, captured.timestamp, suffix),
          mime_type: "image/png",
          size_bytes: Buffer.from(captured.data, "base64").length,
        };
        state.pngs[saved.id] = captured.data;
        state.files.push(saved);
        return saved;
      });
      replace("files:download-video-frame", (...args) => {
        if (state.cancelDownload) return { saved: false };
        state.downloads.push(frame(...args));
        return { saved: true };
      });
    },
    {
      module: path.join(directory, "electron/thumbnail-media.mjs"),
      frames: path.join(directory, "electron/video-frames.mjs"),
      bytes: [...mp4],
    },
  );
  await page.reload();
  await page.locator(".folder-card").filter({ hasText: "Movies" }).click();
  const card = page.locator(".file-card").filter({ hasText: "first.mp4" });
  const waitPending = async () => {
    for (let index = 0; index < 100; index++) {
      if (await electron.evaluate(() => !!globalThis.__videoFixture.pending))
        return;
      await page.waitForTimeout(50);
    }
    assert.fail("Video frame request did not reach main IPC");
  };
  await card.dblclick();
  const player = page.getByRole("region", { name: "Видеоплеер", exact: true });
  const video = player.locator("video"),
    speed = player.getByRole("combobox", {
      name: "Скорость воспроизведения",
      exact: true,
    });
  const save = player.getByRole("button", {
    name: "Сохранить кадр в папку",
    exact: true,
  });
  await video.waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector(".desktop-video-player video")?.readyState >= 2,
  );
  await video.evaluate((element) => element.pause());
  for (const value of ["0.25", "0.5", "0.75", "1", "1.25", "1.5", "2"]) {
    await speed.selectOption(value);
    assert.equal(
      await video.evaluate((element) => element.playbackRate),
      Number(value),
    );
  }
  await video.evaluate((element) => {
    element.currentTime = 0.5;
  });
  await page.waitForFunction(() => {
    const video = document.querySelector(".desktop-video-player video");
    return video && !video.seeking && Math.abs(video.currentTime - 0.5) < 0.01;
  });
  await video.evaluate((element) => {
    const canvas = document.createElement("canvas");
    canvas.width = element.videoWidth;
    canvas.height = element.videoHeight;
    const context = canvas.getContext("2d");
    context.drawImage(element, 0, 0);
    window.__expectedVideoPixels = [
      ...context.getImageData(0, 0, canvas.width, canvas.height).data,
    ];
  });
  await save.click();
  await video.evaluate((element) => {
    element.currentTime = 1.25;
  });
  await waitPending();
  assert.equal(
    await speed.isEnabled(),
    true,
    "capture upload does not block playback settings",
  );
  await speed.selectOption("1.5");
  const captured = await electron.evaluate(
    () => globalThis.__videoFixture.frames[0],
  );
  assert.equal(captured.timestamp, 0.5);
  assert.deepEqual(captured.size, { width: 320, height: 180 });
  const identical = await page.evaluate(async (base64) => {
    const bitmap = await createImageBitmap(
      new Blob([Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))], {
        type: "image/png",
      }),
    );
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    return [
      ...context.getImageData(0, 0, canvas.width, canvas.height).data,
    ].every((value, index) => value === window.__expectedVideoPixels[index]);
  }, captured.data);
  assert.equal(
    identical,
    true,
    "saved PNG contains the frame from the instant of capture",
  );
  await electron.evaluate(() => globalThis.__videoFixture.pending());
  await player.getByRole("status").filter({ hasText: "00:00.500" }).waitFor();
  assert.equal(
    (await electron.evaluate(() => globalThis.__videoFixture.files.at(-1)))
      .folder_id,
    "movies",
  );
  await player
    .getByRole("button", { name: "Скачать стопкадр", exact: true })
    .click();
  await player.getByText(/сохранён на компьютере/).waitFor();
  assert.equal(
    await electron.evaluate(() => globalThis.__videoFixture.downloads.length),
    1,
  );
  await page.screenshot({
    path: path.join(os.tmpdir(), "jellyree-video-player.png"),
  });
  await electron.evaluate(() => {
    globalThis.__videoFixture.cancelDownload = true;
  });
  await player
    .getByRole("button", { name: "Скачать стопкадр", exact: true })
    .click();
  await player
    .getByRole("button", { name: "Скачать стопкадр", exact: true })
    .waitFor();
  assert.equal(
    await electron.evaluate(() => globalThis.__videoFixture.downloads.length),
    1,
    "canceling the save dialog creates no local frame",
  );
  await electron.evaluate(() => {
    globalThis.__videoFixture.cancelDownload = false;
  });
  await electron.evaluate(() => {
    globalThis.__videoFixture.failNext = true;
  });
  await save.click();
  await player
    .getByRole("alert")
    .filter({ hasText: "Simulated R2 failure" })
    .waitFor();
  assert.equal(await speed.isEnabled(), true);
  assert.equal(await save.isEnabled(), true);
  await page
    .getByRole("button", { name: "Следующий файл", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Просмотр файла" })
    .locator(".preview-header")
    .getByText("second.mp4", { exact: false })
    .waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector(".desktop-video-player video")?.playbackRate ===
      1.5,
  );
  await page
    .getByRole("button", { name: "Закрыть просмотр", exact: true })
    .click();
  const saved = await electron.evaluate(() =>
    globalThis.__videoFixture.files.at(-1),
  );
  await page.getByText(saved.name, { exact: true }).waitFor();
  await page.reload();
  await page.locator(".folder-card").filter({ hasText: "Movies" }).click();
  await card.dblclick();
  await page.waitForFunction(
    () =>
      document.querySelector(".desktop-video-player video")?.playbackRate ===
      1.5,
  );
  await video.evaluate((element) => element.pause());
  await player
    .getByRole("button", { name: "Сохранить кадр в папку", exact: true })
    .click();
  await waitPending();
  await page
    .getByRole("button", { name: "Закрыть просмотр", exact: true })
    .click();
  await electron.evaluate(() => globalThis.__videoFixture.pending());
  const final = await electron.evaluate(() => globalThis.__videoFixture);
  await page.getByText(final.files.at(-1).name, { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("dialog").count(),
    0,
    "finishing capture never reopens the viewer",
  );
  assert.equal(final.files[0].object_key, "first-v1");
  assert.notEqual(final.files.at(-1).name, saved.name);
  assert.deepEqual(errors, []);
  await page.screenshot({
    path: path.join(os.tmpdir(), "jellyree-video-frames.png"),
  });
  console.log(
    "PASS: video speed choices and persistence, readable Range playback, exact full-resolution PNG capture, gallery refresh, local save, error recovery and capture completion after closing viewer",
  );
} finally {
  await electron?.close();
  await rm(profile, { recursive: true, force: true });
}
