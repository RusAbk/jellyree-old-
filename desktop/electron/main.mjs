import { t } from "./locales.mjs";
import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  safeStorage,
  Menu,
  clipboard,
  protocol,
  net,
} from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ConfigStore } from "./config.mjs";
import { Library } from "./library.mjs";
import { isImageFile } from "./image-formats.mjs";
import { UploadConflictBroker } from "./upload-conflicts.mjs";
import { OperationQueue } from "./operation-queue.mjs";
import { ThumbnailCache, thumbnailKey } from "./thumbnail-cache.mjs";
import { ThumbnailMedia } from "./thumbnail-media.mjs";
import { validateVideoFrame, videoFrameName } from "./video-frames.mjs";
protocol.registerSchemesAsPrivileged([
  {
    scheme: "jellyree-media",
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);
const thumbnailMedia = new ThumbnailMedia((url, options) =>
  net.fetch(url, options),
);
let thumbnailCache;
const previewRequests = new Map();
const cacheNamespace = () => `${library.id}:${library.config.databaseId}`;
const catalogMutations = new Set([
  "files:update",
  "files:delete",
  "files:save-text-document",
  "files:save-video-frame",
  "files:pick-upload",
  "files:drop-upload",
  "files:retry-upload",
  "files:import",
  "folders:create",
  "folders:update",
  "folders:delete",
]);
const uploadConflicts = new UploadConflictBroker();
const uploads = new OperationQueue();
const documentWrites = new OperationQueue();
let documentDraftOwner = "";
import { setLanguage } from "./locales.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const devUrl = process.env.JELLYREE_DEV_URL;
if (devUrl && devUrl !== "http://127.0.0.1:5174")
  throw new Error("Unexpected development origin");
const indexUrl = pathToFileURL(path.join(directory, "../dist/index.html")).href;
let window,
  store,
  library,
  activeOperations = 0,
  changingConnection = false,
  transfer = false;
let startupError = "";
const redact = (message) => {
  let result = String(message);
  for (const key of ["apiToken", "accessKeyId", "secretAccessKey"])
    if (store?.current?.[key])
      result = result.replaceAll(store.current[key], t("[скрыто]"));
  return result;
};
function enableCatalogCache(source) {
  const name = `${source.id}-${source.config.databaseId}.sqlite`;
  try {
    source.enableCatalogCache(
      path.join(app.getPath("userData"), "catalog-v1", name),
    );
  } catch (error) {
    console.warn(
      "Could not open the local catalog cache:",
      redact(error.message),
    );
  }
}
async function previewRequest(id, operation, timeoutMs = 45000) {
  if (id !== undefined && (typeof id !== "string" || !id || id.length > 128))
    throw new TypeError("Invalid preview request");
  const controller = new AbortController();
  if (id) {
    previewRequests.get(id)?.abort();
    previewRequests.set(id, controller);
  }
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException("Preview request timed out", "TimeoutError"),
      ),
    timeoutMs,
  );
  let abort;
  const interrupted = new Promise((_, reject) => {
    abort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      interrupted,
    ]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", abort);
    if (id && previewRequests.get(id) === controller)
      previewRequests.delete(id);
  }
}
function handle(name, fn, needsLibrary = true) {
  ipcMain.handle(`jellyree:${name}`, async (event, ...args) => {
    const url = event.senderFrame?.url;
    if (
      event.sender !== window?.webContents ||
      event.senderFrame !== event.sender.mainFrame ||
      !(devUrl ? url === `${devUrl}/` : url === indexUrl)
    )
      throw new Error("Untrusted IPC sender");
    try {
      if (needsLibrary && (!library || changingConnection))
        throw new Error(t("Подключите хранилище в настройках."));
      if (needsLibrary) activeOperations++;
      try {
        return { ok: true, value: await fn(...args) };
      } finally {
        if (catalogMutations.has(name)) library?.catalog?.invalidate();
        if (needsLibrary) activeOperations--;
      }
    } catch (error) {
      return {
        ok: false,
        error: redact(error.message || t("Операция не выполнена.")),
      };
    }
  });
}
async function connectionOperation(fn) {
  if (documentDraftOwner)
    throw new Error(
      t("Сначала сохраните или закройте редактируемый документ."),
    );
  if (activeOperations || changingConnection)
    throw new Error(t("Дождитесь завершения текущих операций."));
  changingConnection = true;
  try {
    return await fn();
  } finally {
    changingConnection = false;
  }
}
async function transferOperation(fn) {
  if (transfer)
    throw new Error(t("Дождитесь завершения текущей передачи файлов."));
  transfer = true;
  try {
    return await fn();
  } finally {
    transfer = false;
  }
}
function progress(value) {
  if (!window?.isDestroyed())
    window.webContents.send("jellyree:progress", value);
}
function runUpload(jobId, task) {
  progress({ kind: "upload", jobId, phase: "queued", done: 0 });
  return uploads.run(() => {
    progress({ kind: "upload", jobId, phase: "preparing", done: 0 });
    return task(
      (value) =>
        progress({ kind: "upload", jobId, phase: "uploading", ...value }),
      (info, validate) =>
        uploadConflicts.request(info, validate, (value) =>
          window.webContents.send("jellyree:upload-conflict", {
            ...value,
            jobId,
          }),
        ),
    );
  });
}
function uploadPaths(paths, folderId, jobId) {
  return runUpload(jobId, (report, resolveConflict) =>
    library.uploadPaths(paths, folderId, report, resolveConflict),
  );
}
function refreshMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin"
        ? [
            {
              label: "Jellyree",
              submenu: [
                { role: "about", label: t("О программе") },
                { type: "separator" },
                { role: "quit", label: t("Выход") },
              ],
            },
          ]
        : []),
      {
        label: t("Правка"),
        submenu: [
          { role: "undo", label: t("Отменить действие") },
          { role: "redo", label: t("Повторить действие") },
          { type: "separator" },
          { role: "cut", label: t("Вырезать") },
          { role: "copy", label: t("Копировать") },
          { role: "paste", label: t("Вставить") },
          { role: "selectAll", label: t("Выделить всё") },
        ],
      },
      {
        label: t("Вид"),
        submenu: [
          { role: "resetZoom", label: t("Сбросить масштаб") },
          { role: "zoomIn", label: t("Увеличить масштаб") },
          { role: "zoomOut", label: t("Уменьшить масштаб") },
          { role: "togglefullscreen", label: t("Полный экран") },
          ...(devUrl
            ? [{ role: "toggleDevTools", label: t("Инструменты разработчика") }]
            : []),
        ],
      },
    ]),
  );
}
function registerHandlers() {
  handle(
    "app:locale",
    (value) => {
      if (!["en", "ru", "es"].includes(value))
        throw new Error(t("Неподдерживаемый язык."));
      setLanguage(value);
      refreshMenu();
    },
    false,
  );
  handle("uploads:answer", (input) => uploadConflicts.answer(input), false);
  handle("settings:get", () => ({ ...store.summary(), startupError }), false);
  handle(
    "settings:test",
    (input) =>
      connectionOperation(async () => {
        const candidate = new Library(store.merge(input));
        try {
          return await candidate.check();
        } finally {
          candidate.close();
        }
      }),
    false,
  );
  handle(
    "settings:save",
    (input) =>
      connectionOperation(async () => {
        const config = store.merge(input),
          candidate = new Library(config);
        try {
          await candidate.check();
          await candidate.initialize();
          const summary = await store.save(config);
          library?.close();
          enableCatalogCache(candidate);
          library = candidate;
          thumbnailMedia.clear();
          startupError = "";
          return summary;
        } catch (error) {
          candidate.close();
          throw error;
        }
      }),
    false,
  );
  handle(
    "settings:clear",
    () =>
      connectionOperation(async () => {
        await store.clear();
        const previous = library;
        library = null;
        previous?.close(true);
        thumbnailMedia.clear();
        return { configured: false, persisted: false };
      }),
    false,
  );
  handle("files:list", (input) => library.list(input));
  handle("files:update", (ids, patch) => library.updateFiles(ids, patch));
  handle("files:delete", (ids) => library.deletePermanently(ids));
  handle("files:url", (id) => library.url(id));
  handle("files:image-source", (id, requestId, pxz) => {
    const sourceLibrary = library;
    return previewRequest(requestId, (signal) =>
      sourceLibrary.imageSource(id, {
        signal,
        expectedObjectKey: pxz?.objectKey,
        thumbnail: pxz?.thumbnail === true,
      }),
    );
  });
  handle(
    "previews:cancel",
    (id) => {
      previewRequests.get(id)?.abort();
    },
    false,
  );
  handle("media:release", (url) => thumbnailMedia.release(url), false);
  handle("files:document-source", (id, expectedObjectKey) =>
    library.documentSource(id, expectedObjectKey),
  );
  handle("files:save-text-document", (id, expectedObjectKey, data) =>
    documentWrites.run(() =>
      library.saveTextDocument(id, expectedObjectKey, data),
    ),
  );
  handle(
    "documents:draft",
    (owner, dirty) => {
      if (
        typeof owner !== "string" ||
        owner.length > 128 ||
        typeof dirty !== "boolean"
      )
        throw new TypeError("Invalid document state");
      if (dirty) documentDraftOwner = owner;
      else if (documentDraftOwner === owner) documentDraftOwner = "";
    },
    false,
  );
  handle("files:video-source", async (revision) => {
    thumbnailKey(cacheNamespace(), revision);
    const sourceLibrary = library;
    const resolve = async () => {
      const file = await sourceLibrary.file(revision.id);
      if (
        !file.mime_type.startsWith("video/") ||
        file.object_key !== revision.objectKey
      )
        throw new Error(t("Видео изменилось. Откройте его заново."));
      return sourceLibrary.urlForFile(file);
    };
    await resolve();
    return thumbnailMedia.create(resolve);
  });
  handle("files:save-video-frame", (id, expectedObjectKey, timestamp, data) =>
    uploads.run(() =>
      library.saveVideoFrame(id, expectedObjectKey, timestamp, data),
    ),
  );
  handle(
    "files:download-video-frame",
    async (id, expectedObjectKey, timestamp, data) => {
      try {
        validateVideoFrame(data, timestamp);
      } catch {
        throw new Error(t("Некорректный стопкадр видео."));
      }
      const file = await library.file(id);
      if (
        !file.mime_type.startsWith("video/") ||
        file.object_key !== expectedObjectKey
      )
        throw new Error(t("Видео изменилось. Откройте его заново."));
      const result = await dialog.showSaveDialog(window, {
        title: t("Скачать стопкадр"),
        defaultPath: videoFrameName(file.name, timestamp),
        filters: [{ name: "PNG", extensions: ["png"] }],
      });
      if (result.canceled || !result.filePath) return { saved: false };
      const { writeFile } = await import("node:fs/promises");
      await writeFile(result.filePath, data);
      return { saved: true };
    },
  );
  handle("thumbnails:get", (revision) =>
    previewRequest(
      undefined,
      () => thumbnailCache.get(thumbnailKey(cacheNamespace(), revision)),
      5000,
    ),
  );
  handle("thumbnails:put", (revision, entry, epoch) =>
    previewRequest(
      undefined,
      () =>
        thumbnailCache.put(
          thumbnailKey(cacheNamespace(), revision),
          entry,
          epoch,
        ),
      5000,
    ),
  );
  handle(
    "thumbnails:stats",
    () => previewRequest(undefined, () => thumbnailCache.stats(), 10000),
    false,
  );
  handle(
    "thumbnails:clear",
    () => previewRequest(undefined, () => thumbnailCache.clear(), 10000),
    false,
  );
  handle("thumbnails:source", (revision, requestId) =>
    previewRequest(
      requestId,
      async (signal) => {
        thumbnailKey(cacheNamespace(), revision);
        const sourceLibrary = library;
        const file = await sourceLibrary.file(revision.id, { signal });
        if (
          file.object_key !== revision.objectKey ||
          file.size_bytes !== revision.sizeBytes
        )
          throw new Error(
            t(
              "Изображение изменилось. Откройте его заново перед сохранением правок.",
            ),
          );
        const url = await sourceLibrary.urlForFile(file);
        signal.throwIfAborted();
        return thumbnailMedia.create(url);
      },
      15000,
    ),
  );
  handle("files:export-image", async (id, data, format) => {
    const file = await library.file(id);
    if (
      !isImageFile(file) ||
      !["png", "jpeg", "webp"].includes(format) ||
      !(data instanceof Uint8Array) ||
      !data.length ||
      data.length > 128 * 1024 * 1024
    )
      throw new Error(t("Некорректное изображение для экспорта."));
    const ext = format === "jpeg" ? "jpg" : format;
    const result = await dialog.showSaveDialog(window, {
      title: t("Экспорт изображения"),
      defaultPath: `${path.basename(file.name, path.extname(file.name))}-edited.${ext}`,
      filters: [{ name: format.toUpperCase(), extensions: [ext] }],
    });
    if (result.canceled || !result.filePath) return { saved: false };
    const { writeFile } = await import("node:fs/promises");
    await writeFile(result.filePath, data);
    return { saved: true };
  });
  handle("files:share", async (id) => {
    const url = await library.url(id, true);
    clipboard.writeText(url);
    return { expiresIn: 3600 };
  });
  handle("files:download", (ids) =>
    transferOperation(async () => {
      if (!Array.isArray(ids) || !ids.length || ids.length > 1000)
        throw new Error(t("Выберите от 1 до 1000 файлов."));
      if (ids.length === 1) {
        const file = await library.file(ids[0]);
        const result = await dialog.showSaveDialog(window, {
          defaultPath: path.basename(file.name),
          title: t("Скачать оригинал"),
          buttonLabel: t("Сохранить"),
        });
        if (result.canceled) return { done: 0 };
        await library.download(ids[0], result.filePath);
        return { done: 1 };
      }
      const result = await dialog.showOpenDialog(window, {
        properties: ["openDirectory", "createDirectory"],
        title: t("Папка для скачивания"),
        buttonLabel: t("Выбрать папку"),
      });
      if (result.canceled) return { done: 0 };
      const used = new Set();
      const { access } = await import("node:fs/promises");
      let done = 0;
      for (const id of ids) {
        const file = await library.file(id);
        const safeName =
          path.basename(file.name).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") || id;
        const ext = path.extname(safeName),
          stem = path.basename(safeName, ext);
        let name = safeName,
          suffix = 1;
        while (true) {
          let exists = false;
          try {
            await access(path.join(result.filePaths[0], name));
            exists = true;
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
          }
          if (!exists && !used.has(name.toLowerCase())) break;
          name = `${stem} (${suffix++})${ext}`;
        }
        used.add(name.toLowerCase());
        await library.download(id, path.join(result.filePaths[0], name));
        done++;
        progress({ kind: "download", done, total: ids.length, name });
      }
      return { done };
    }),
  );
  handle("files:pick-upload", async (folderId, folders = false, jobId) => {
    const result = await dialog.showOpenDialog(window, {
      title: folders ? t("Загрузить папку") : t("Загрузить файлы"),
      buttonLabel: t("Загрузить"),
      properties: folders
        ? ["openDirectory", "multiSelections"]
        : ["openFile", "multiSelections"],
    });
    if (result.canceled)
      return {
        done: 0,
        skipped: 0,
        canceled: true,
        failures: [],
        warnings: [],
      };
    return uploadPaths(result.filePaths, folderId, jobId);
  });
  handle("files:drop-upload", (paths, folderId, jobId) =>
    uploadPaths(paths, folderId, jobId),
  );
  handle("files:retry-upload", (ids, jobId) =>
    runUpload(jobId, (report, resolveConflict) =>
      library.retryUploads(ids, report, resolveConflict),
    ),
  );
  handle("files:import", () =>
    uploads.run(() =>
      library.importBucket((value) => progress({ kind: "import", ...value })),
    ),
  );
  handle("folders:list", () => library.cachedFolders());
  handle("folders:create", (name, parentId) =>
    library.createFolder(name, parentId),
  );
  handle("folders:update", (id, input) => library.updateFolder(id, input));
  handle("folders:delete", (id) => library.deleteFolder(id));
  handle("stats", () => library.cachedStats());
}
async function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 960,
    minHeight: 660,
    backgroundColor: "#f4f6fb",
    title: "Jellyree",
    webPreferences: {
      preload: path.join(directory, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.on("will-prevent-unload", (event) => {
    const choice = dialog.showMessageBoxSync(window, {
      type: "question",
      buttons: [t("Продолжить редактирование"), t("Не сохранять")],
      defaultId: 0,
      cancelId: 0,
      message: t(
        "Есть несохранённые изменения документа. Закрыть без сохранения?",
      ),
    });
    if (choice === 1) {
      documentDraftOwner = "";
      event.preventDefault();
    }
  });
  window.on("closed", () => uploadConflicts.cancel());
  window.on("close", (event) => {
    if (activeOperations || changingConnection) {
      const choice = dialog.showMessageBoxSync(window, {
        type: "question",
        buttons: [t("Продолжить работу"), t("Закрыть приложение")],
        defaultId: 0,
        cancelId: 0,
        message: t(
          "Ещё выполняются операции с облаком. Закрытие может прервать передачу. Закрыть приложение?",
        ),
      });
      if (choice === 0) event.preventDefault();
    }
  });
  await window.loadURL(devUrl || indexUrl);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  app
    .whenReady()
    .then(async () => {
      app.setName("Jellyree");
      thumbnailCache = new ThumbnailCache(
        path.join(app.getPath("userData"), "thumbnails-v1"),
      );
      protocol.handle("jellyree-media", (request) =>
        thumbnailMedia.handle(request),
      );
      store = new ConfigStore(
        path.join(app.getPath("userData"), "jellyree-cloud"),
        safeStorage,
      );
      try {
        await store.load();
        if (store.current) {
          library = new Library(store.current);
          enableCatalogCache(library);
        }
      } catch (error) {
        startupError = redact(error.message);
      }
      refreshMenu();
      registerHandlers();
      await createWindow();
      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
      app.on("window-all-closed", () => {
        if (process.platform !== "darwin") app.quit();
      });
      app.on("before-quit", () => library?.close());
    })
    .catch((error) => {
      console.error(redact(error.message));
      app.quit();
    });
}
