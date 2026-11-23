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
const profile = await mkdtemp(path.join(os.tmpdir(), "jellyree-editor-"));
const png = await readFile(path.join(directory, "test/fixtures/editor.png"));
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
    ({ ipcMain, nativeImage }, input) => {
      const { normalizeImageAdjustments } = process
        .getBuiltinModule("module")
        .createRequire(input.module)(input.module);
      const file = {
        id: "editor-photo",
        object_key: "original.png",
        name: "Editor.png",
        mime_type: "image/png",
        size_bytes: input.bytes.length,
        folder_id: null,
        tags: [],
        adjustments: {},
        favorite: false,
        trashed_at: null,
        created_at: "2026-11-24",
        updated_at: "2026-11-24",
      };
      const state = { file, exports: [], updates: [], reads: 0 };
      globalThis.__editorFixture = state;
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
        bucket: "editor-fixture",
      }));
      replace("files:list", () => ({
        items: [file],
        total: 1,
        hasMore: false,
        page: 1,
      }));
      replace("folders:list", () => []);
      replace("stats", () => ({
        files: 1,
        bytes: file.size_bytes,
        trashed: 0,
        tags: [],
      }));
      replace(
        "files:url",
        () =>
          `data:image/png;base64,${Buffer.from(input.bytes).toString("base64")}`,
      );
      replace("files:image-source", () => {
        state.reads++;
        return { data: new Uint8Array(input.bytes), mimeType: "image/png" };
      });
      replace("files:update", (ids, patch) => {
        if (patch.expectedObjectKey !== file.object_key)
          throw new Error("Source changed");
        file.adjustments = normalizeImageAdjustments(patch.adjustments);
        state.updates.push({ ids, patch });
      });
      replace("files:export-image", (id, bytes, format) => {
        const buffer = Buffer.from(bytes),
          image = nativeImage.createFromBuffer(buffer);
        if (format !== "webp" && image.isEmpty())
          throw new Error("Invalid encoded image");
        state.exports.push({
          id,
          format,
          length: bytes.length,
          size: image.getSize(),
          webp: format === "webp" ? buffer.toString("base64") : undefined,
          magic: [...buffer.subarray(0, 8)],
        });
        return { saved: true };
      });
    },
    {
      module: path.join(directory, "electron/image-adjustments.mjs"),
      bytes: [...png],
    },
  );
  await page.reload();
  const card = page.locator(".file-card").filter({ hasText: "Editor.png" });
  await card.dblclick();
  await page.getByRole("button", { name: "Коррекция", exact: true }).click();
  const editor = page.getByRole("dialog", {
    name: "Редактор изображения",
    exact: true,
  });
  await editor.waitFor();
  await editor
    .getByRole("button", { name: "Сохранить коррекцию", exact: true })
    .waitFor();
  await page.waitForFunction(
    () => document.querySelector(".photo-editor canvas")?.width === 600,
  );
  const pixels = () =>
    editor
      .locator("canvas")
      .evaluate((canvas) =>
        Array.from(canvas.getContext("2d").getImageData(125, 90, 1, 1).data),
      );
  const original = await pixels();
  const slider = async (name, value) => {
    await editor
      .getByRole("slider", { name, exact: true })
      .evaluate((element, value) => {
        element.value = String(value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      }, value);
    await page.waitForFunction(
      () => !document.querySelector(".editor-render-status .spinning"),
    );
  };
  await editor.getByRole("button", { name: "Цвет", exact: true }).click();
  await slider("Температура", 60);
  await page.waitForFunction((before) => {
    const canvas = document.querySelector(".photo-editor canvas");
    return (
      canvas &&
      [...canvas.getContext("2d").getImageData(125, 90, 1, 1).data].some(
        (value, index) => value !== before[index],
      )
    );
  }, original);
  const warm = await pixels();
  await editor
    .getByRole("button", { name: "Отменить шаг", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector('input[aria-label="Температура"]')?.value === "0",
  );
  await editor
    .getByRole("button", { name: "Повторить шаг", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector('input[aria-label="Температура"]')?.value === "60",
  );
  await editor.getByRole("button", { name: "Геометрия", exact: true }).click();
  await editor
    .getByRole("combobox", { name: "Пропорции кадра", exact: true })
    .selectOption("1");
  const cropBefore = await editor.locator(".crop-box").getAttribute("style");
  const cropHandle = await editor.locator(".crop-handle.se").boundingBox();
  await page.mouse.move(
    cropHandle.x + cropHandle.width / 2,
    cropHandle.y + cropHandle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(cropHandle.x - 24, cropHandle.y - 24, { steps: 6 });
  await page.mouse.up();
  assert.notEqual(
    await editor.locator(".crop-box").getAttribute("style"),
    cropBefore,
  );
  await editor
    .getByRole("button", { name: "Отменить шаг", exact: true })
    .click();
  assert.equal(
    await editor.locator(".crop-box").getAttribute("style"),
    cropBefore,
  );
  await editor
    .getByRole("button", { name: "Отразить по горизонтали", exact: true })
    .click();
  await editor.getByRole("button", { name: "Пластика", exact: true }).click();
  const frame = editor.locator(".editor-image-frame"),
    bounds = await frame.boundingBox();
  await page.mouse.move(
    bounds.x + bounds.width * 0.45,
    bounds.y + bounds.height * 0.5,
  );
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + bounds.width * 0.6,
    bounds.y + bounds.height * 0.52,
    { steps: 8 },
  );
  await page.mouse.up();
  await editor.getByText(/Мазков: [1-9]/).waitFor();
  await editor.getByRole("button", { name: "Растяжение", exact: true }).click();
  await slider("Сила растяжения", 30);
  await editor.getByRole("button", { name: "Детали", exact: true }).click();
  await slider("Резкость", 25);
  await slider("Виньетка", 20);
  await editor
    .getByRole("button", { name: "Показать клиппинг", exact: true })
    .click();
  await editor
    .getByRole("button", { name: "Показать клиппинг", exact: true })
    .click();
  await editor
    .getByRole("button", { name: "Быстрые настройки", exact: true })
    .click();
  await editor
    .getByRole("button", { name: "Копировать правки", exact: true })
    .click();
  await editor
    .getByRole("button", { name: "Удерживать для сравнения", exact: true })
    .focus();
  await page.keyboard.down("Space");
  await page.waitForFunction(
    () =>
      document.querySelector('.photo-editor canvas[aria-label="Оригинал"]') !==
      null,
  );
  await page.keyboard.up("Space");
  await editor.getByText("Экспорт изображения", { exact: true }).click();
  await editor
    .getByRole("combobox", { name: "Формат экспорта", exact: true })
    .selectOption("png");
  await editor
    .getByRole("button", { name: "Сохранить обработанную копию", exact: true })
    .click();
  await editor
    .getByText("Обработанное изображение сохранено на компьютере.", {
      exact: true,
    })
    .waitFor();
  for (const format of ["jpeg", "webp"]) {
    await editor
      .getByRole("combobox", { name: "Формат экспорта", exact: true })
      .selectOption(format);
    await editor
      .getByRole("button", {
        name: "Сохранить обработанную копию",
        exact: true,
      })
      .click();
    await page.waitForFunction(
      () => !document.querySelector(".photo-editor fieldset")?.disabled,
    );
    try {
      await editor
        .getByText("Обработанное изображение сохранено на компьютере.", {
          exact: true,
        })
        .waitFor();
    } catch (error) {
      console.log(
        "Export diagnostics",
        format,
        await editor.locator('[role="alert"]').allTextContents(),
        await electron.evaluate(() => globalThis.__editorFixture.exports),
      );
      throw error;
    }
  }
  await page.screenshot({
    path: path.join(os.tmpdir(), "jellyree-photo-editor.png"),
  });
  await editor
    .getByRole("button", { name: "Сохранить коррекцию", exact: true })
    .click();
  await editor.waitFor({ state: "hidden" });
  const result = await electron.evaluate(() => globalThis.__editorFixture);
  assert.equal(result.file.object_key, "original.png");
  assert.equal(result.file.adjustments.temperature, 60);
  assert.equal(result.file.adjustments.flipX, true);
  assert.equal(result.file.adjustments.stretchAmount, 30);
  assert.ok(result.file.adjustments.strokes.length > 0);
  assert.equal(result.exports[0].format, "png");
  assert.deepEqual(result.exports[0].size, { width: 400, height: 400 });
  assert.deepEqual(result.exports[0].magic, [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual(
    result.exports.map((entry) => entry.format),
    ["png", "jpeg", "webp"],
  );
  assert.deepEqual(result.exports[1].magic.slice(0, 2), [255, 216]);
  assert.equal(
    String.fromCharCode(...result.exports[2].magic.slice(0, 4)),
    "RIFF",
  );
  const webpSize = await page.evaluate(async (base64) => {
    const data = Uint8Array.from(atob(base64), (character) =>
      character.charCodeAt(0),
    );
    const bitmap = await createImageBitmap(
      new Blob([data], { type: "image/webp" }),
    );
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  }, result.exports[2].webp);
  assert.deepEqual(webpSize, { width: 400, height: 400 });
  assert.equal(result.updates.length, 1);
  assert.equal(result.updates[0].patch.expectedObjectKey, "original.png");
  await page
    .getByRole("dialog", { name: "Просмотр файла" })
    .locator(".processed-image")
    .waitFor();
  await page
    .getByRole("button", { name: "Закрыть просмотр", exact: true })
    .click();
  await card.locator(".processed-image").waitFor();
  await card.dblclick();
  await page.getByRole("button", { name: "Коррекция", exact: true }).click();
  await editor
    .getByRole("button", { name: "Вставить правки", exact: true })
    .waitFor();
  await editor
    .getByRole("button", { name: "Сбросить всё", exact: true })
    .click();
  await editor
    .getByRole("button", { name: "Закрыть редактор", exact: true })
    .click();
  await editor.getByRole("alertdialog").waitFor();
  await editor
    .getByRole("button", { name: "Не сохранять", exact: true })
    .click();
  await editor.waitFor({ state: "hidden" });
  assert.equal(
    await electron.evaluate(() => globalThis.__editorFixture.updates.length),
    1,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: production Electron image worker, color pixels, history, crop/flip/liquify/stretch, compare, PNG/JPEG/WebP export, nondestructive IPC save, saved preview/thumbnail and discard",
  );
} finally {
  await electron?.close();
  await rm(profile, { recursive: true, force: true });
}
