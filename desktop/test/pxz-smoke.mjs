import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "@playwright/test";
import {
  TextReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipWriter,
} from "@zip.js/zip.js/index-native.js";
import { readPxz } from "../electron/pxz-archive.mjs";

const directory = fileURLToPath(new URL("../", import.meta.url));
const profile = await mkdtemp(path.join(os.tmpdir(), "jellyree-pxz-"));
const square = (x, y, w, h, r = 0) => ({ x, y, w, h, r });
const fill = (value) => ({ type: "color", value });
const layer = (variant, color, rect, other = {}) => ({
  type: "shape",
  rect,
  format: { variant, fill: fill(color) },
  ...other,
});
const manifest = {
  type: "document",
  name: "Layered",
  unit: "pixel",
  width: 1200,
  height: 800,
  background: "#01317a",
  stack: [
    {
      type: "image",
      rect: square(100, 100, 200, 160),
      content: "asset.png",
      mask: "mask.svg",
    },
    layer("rectangle", "#16bd27", square(500, 100, 240, 100, 90)),
    {
      type: "shape",
      rect: square(850, 120, 200, 120),
      format: { variant: "svg" },
      content: "art.svg",
    },
    layer("rectangle", "#ff0000", square(850, 120, 200, 120), {
      visible: false,
    }),
    layer("rectangle", "#ff0000", square(420, 450, 180, 120), { opacity: 0.5 }),
    {
      type: "text",
      content: "PIXLR",
      rect: square(100, 500, 240, 100),
      format: { font: { name: "sans-serif" }, size: 70, fill: fill("#ffffff") },
    },
  ],
};
async function archive(thumbnail, asset) {
  const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  await zip.add("manifest.json", new TextReader(JSON.stringify(manifest)));
  if (thumbnail)
    await zip.add("thumbnail.webp", new Uint8ArrayReader(thumbnail));
  await zip.add("asset.png", new Uint8ArrayReader(asset));
  await zip.add(
    "mask.svg",
    new TextReader(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="160"><rect width="100" height="160" fill="#fff"/></svg>',
    ),
  );
  await zip.add(
    "art.svg",
    new TextReader(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120"><rect width="200" height="120" fill="#ffdc00"/></svg>',
    ),
  );
  return zip.close();
}

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
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page
    .getByRole("heading", { name: "Cloudflare connection", exact: true })
    .waitFor();
  const [thumb, pngUrl] = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 240;
    canvas.height = 160;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#a4148e";
    ctx.fillRect(0, 0, 240, 160);
    const thumb = canvas.toDataURL("image/webp");
    ctx.fillStyle = "#dc2838";
    ctx.fillRect(0, 0, 240, 160);
    return [thumb, canvas.toDataURL("image/png")];
  });
  const decoded = (url) => Buffer.from(url.split(",")[1], "base64");
  const embedded = decoded(thumb);
  const normal = await archive(embedded, decoded(pngUrl));
  const noThumbnail = await archive(null, decoded(pngUrl));
  const sample =
    process.env.JELLYREE_PXZ_SAMPLE &&
    (await readFile(process.env.JELLYREE_PXZ_SAMPLE));
  const sampleThumbnail =
    sample && (await readPxz(sample, (read) => read("thumbnail.webp")));
  const data = [
    {
      id: "layered",
      name: "Layered.PXZ",
      mime_type: "application/octet-stream",
      full: [...normal],
      thumb: [...embedded],
    },
    {
      id: "generated",
      name: "Generated.pxz",
      mime_type: "application/pxz",
      full: [...noThumbnail],
    },
    {
      id: "broken",
      name: "Broken.pxz",
      mime_type: "application/pxz",
      full: [1, 2, 3],
    },
    { id: "control", name: "Control.png", mime_type: "image/png" },
  ];
  if (sample)
    data.push({
      id: "sample",
      name: "Sample.pxz",
      mime_type: "application/pxz",
      full: [...sample],
      thumb: [...sampleThumbnail],
    });
  await app.evaluate(
    ({ ipcMain }, { data, pngUrl, cacheDir, modulePath }) => {
      const require = process
        .getBuiltinModule("module")
        .createRequire(modulePath);
      const { ThumbnailCache, thumbnailKey } = require(modulePath);
      const cache = new ThumbnailCache(cacheDir);
      const reads = [];
      globalThis.__pxzTest = { reads, stats: () => cache.stats() };
      const files = data.map(({ id, name, mime_type, full }) => ({
        id,
        name,
        mime_type,
        object_key: `project/${id}`,
        size_bytes: full?.length || 1024,
        folder_id: null,
        tags: [],
        adjustments: {},
        favorite: false,
        trashed_at: null,
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      }));
      function replace(channel, fn) {
        ipcMain.removeHandler(`jellyree:${channel}`);
        ipcMain.handle(`jellyree:${channel}`, async (_event, ...args) => {
          try {
            return { ok: true, value: await fn(...args) };
          } catch (error) {
            return { ok: false, error: error.message };
          }
        });
      }
      replace("settings:get", () => ({
        configured: true,
        persisted: false,
        bucket: "pxz",
      }));
      replace("folders:list", () => []);
      replace("stats", () => ({
        files: files.length,
        bytes: 12345,
        tags: [],
        trashed: 0,
      }));
      replace("files:list", () => ({
        items: files,
        total: files.length,
        hasMore: false,
        page: 1,
      }));
      replace("files:image-source", (id, _request, options) => {
        const { thumb, full } = data.find((entry) => entry.id === id);
        if (options.objectKey !== `project/${id}`)
          throw new Error("Wrong revision");
        reads.push({ id, thumbnail: options.thumbnail });
        return options.thumbnail && thumb
          ? { data: new Uint8Array(thumb), mimeType: "image/webp" }
          : { data: new Uint8Array(full), mimeType: "application/pxz" };
      });
      replace("thumbnails:get", (revision) =>
        cache.get(thumbnailKey("pxz", revision)),
      );
      replace("thumbnails:put", (revision, entry, epoch) =>
        cache.put(thumbnailKey("pxz", revision), entry, epoch),
      );
      replace("thumbnails:source", () => pngUrl);
    },
    {
      data,
      pngUrl,
      cacheDir: path.join(profile, "thumbs"),
      modulePath: path.join(directory, "electron/thumbnail-cache.mjs"),
    },
  );
  await page.reload();
  const card = (name) => page.locator(".file-card").filter({ hasText: name });
  const thumbFor = (name) => card(name).locator("img.cached-thumbnail");
  const badgeFor = (name) => card(name).locator(".file-extension-badge");
  for (const name of ["Layered.PXZ", "Generated.pxz", "Control.png"])
    await thumbFor(name).waitFor();
  assert.equal(await badgeFor("Layered.PXZ").textContent(), "PXZ");
  assert.equal(await badgeFor("Control.png").textContent(), "PNG");
  const color = (name) =>
    badgeFor(name).evaluate((badge) => getComputedStyle(badge).backgroundColor);
  assert.notEqual(await color("Layered.PXZ"), await color("Control.png"));
  assert.equal(await color("Layered.PXZ"), await color("Generated.pxz"));
  assert.equal(
    await thumbFor("Generated.pxz").evaluate((image) => image.naturalWidth),
    640,
  );
  assert.equal(
    await thumbFor("Layered.PXZ").evaluate((image) => image.naturalWidth),
    240,
  );
  const frame = (id) =>
    page.locator(`.photo-frame canvas[data-image-id="${id}"]`);
  const close = () =>
    page.getByRole("button", { name: "Close preview", exact: true }).click();
  await card("Layered.PXZ").dblclick();
  await frame("layered").waitFor();
  const inspected = await frame("layered").evaluate((canvas) => {
    const ctx = canvas.getContext("2d");
    const pixel = (x, y) => [...ctx.getImageData(x, y, 1, 1).data];
    const text = ctx.getImageData(100, 500, 240, 100).data;
    return {
      dimensions: [canvas.width, canvas.height],
      pixels: [
        [105, 105],
        [280, 105],
        [620, 240],
        [900, 160],
        [450, 480],
      ].map(([x, y]) => pixel(x, y)),
      whiteText: text.some((value, index) => index % 4 === 0 && value > 230),
    };
  });
  assert.deepEqual(inspected.dimensions, [1200, 800]);
  assert.deepEqual(inspected.pixels.slice(0, 4), [
    [220, 40, 56, 255],
    [1, 49, 122, 255],
    [22, 189, 39, 255],
    [255, 220, 0, 255],
  ]);
  assert.ok(inspected.pixels[4][0] >= 127 && inspected.pixels[4][0] <= 129);
  assert.equal(inspected.whiteText, true);
  assert.equal(
    await page
      .getByRole("button", { name: "Adjustments", exact: true })
      .count(),
    0,
  );
  await frame("layered").evaluate((canvas) => {
    window.__pxzCanvas = canvas;
  });
  await page.keyboard.press("ArrowRight");
  await frame("generated").waitFor();
  await page.keyboard.press("ArrowLeft");
  await frame("layered").waitFor();
  assert.ok(
    await frame("layered").evaluate((canvas) => canvas === window.__pxzCanvas),
  );
  await close();
  await card("Broken.pxz").dblclick();
  await page
    .getByText(
      "Unable to open the PXZ project. Check the file or download the original.",
    )
    .waitFor();
  await close();
  if (sample) {
    await card("Sample.pxz").dblclick();
    assert.deepEqual(
      await frame("sample").evaluate((canvas) => [canvas.width, canvas.height]),
      [662, 1092],
    );
    await close();
  }
  assert.equal(
    await app.evaluate(
      () =>
        globalThis.__pxzTest.reads.filter(
          ({ id, thumbnail }) => id === "layered" && !thumbnail,
        ).length,
    ),
    1,
  );
  const count = await app.evaluate(
    () =>
      globalThis.__pxzTest.reads.filter(({ id }) => id === "layered").length,
  );
  await page.reload();
  await thumbFor("Layered.PXZ").waitFor();
  assert.equal(
    await app.evaluate(
      () =>
        globalThis.__pxzTest.reads.filter(({ id }) => id === "layered").length,
    ),
    count,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: PXZ embedded and rendered thumbnails, badge colors, full-size layer composition, frame cache, ZIP errors and disk cache",
  );
} finally {
  await app?.close();
  await rm(profile, { recursive: true, force: true });
}
