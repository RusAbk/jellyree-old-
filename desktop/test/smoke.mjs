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
    window.jellyree = {
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
      url: async () =>
        "data:image/svg+xml," +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><defs><linearGradient id="a" x2="0" y2="1"><stop stop-color="#b4cae0"/><stop offset=".6" stop-color="#e6d5d5"/><stop offset=".61" stop-color="#729db0"/><stop offset="1" stop-color="#adc5c5"/></linearGradient></defs><rect width="600" height="400" fill="url(#a)"/><circle cx="420" cy="155" r="35" fill="#f8e7bd"/></svg>',
        ),
      share: async () => ({ expiresIn: 3600 }),
      download: async () => ({ done: 1 }),
      pickUpload: async () => ({ done: 0, failures: [] }),
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
