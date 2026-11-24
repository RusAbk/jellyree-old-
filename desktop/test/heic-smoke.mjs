import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "@playwright/test";
import { createServer } from "vite";
const directory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const profile = await mkdtemp(path.join(os.tmpdir(), "jellyree-heic-"));
const bytes = Object.fromEntries(
  await Promise.all(
    ["preview.heic", "rotated.heic", "collection.heic", "editor.png"].map(
      async (name) => [
        name,
        [...(await readFile(path.join(directory, "test/fixtures", name)))],
      ],
    ),
  ),
);
const dev = process.env.JELLYREE_TEST_DEV === "1";
let app, server;
try {
  if (dev) {
    server = await createServer();
    await server.listen();
  }
  app = await _electron.launch({
    executablePath: process.env.JELLYREE_EXECUTABLE || undefined,
    args: [
      ...(process.env.JELLYREE_EXECUTABLE ? [] : [directory]),
      `--user-data-dir=${profile}`,
    ],
    cwd: directory,
    env: {
      ...process.env,
      JELLYREE_DEV_URL: dev ? "http://127.0.0.1:5174" : "",
    },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(25000);
  const errors = [],
    csp = [],
    remote = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /Content Security|unsafe-eval|WebAssembly|worker script/i.test(
        message.text(),
      )
    )
      csp.push(message.text());
  });
  page.on("request", (request) => {
    if (
      /^https?:/.test(request.url()) &&
      !request.url().startsWith("http://127.0.0.1:5174/")
    )
      remote.push(request.url());
  });
  await page
    .getByRole("heading", { name: "Cloudflare connection", exact: true })
    .waitFor();
  await app.evaluate(
    ({ ipcMain, protocol }, input) => {
      const require = process
        .getBuiltinModule("module")
        .createRequire(input.module);
      const { ThumbnailCache, thumbnailKey } = require(input.module),
        { ThumbnailMedia } = require(input.media);
      const cache = new ThumbnailCache(input.cache),
        media = new ThumbnailMedia(
          async () =>
            new Response(new Uint8Array(input.bytes["editor.png"]), {
              headers: { "Content-Type": "image/png" },
            }),
        );
      protocol.unhandle("jellyree-media");
      protocol.handle("jellyree-media", (request) => media.handle(request));
      const files = [
        {
          id: "normal",
          name: "Photo.heic",
          mime_type: "image/heic",
          fixture: "preview.heic",
        },
        {
          id: "generic",
          name: "IMG.HEIC",
          mime_type: "application/octet-stream",
          fixture: "preview.heic",
        },
        {
          id: "heif",
          name: "Photo.HEIF",
          mime_type: "application/octet-stream",
          fixture: "preview.heic",
        },
        {
          id: "rotated",
          name: "Rotated.heic",
          mime_type: "image/heif",
          fixture: "rotated.heic",
        },
        {
          id: "collection",
          name: "Collection.heic",
          mime_type: "image/heic-sequence",
          fixture: "collection.heic",
        },
        {
          id: "broken",
          name: "Broken.heic",
          mime_type: "image/heic",
          fixture: "broken",
        },
        {
          id: "png",
          name: "Control.png",
          mime_type: "image/png",
          fixture: "editor.png",
        },
      ].map((file) => ({
        ...file,
        object_key: `private/${file.id}-v1`,
        size_bytes: input.bytes[file.fixture]?.length || 20,
        folder_id: null,
        tags: [],
        adjustments: {},
        favorite: false,
        trashed_at: null,
        created_at: "2026-11-24",
        updated_at: "2026-11-24",
      }));
      const state = {
        files,
        reads: {},
        sources: 0,
        hits: 0,
        exports: [],
        updates: [],
        stats: () => cache.stats(),
      };
      globalThis.__heicFixture = state;
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
      replace("settings:get", () => ({
        configured: true,
        persisted: false,
        bucket: "heic",
      }));
      replace("folders:list", () => []);
      replace("stats", () => ({
        files: files.length,
        bytes: 10000,
        tags: [],
        trashed: 0,
      }));
      replace("files:list", () => ({
        items: files,
        total: files.length,
        hasMore: false,
        page: 1,
      }));
      replace("files:image-source", (id) => {
        const file = files.find((f) => f.id === id);
        state.reads[id] = (state.reads[id] || 0) + 1;
        return {
          data: new Uint8Array(input.bytes[file.fixture] || [1, 2, 3]),
          mimeType: file.mime_type,
        };
      });
      replace("files:url", (id) => {
        if (id !== "png")
          throw new Error(
            "HEIC must decode locally, without requesting a signed URL",
          );
        return media.create("https://fixture.invalid/control");
      });
      replace("thumbnails:get", async (revision) => {
        const result = await cache.get(thumbnailKey("heic", revision));
        if (result.entry) state.hits++;
        return result;
      });
      replace("thumbnails:put", (revision, entry, epoch) =>
        cache.put(thumbnailKey("heic", revision), entry, epoch),
      );
      replace("thumbnails:source", () => {
        state.sources++;
        return media.create("https://fixture.invalid/control");
      });
      replace("media:release", (url) => media.release(url));
      replace("files:update", (ids, patch) => {
        state.updates.push({ ids, patch });
        for (const file of files)
          if (ids.includes(file.id)) file.adjustments = patch.adjustments;
      });
      replace("files:export-image", (id, data, format) => {
        state.exports.push({ id, format, bytes: [...data] });
        return { saved: true };
      });
    },
    {
      module: path.join(directory, "electron/thumbnail-cache.mjs"),
      media: path.join(directory, "electron/thumbnail-media.mjs"),
      cache: path.join(profile, "heic-cache"),
      bytes,
    },
  );
  await page.reload();
  const card = (name) => page.locator(".file-card").filter({ hasText: name });
  for (const name of [
    "Photo.heic",
    "IMG.HEIC",
    "Photo.HEIF",
    "Rotated.heic",
    "Collection.heic",
    "Control.png",
  ])
    await card(name).locator("img.cached-thumbnail").waitFor();
  const dimensions = await card("IMG.HEIC")
    .locator("img")
    .evaluate(async (image) => {
      await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight };
    });
  assert.deepEqual(dimensions, { width: 640, height: 427 });
  const open = async (name) => {
    await card(name).dblclick();
  };
  const close = async () => {
    await page
      .getByRole("button", { name: "Close preview", exact: true })
      .click();
  };
  const pixel = async (id, x, y) =>
    page
      .locator(`.preview-stage canvas[data-image-id="${id}"]`)
      .evaluate(
        (canvas, { x, y }) => [
          ...canvas.getContext("2d").getImageData(x, y, 1, 1).data,
        ],
        { x, y },
      );
  for (const [name, id] of [
    ["Photo.heic", "normal"],
    ["IMG.HEIC", "generic"],
    ["Photo.HEIF", "heif"],
    ["Collection.heic", "collection"],
  ]) {
    await open(name);
    const canvas = page.locator(`.preview-stage canvas[data-image-id="${id}"]`);
    await canvas.waitFor();
    await page.waitForFunction(
      (id) =>
        document.querySelector(`.preview-stage canvas[data-image-id="${id}"]`)
          ?.width === 960,
      id,
    );
    const red = await pixel(id, 200, 160),
      green = await pixel(id, 720, 160),
      blue = await pixel(id, 200, 480);
    assert.ok(red[0] > 180 && red[1] < 100 && red[2] < 100);
    assert.ok(green[1] > 140 && green[0] < 110);
    assert.ok(blue[2] > 140 && blue[0] < 110);
    if (id === "normal")
      await canvas.evaluate((node) => {
        window.__heicFirstFrame = node;
      });
    await close();
  }
  await open("Rotated.heic");
  await page.waitForFunction(
    () =>
      document.querySelector('.preview-stage canvas[data-image-id="rotated"]')
        ?.height === 960,
  );
  const rotated = await pixel("rotated", 160, 240);
  assert.ok(rotated[2] > 140 && rotated[0] < 110);
  await page.screenshot({
    path: path.join(os.tmpdir(), "jellyree-heic-viewer.png"),
  });
  await close();
  await open("Broken.heic");
  await page
    .getByText(
      "Unable to open HEIC/HEIF. Check the file or download the original.",
      { exact: true },
    )
    .waitFor();
  await close();
  await open("Photo.heic");
  await page.waitForFunction(
    () =>
      document.querySelector('.preview-stage canvas[data-image-id="normal"]')
        ?.width === 960,
  );
  assert.ok(
    await page
      .locator('.preview-stage canvas[data-image-id="normal"]')
      .evaluate((node) => node === window.__heicFirstFrame),
    "reopening HEIC reuses the rendered frame",
  );
  await close();
  // The same HEIC decoder also supplies the existing editor and PNG export.
  await open("IMG.HEIC");
  const viewerCanvas = page.locator(
    '.preview-stage canvas[data-image-id="generic"]',
  );
  await viewerCanvas.evaluate((node) => {
    window.__heicBeforeAdjustment = node;
  });
  await page.getByRole("button", { name: "Adjustments", exact: true }).click();
  const editor = page.getByRole("dialog", {
    name: "Image editor",
    exact: true,
  });
  await page.waitForFunction(
    () => document.querySelector(".photo-editor canvas")?.width === 960,
  );
  await editor.getByRole("button", { name: "Color", exact: true }).click();
  await editor
    .getByRole("slider", { name: "Temperature", exact: true })
    .evaluate((element) => {
      element.value = "40";
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    });
  await editor.getByText("Export image", { exact: true }).click();
  await editor
    .getByRole("combobox", { name: "Export format", exact: true })
    .selectOption("png");
  await editor
    .getByRole("button", { name: "Save edited copy", exact: true })
    .click();
  for (let i = 0; i < 100; i++) {
    if (await app.evaluate(() => globalThis.__heicFixture.exports.length > 0))
      break;
    await page.waitForTimeout(50);
  }
  const exported = await app.evaluate(({ nativeImage }) => {
    const result = globalThis.__heicFixture.exports[0];
    return {
      id: result.id,
      format: result.format,
      size: nativeImage.createFromBuffer(Buffer.from(result.bytes)).getSize(),
      magic: result.bytes.slice(0, 8),
    };
  });
  assert.equal(exported.id, "generic");
  assert.equal(exported.format, "png");
  assert.deepEqual(exported.size, { width: 960, height: 640 });
  assert.deepEqual(exported.magic, [137, 80, 78, 71, 13, 10, 26, 10]);
  await editor
    .getByRole("button", { name: "Save adjustments", exact: true })
    .click();
  await editor.waitFor({ state: "hidden" });
  await page.waitForFunction(() => {
    const canvas = document.querySelector(
      '.preview-stage canvas[data-image-id="generic"]',
    );
    return canvas && canvas !== window.__heicBeforeAdjustment;
  });
  await close();
  for (let i = 0; i < 100; i++) {
    if ((await app.evaluate(() => globalThis.__heicFixture.stats())).count >= 7)
      break;
    await page.waitForTimeout(50);
  }
  const saved = await app.evaluate(() => {
    const f = globalThis.__heicFixture.files.find(
      (file) => file.id === "generic",
    );
    return {
      key: f.object_key,
      mime: f.mime_type,
      temperature: f.adjustments.temperature,
      updates: globalThis.__heicFixture.updates.length,
    };
  });
  assert.equal(saved.key, "private/generic-v1");
  assert.equal(saved.mime, "application/octet-stream");
  assert.equal(saved.temperature, 40);
  assert.equal(saved.updates, 1);
  const before = await app.evaluate(() => ({
    ...globalThis.__heicFixture.reads,
  }));
  await page.reload();
  for (const name of [
    "Photo.heic",
    "IMG.HEIC",
    "Photo.HEIF",
    "Rotated.heic",
    "Collection.heic",
    "Control.png",
  ])
    await card(name).locator("img.cached-thumbnail").waitFor();
  const after = await app.evaluate(() => ({
    reads: { ...globalThis.__heicFixture.reads },
    hits: globalThis.__heicFixture.hits,
    sources: globalThis.__heicFixture.sources,
  }));
  for (const id of ["normal", "generic", "heif", "rotated", "collection"])
    assert.equal(
      after.reads[id],
      before[id],
      `cached ${id} does not download or decode the original again`,
    );
  assert.equal(after.sources, 1);
  assert.ok(after.hits >= 6);
  assert.deepEqual(errors, []);
  assert.deepEqual(csp, []);
  assert.deepEqual(remote, []);
  console.log(
    "PASS: HEIC/HEIF decoding, generic MIME, colors/orientation/primary frame, persistent thumbnails, corrupt-file recovery, editor and PNG export preserving the original, local worker/WASM and strict CSP",
  );
} catch (error) {
  console.error(error);
  await (
    await app?.firstWindow()
  )
    ?.screenshot({ path: path.join(os.tmpdir(), "jellyree-heic-failure.png") })
    .catch(() => {});
  throw error;
} finally {
  await app?.close();
  await server?.close();
  await rm(profile, { recursive: true, force: true });
}
