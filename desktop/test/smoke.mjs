import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, chromium } from "@playwright/test";
import { preview } from "vite";

const directory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const profile = await mkdtemp(path.join(os.tmpdir(), "jellyree-smoke-"));
let electron, browser, server;
try {
  // Exercise the production file:// path, sandboxed preload and real IPC validation.
  electron = await _electron.launch({
    timeout: 30000,
    executablePath: process.env.JELLYREE_EXECUTABLE || undefined,
    args: [
      ...(process.env.JELLYREE_EXECUTABLE ? [] : [directory]),
      `--user-data-dir=${profile}`,
    ],
    cwd: directory,
    env: { ...process.env, JELLYREE_DEV_URL: "" },
  });
  const window = await electron.firstWindow({ timeout: 30000 });
  window.setDefaultTimeout(15000);
  const errors = [];
  window.on("pageerror", (error) => errors.push(error.message));
  await window
    .getByRole("heading", { name: "Cloudflare connection", exact: true })
    .waitFor();
  assert.equal(
    await window.evaluate(() => document.documentElement.lang),
    "en",
  );
  await window
    .getByRole("dialog")
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("es");
  await window
    .getByRole("heading", { name: "Conexión de Cloudflare", exact: true })
    .waitFor();
  await window
    .getByRole("dialog")
    .getByRole("combobox", { name: "Idioma", exact: true })
    .selectOption("ru");
  await window.reload();
  await window
    .getByRole("heading", { name: "Подключение Cloudflare" })
    .waitFor();
  const state = await window.evaluate(() => window.jellyree.settings.get());
  assert.equal(state.configured, false);
  const isolation = await electron.evaluate(({ BrowserWindow }) => {
    const prefs =
      BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      sandbox: prefs.sandbox,
      contextIsolation: prefs.contextIsolation,
      nodeIntegration: prefs.nodeIntegration,
    };
  });
  assert.deepEqual(isolation, {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
  });
  assert.equal(await window.evaluate(() => typeof window.require), "undefined");
  const validation = await window.evaluate(async () => {
    try {
      await window.jellyree.settings.test({ accountId: "invalid" });
      return "";
    } catch (e) {
      return e.message;
    }
  });
  assert.match(validation, /Account ID/);
  await window.getByRole("button", { name: "Закрыть", exact: true }).click();
  await window
    .getByRole("heading", { name: "Ваши файлы. Ваше облако." })
    .waitFor();
  await window.screenshot({
    path: path.join(os.tmpdir(), "jellyree-welcome.png"),
  });
  assert.deepEqual(errors, []);

  // Keep the real Vue renderer, preload and IPC. Replace only the cloud-facing
  // main-process handlers so destructive workflows cannot touch real storage.
  await electron.evaluate(({ ipcMain }) => {
    const state = {
      files: ["delete-me", "keep-me"].map((id) => ({
        id,
        name: `${id}.txt`,
        mime_type: "text/plain",
        size_bytes: 20,
        folder_id: null,
        favorite: false,
        trashed_at: null,
        tags: [],
        adjustments: {},
        created_at: "2026-11-24",
        updated_at: "2026-11-24",
      })),
      calls: [],
    };
    globalThis.__jellyreeIpcFixture = state;
    const replace = (channel, fn) => {
      ipcMain.removeHandler(`jellyree:${channel}`);
      ipcMain.handle(`jellyree:${channel}`, (_event, ...args) => ({
        ok: true,
        value: fn(...args),
      }));
    };
    replace("settings:get", () => ({
      configured: true,
      persisted: false,
      bucket: "ipc-test",
    }));
    replace("folders:list", () => []);
    replace("stats", () => ({
      files: state.files.length,
      bytes: 40,
      trashed: state.files.filter((f) => f.trashed_at).length,
      tags: [],
    }));
    replace("files:list", (input) => {
      const items = state.files.filter((f) =>
        input.section === "trash" ? f.trashed_at : !f.trashed_at,
      );
      return { items, total: items.length, page: 1, hasMore: false };
    });
    replace("files:update", (ids, patch) => {
      state.calls.push({ channel: "update", ids, patch });
      for (const file of state.files.filter((f) => ids.includes(f.id))) {
        if ("trashed" in patch)
          file.trashed_at = patch.trashed ? "2026-11-24" : null;
      }
    });
    replace("files:delete", (ids) => {
      if (state.files.some((f) => ids.includes(f.id) && !f.trashed_at))
        throw new Error("Only trashed files may be deleted");
      state.calls.push({ channel: "delete", ids });
      state.files = state.files.filter((f) => !ids.includes(f.id));
      return { done: ids.length };
    });
  });
  await window.reload();
  await window.getByText("delete-me.txt", { exact: true }).waitFor();
  await window
    .getByText("delete-me.txt", { exact: true })
    .click({ button: "right" });
  await window
    .getByRole("menuitem", { name: "В корзину", exact: true })
    .click();
  await window
    .locator(".main-nav button")
    .filter({ hasText: "Корзина" })
    .click();
  await window.getByText("delete-me.txt", { exact: true }).waitFor();
  await window
    .getByText("delete-me.txt", { exact: true })
    .click({ button: "right" });
  await window
    .getByRole("menuitem", { name: "Восстановить", exact: true })
    .click();
  await window.getByRole("heading", { name: "Корзина пуста" }).waitFor();
  await window.getByRole("button", { name: "Мой диск", exact: true }).click();
  await window.getByText("delete-me.txt", { exact: true }).waitFor();
  await window
    .getByRole("button", { name: "Выбрать загруженные файлы", exact: true })
    .click();
  await window
    .getByText("keep-me.txt", { exact: true })
    .click({ button: "right" });
  assert.equal(
    await window
      .getByRole("menuitem", { name: "Переименовать", exact: true })
      .count(),
    0,
  );
  await window
    .getByRole("menuitem", { name: "В корзину", exact: true })
    .click();
  await window
    .locator(".main-nav button")
    .filter({ hasText: "Корзина" })
    .click();
  await window
    .getByText("delete-me.txt", { exact: true })
    .click({ button: "right" });
  await window
    .getByRole("menuitem", { name: "Удалить навсегда", exact: true })
    .click();
  await window
    .getByRole("dialog")
    .getByRole("button", { name: "Удалить", exact: true })
    .click();
  await window.getByRole("dialog").waitFor({ state: "hidden" });
  const fixture = await electron.evaluate(
    () => globalThis.__jellyreeIpcFixture,
  );
  assert.deepEqual(
    fixture.files.map((f) => f.id),
    ["keep-me"],
  );
  assert.deepEqual(
    fixture.calls.map((c) => c.ids),
    [["delete-me"], ["delete-me"], ["delete-me", "keep-me"], ["delete-me"]],
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: real Electron IPC, trash, restore, bulk trash, permanent deletion",
  );

  // Exercise real preload conflict events and answers; cloud bytes stay mocked.
  await electron.evaluate(({ ipcMain, BrowserWindow }) => {
    const state = { batches: 0, questions: 0, answers: [], pending: null };
    globalThis.__jellyreeUploadFixture = state;
    const transfer = async (_event, ...args) => {
      state.batches++;
      let done = 0,
        skipped = 0,
        policy = null;
      for (let index = 0; index < 2; index++) {
        let answer = policy;
        if (!answer) {
          const id = `question-${state.batches}-${index}`;
          answer = await new Promise((resolve) => {
            state.pending = { id, resolve };
            state.questions++;
            BrowserWindow.getAllWindows()[0].webContents.send(
              "jellyree:upload-conflict",
              {
                id,
                name: "duplicate.jpg",
                targetPath: "Photos",
                suggestedName: `duplicate (${index + 1}).jpg`,
                remaining: 2 - index,
                total: 2,
                incomingBytes: 2000,
                existing: {
                  name: "duplicate.jpg",
                  sizeBytes: 1000,
                  updatedAt: "2026-11-24",
                },
                existingCount: 1,
              },
            );
          });
        }
        if (answer.action === "cancel")
          return {
            ok: true,
            value: { done, skipped, canceled: true, failures: [] },
          };
        if (answer.action === "skip") skipped++;
        else done++;
        if (answer.applyToAll) policy = answer;
      }
      return { ok: true, value: { done, skipped, failures: [] } };
    };
    for (const channel of ["files:pick-upload", "files:drop-upload"]) {
      ipcMain.removeHandler(`jellyree:${channel}`);
      ipcMain.handle(`jellyree:${channel}`, transfer);
    }
    ipcMain.removeHandler("jellyree:uploads:answer");
    ipcMain.handle("jellyree:uploads:answer", (_event, input) => {
      if (!state.pending || input.id !== state.pending.id)
        return { ok: false, error: "Stale question" };
      if (input.action === "rename" && input.name === "taken.jpg")
        return { ok: false, error: "Это имя уже занято. Введите другое имя." };
      const pending = state.pending;
      state.pending = null;
      state.answers.push(input);
      pending.resolve(input);
      return { ok: true };
    });
  });
  for (const action of ["Проигнорировать", "Переименовать", "Заменить"]) {
    if (action === "Заменить") {
      await window.locator(".content").evaluate((element) => {
        const transfer = new DataTransfer();
        transfer.items.add(
          new File(["test"], "duplicate.jpg", { type: "image/jpeg" }),
        );
        element.dispatchEvent(
          new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
          }),
        );
      });
    } else await window.locator(".upload-button").click();
    const dialog = window.getByRole("dialog", {
      name: "Файл с таким именем уже существует",
      exact: true,
    });
    await dialog.waitFor();
    if (action === "Проигнорировать")
      await window.screenshot({
        path: path.join(os.tmpdir(), "jellyree-conflict.png"),
      });
    assert.equal(await dialog.getByRole("checkbox").isChecked(), false);
    if (action === "Переименовать") {
      await dialog.getByRole("textbox").fill("taken.jpg");
      await dialog.getByRole("button", { name: action, exact: true }).click();
      await dialog.getByRole("alert").waitFor();
      await dialog.getByRole("textbox").fill("custom.jpg");
    }
    await dialog
      .getByRole("checkbox", {
        name: "Применить ко всем 2 совпадениям",
        exact: true,
      })
      .check();
    await dialog.getByRole("button", { name: action, exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await window.locator(".transfer-bar").waitFor({ state: "hidden" });
  }
  await window.locator(".upload-button").click();
  await window
    .getByRole("dialog", {
      name: "Файл с таким именем уже существует",
      exact: true,
    })
    .waitFor();
  await window.keyboard.press("Tab");
  await window.keyboard.press("Escape");
  await window.getByRole("dialog").waitFor({ state: "hidden" });
  await window.locator(".transfer-bar").waitFor({ state: "hidden" });
  const uploadFixture = await electron.evaluate(() => ({
    questions: globalThis.__jellyreeUploadFixture.questions,
    answers: globalThis.__jellyreeUploadFixture.answers,
  }));
  assert.equal(uploadFixture.questions, 4);
  assert.deepEqual(
    uploadFixture.answers.map((a) => a.action),
    ["skip", "rename", "replace", "cancel"],
  );
  assert.equal(uploadFixture.answers[1].name, "custom.jpg");
  assert.ok(uploadFixture.answers.slice(0, 3).every((a) => a.applyToAll));
  assert.equal(uploadFixture.answers[3].applyToAll, false);
  await window.screenshot({
    path: path.join(os.tmpdir(), "jellyree-upload-result.png"),
  });
  console.log(
    "PASS: native IPC upload-conflict modal, skip/rename/replace, validation, apply-all counts, drag-and-drop",
  );
  await electron.close();
  electron = null;
  console.log(
    "PASS: production Electron, sandbox, preload, IPC, validation, onboarding",
  );

  // Exercise connected UI states with a local deterministic Cloudflare fixture.
  server = await preview({
    root: directory,
    preview: { host: "127.0.0.1", port: 4174, strictPort: true },
  });
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 940 },
  });
  page.setDefaultTimeout(15000);
  const rendererErrors = [];
  page.on("pageerror", (error) => rendererErrors.push(error.message));
  await page.addInitScript(() => {
    if (!localStorage.getItem("jellyree-desktop-language"))
      localStorage.setItem("jellyree-desktop-language", "ru");
    const config = {
      configured: true,
      persisted: true,
      accountId: "a".repeat(32),
      databaseId: "b".repeat(36),
      bucket: "personal-library",
      prefix: "jellyree",
      hasSecrets: true,
    };
    const folders = [
      { id: "travel", name: "Путешествия", parent_id: null },
      { id: "work", name: "Проекты", parent_id: null },
    ];
    let files = [
      {
        id: "photo",
        name: "Вечер у моря.jpg",
        mime_type: "image/jpeg",
        size_bytes: 3145728,
        favorite: true,
        folder_id: null,
        trashed_at: null,
        tags: ["отпуск", "море"],
        adjustments: {},
        created_at: "2026-11-01",
        updated_at: "2026-11-01",
      },
      {
        id: "doc",
        name: "Заметки.txt",
        mime_type: "text/plain",
        size_bytes: 814,
        favorite: false,
        folder_id: null,
        trashed_at: null,
        tags: ["работа"],
        adjustments: {},
        created_at: "2026-11-02",
        updated_at: "2026-11-02",
      },
      {
        id: "video",
        name: "Выходные.mp4",
        mime_type: "video/mp4",
        size_bytes: 41943040,
        favorite: false,
        folder_id: null,
        trashed_at: null,
        tags: [],
        adjustments: {},
        created_at: "2026-11-03",
        updated_at: "2026-11-03",
      },
    ];
    for (const [id, name, rotation] of [
      ["portrait", "Портрет.jpg", 0],
      ["panorama", "Панорама.jpg", 0],
      ["rotated", "Поворот.jpg", 90],
    ]) {
      files.push({
        ...files[0],
        id,
        name,
        favorite: false,
        tags: [],
        adjustments: { rotate: rotation },
      });
    }
    const calls = [];
    window.__jellyreeBrowserCalls = calls;
    window.__jellyreeReplacePreview = () => {
      files = files.map((file, index) =>
        index === 0 ? { ...file, object_key: "new-object-key" } : file,
      );
    };
    window.jellyree = {
      setLocale: async () => {},
      onUploadConflict: () => () => {},
      settings: {
        get: async () => config,
        test: async () => ({ ok: true }),
        save: async () => config,
        clear: async () => ({ configured: false, persisted: false }),
      },
      list: async (input) => {
        let items = files.filter((f) =>
          input.section === "trash" ? f.trashed_at : !f.trashed_at,
        );
        if (input.section === "drive")
          items = items.filter((f) => f.folder_id === (input.folderId || null));
        if (input.section === "favorites")
          items = items.filter((f) => f.favorite);
        if (input.search)
          items = items.filter(
            (f) =>
              f.name.includes(input.search) ||
              f.tags.some((t) => t.includes(input.search)),
          );
        if (input.tag) items = items.filter((f) => f.tags.includes(input.tag));
        return { items, total: items.length, page: 1, hasMore: false };
      },
      folders: async () => structuredClone(folders),
      stats: async () => ({
        files: files.length,
        bytes: files.reduce((n, f) => n + f.size_bytes, 0),
        trashed: files.filter((f) => f.trashed_at).length,
        tags: ["отпуск", "море", "работа"],
      }),
      update: async (ids, patch) => {
        files = files.map((f) =>
          ids.includes(f.id)
            ? {
                ...f,
                ...patch,
                ...(patch.trashed !== undefined
                  ? { trashed_at: patch.trashed ? "2026-11-24" : null }
                  : {}),
                ...(patch.folderId !== undefined
                  ? { folder_id: patch.folderId }
                  : {}),
              }
            : f,
        );
      },
      createFolder: async (name, parent_id) => {
        const folder = { id: String(folders.length), name, parent_id };
        folders.push(folder);
        return folder;
      },
      updateFolder: async (id, patch) => {
        const folder = folders.find((f) => f.id === id);
        if (patch.name !== undefined) folder.name = patch.name;
        if (patch.parentId !== undefined) folder.parent_id = patch.parentId;
      },
      deleteFolder: async (id) => {
        folders.splice(
          folders.findIndex((f) => f.id === id),
          1,
        );
      },
      url: async (id) => {
        const [width, height] =
          id === "portrait"
            ? [300, 900]
            : id === "panorama"
              ? [1200, 200]
              : [600, 400];
        return (
          "data:image/svg+xml," +
          encodeURIComponent(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" data-object="${files.find((file) => file.id === id)?.object_key || "original"}"><defs><linearGradient id="a" x2="0" y2="1"><stop stop-color="#b4cae0"/><stop offset=".6" stop-color="#e6d5d5"/><stop offset=".61" stop-color="#729db0"/><stop offset="1" stop-color="#adc5c5"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#a)"/><circle cx="60%" cy="30%" r="35" fill="#f8e7bd"/></svg>`,
          )
        );
      },
      share: async () => ({ expiresIn: 3600 }),
      download: async () => ({ done: 1 }),
      pickUpload: async (folderId, folders) => {
        calls.push({ folderId, folders });
        return { done: 0, failures: [] };
      },
      onProgress: () => () => {},
    };
  });
  await page.goto("http://127.0.0.1:4174");
  await page.getByText("Вечер у моря.jpg", { exact: true }).waitFor();
  await page.screenshot({
    path: path.join(os.tmpdir(), "jellyree-drive.png"),
    fullPage: true,
  });
  await page.getByText("Заметки.txt", { exact: true }).click();
  await page.screenshot({
    path: path.join(os.tmpdir(), "jellyree-selection.png"),
  });
  assert.deepEqual(rendererErrors, []);
  await page
    .getByRole("button", { name: "Переименовать", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("textbox").fill("План.txt");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Сохранить", exact: true })
    .click();
  await page.getByText("План.txt", { exact: true }).first().waitFor();
  await page.getByRole("button", { name: "В корзину", exact: true }).click();
  await page.getByRole("button", { name: "Корзина" }).click();
  await page.getByText("План.txt", { exact: true }).waitFor();
  await page.getByText("План.txt", { exact: true }).click();
  await page.getByRole("button", { name: "Восстановить", exact: true }).click();
  await page.getByRole("heading", { name: "Корзина пуста" }).waitFor();
  await page.getByRole("button", { name: "Мой диск", exact: true }).click();
  await page
    .getByRole("button", { name: "Новая папка", exact: true })
    .last()
    .click();
  await page.getByRole("dialog").getByRole("textbox").fill("Архив");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Сохранить", exact: true })
    .click();
  await page.locator(".folder-card").filter({ hasText: "Архив" }).waitFor();
  await page.getByRole("button", { name: "Список", exact: true }).click();
  await page.locator(".files.list").waitFor();
  await page
    .getByRole("combobox", { name: "Язык", exact: true })
    .selectOption("es");
  await page.getByRole("heading", { name: "Mi unidad", exact: true }).waitFor();
  await page.reload();
  await page.getByRole("heading", { name: "Mi unidad", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.lang), "es");
  await page.getByText("Портрет.jpg", { exact: true }).waitFor();
  await page
    .getByRole("combobox", { name: "Idioma", exact: true })
    .selectOption("en");
  await page.getByRole("heading", { name: "My drive", exact: true }).waitFor();
  await page.locator(".avatar").click();
  const englishSettings = page.getByRole("dialog");
  await englishSettings
    .getByRole("heading", { name: "Cloudflare connection", exact: true })
    .waitFor();
  assert.equal(
    /[А-Яа-яЁё]/.test(
      (await englishSettings.innerText()).replaceAll("Русский", ""),
    ),
    false,
  );
  await englishSettings
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("es");
  await englishSettings
    .getByRole("heading", { name: "Conexión de Cloudflare", exact: true })
    .waitFor();
  await page.screenshot({
    path: path.join(os.tmpdir(), "jellyree-settings-spanish.png"),
  });
  await englishSettings
    .getByRole("button", { name: "Cerrar", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Idioma", exact: true })
    .selectOption("ru");
  console.log(
    "PASS: English default, Russian/English/Spanish live switching, translated settings and native menus, language persistence",
  );
  await page
    .getByRole("textbox", { name: "Поиск файлов и тегов" })
    .fill("море");
  await page.waitForFunction(
    () => document.querySelectorAll(".file-card").length === 1,
  );
  await page.locator(".file-card").dblclick();
  await page.getByRole("dialog", { name: "Просмотр файла" }).waitFor();
  await page.getByRole("button", { name: "Коррекция", exact: true }).click();
  await page
    .getByRole("button", { name: "Сохранить коррекцию", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Закрыть просмотр", exact: true })
    .click();

  await page.getByRole("textbox", { name: "Поиск файлов и тегов" }).fill("");
  await page.waitForFunction(
    () => document.querySelectorAll(".file-card").length === 6,
  );
  const emptyMenu = async () => {
    await page
      .locator(".content")
      .dispatchEvent("contextmenu", { clientX: 1438, clientY: 938 });
    const menu = page.getByRole("menu", {
      name: "Действия в папке",
      exact: true,
    });
    await menu.waitFor();
    const bounds = await menu.boundingBox();
    assert.ok(
      bounds.x >= 0 &&
        bounds.y >= 0 &&
        bounds.x + bounds.width <= 1440 &&
        bounds.y + bounds.height <= 940,
      JSON.stringify({ bounds, viewport: page.viewportSize() }),
    );
    return menu;
  };
  await (
    await emptyMenu()
  )
    .getByRole("menuitem", { name: "Галерея без обрезки", exact: true })
    .click();
  await page.locator(".files.gallery").waitFor();
  for (const name of ["Портрет.jpg", "Панорама.jpg", "Поворот.jpg"]) {
    const img = page.locator(`.files.gallery img[alt="${name}"]`);
    await img.scrollIntoViewIfNeeded();
    await img.evaluate((image) => image.decode());
    await page.waitForFunction((name) => {
      const image = document.querySelector(`.files.gallery img[alt="${name}"]`);
      return image?.parentElement.classList.contains("natural-loaded");
    }, name);
    const measured = await img.evaluate((image) => {
      const frame = image.parentElement.getBoundingClientRect(),
        bounds = image.getBoundingClientRect();
      return {
        ratio: frame.width / frame.height,
        contained:
          bounds.left >= frame.left - 1 &&
          bounds.right <= frame.right + 1 &&
          bounds.top >= frame.top - 1 &&
          bounds.bottom <= frame.bottom + 1,
      };
    });
    const expected =
      name === "Портрет.jpg" ? 1 / 3 : name === "Панорама.jpg" ? 6 : 2 / 3;
    assert.ok(
      Math.abs(measured.ratio - expected) < 0.03,
      `${name}: original aspect ratio`,
    );
    assert.equal(
      measured.contained,
      true,
      `${name}: complete image fits its preview`,
    );
  }
  const oldWidth = (await page.locator(".file-card").first().boundingBox())
    .width;
  const size = page.getByRole("slider", { name: "Размер превью" });
  await size.focus();
  await size.press("End");
  await page.waitForFunction(
    () => localStorage.getItem("jellyree-desktop-preview-size") === "420",
  );
  assert.ok(
    (await page.locator(".file-card").first().boundingBox()).width > oldWidth,
  );
  await page.reload();
  await page.locator(".files.gallery").waitFor();
  assert.equal(
    await page.getByRole("slider", { name: "Размер превью" }).inputValue(),
    "420",
  );
  await page.screenshot({
    path: path.join(os.tmpdir(), "jellyree-gallery.png"),
    fullPage: true,
  });

  // Context actions must operate on the clicked item or existing multiselection.
  await page
    .getByText("Вечер у моря.jpg", { exact: true })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Переименовать", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("textbox").fill("Море.jpg");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Сохранить", exact: true })
    .click();
  await page.getByText("Море.jpg", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Снять выделение", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Выбрать Море.jpg", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Выбрать Заметки.txt", exact: true })
    .click();
  await page
    .getByText("Заметки.txt", { exact: true })
    .click({ button: "right" });
  assert.equal(
    await page
      .getByRole("menuitem", { name: "Переименовать", exact: true })
      .count(),
    0,
  );
  await page
    .getByRole("menuitem", { name: "Изменить теги", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("textbox").fill("проверка");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Сохранить", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(await page.locator(".file-card.selected").count(), 2);
  await page
    .getByText("Панорама.jpg", { exact: true })
    .click({ button: "right" });
  assert.equal(await page.locator(".file-card.selected").count(), 1);
  await page.keyboard.press("Escape");
  await page.getByRole("menu").waitFor({ state: "hidden" });
  assert.equal(await page.locator(".file-card.selected").count(), 1);
  const portrait = page
    .locator(".file-card")
    .filter({ hasText: "Портрет.jpg" });
  await portrait.focus();
  await portrait.press("Shift+F10");
  await page
    .getByRole("menu", { name: "Действия с файлами", exact: true })
    .waitFor();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await page.getByRole("menu").waitFor({ state: "hidden" });

  await page
    .locator(".folder-card")
    .filter({ hasText: "Путешествия" })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Новая вложенная папка", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("textbox").fill("Внутри");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Сохранить", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.locator(".folder-card").filter({ hasText: "Путешествия" }).click();
  await page.locator(".folder-card").filter({ hasText: "Внутри" }).waitFor();
  await page
    .locator(".main-nav")
    .getByRole("button", { name: "Мой диск", exact: true })
    .click();
  await page
    .locator(".tree-row")
    .filter({ hasText: "Путешествия" })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Переименовать папку", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("textbox").fill("Поездки");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Сохранить", exact: true })
    .click();
  await page.locator(".folder-card").filter({ hasText: "Поездки" }).waitFor();
  await page
    .locator(".folder-card")
    .filter({ hasText: "Поездки" })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Загрузить файлы сюда", exact: true })
    .click();
  await page.waitForFunction(() => window.__jellyreeBrowserCalls.length === 1);
  assert.deepEqual(
    await page.evaluate(() => window.__jellyreeBrowserCalls[0]),
    { folderId: "travel", folders: false },
  );
  await page
    .locator(".tree-row")
    .filter({ hasText: "Внутри" })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Удалить пустую папку", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Удалить", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.locator(".folder-card").filter({ hasText: "Поездки" }).waitFor();
  assert.equal(
    await page.locator(".breadcrumbs").count(),
    0,
    "deleting another folder must keep the current location",
  );
  await (
    await emptyMenu()
  )
    .getByRole("menuitem", { name: "Новая папка", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("textbox").fill("Пустая");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Сохранить", exact: true })
    .click();
  await page
    .locator(".folder-card")
    .filter({ hasText: "Пустая" })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Удалить пустую папку", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Удалить", exact: true })
    .click();
  await page
    .locator(".folder-card")
    .filter({ hasText: "Пустая" })
    .waitFor({ state: "hidden" });
  await emptyMenu();
  await page.getByRole("textbox", { name: "Поиск файлов и тегов" }).click();
  await page.getByRole("menu").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Сетка", exact: true }).click();
  await page.locator(".files.grid").waitFor();
  await page.getByRole("button", { name: "Список", exact: true }).click();
  await page.locator(".files.list").waitFor();
  console.log(
    "PASS: uncropped portrait/panorama/rotation gallery, persistent preview size, file/folder/empty-space menus, multiselection, keyboard and edge placement",
  );
  const replacedPreview = page
    .locator(".file-card")
    .filter({ hasText: "Море.jpg" })
    .locator("img");
  await replacedPreview.scrollIntoViewIfNeeded();
  await replacedPreview.evaluate((image) => image.decode());
  const previousSrc = await replacedPreview.getAttribute("src");
  await page.evaluate(() => window.__jellyreeReplacePreview());
  await page
    .locator(".topbar")
    .getByRole("button", { name: "Обновить", exact: true })
    .click();
  await page.waitForFunction((previous) => {
    const image = document.querySelector('.file-card img[alt="Море.jpg"]');
    return image?.getAttribute("src") && image.getAttribute("src") !== previous;
  }, previousSrc);
  console.log("PASS: replaced file refreshes its cached thumbnail");
  assert.deepEqual(rendererErrors, []);
  console.log(
    "PASS: connected UI, rename, trash, restore, create folder, list, search, preview, edit",
  );
} finally {
  await electron?.close();
  await browser?.close();
  await server?.httpServer.close();
  await rm(profile, { recursive: true, force: true });
}
