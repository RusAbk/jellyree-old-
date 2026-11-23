import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  safeStorage,
  Menu,
  clipboard,
} from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ConfigStore } from "./config.mjs";
import { Library } from "./library.mjs";

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
      result = result.replaceAll(store.current[key], "[скрыто]");
  return result;
};
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
        throw new Error("Подключите хранилище в настройках.");
      if (needsLibrary) activeOperations++;
      try {
        return { ok: true, value: await fn(...args) };
      } finally {
        if (needsLibrary) activeOperations--;
      }
    } catch (error) {
      return {
        ok: false,
        error: redact(error.message || "Операция не выполнена."),
      };
    }
  });
}
async function connectionOperation(fn) {
  if (activeOperations || changingConnection)
    throw new Error("Дождитесь завершения текущих операций.");
  changingConnection = true;
  try {
    return await fn();
  } finally {
    changingConnection = false;
  }
}
async function transferOperation(fn) {
  if (transfer)
    throw new Error("Дождитесь завершения текущей передачи файлов.");
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
function registerHandlers() {
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
          library = candidate;
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
        library?.close();
        library = null;
        return { configured: false, persisted: false };
      }),
    false,
  );
  handle("files:list", (input) => library.list(input));
  handle("files:update", (ids, patch) => library.updateFiles(ids, patch));
  handle("files:delete", (ids) => library.deletePermanently(ids));
  handle("files:url", (id) => library.url(id));
  handle("files:share", async (id) => {
    const url = await library.url(id, true);
    clipboard.writeText(url);
    return { expiresIn: 3600 };
  });
  handle("files:download", (ids) =>
    transferOperation(async () => {
      if (!Array.isArray(ids) || !ids.length || ids.length > 1000)
        throw new Error("Выберите от 1 до 1000 файлов.");
      if (ids.length === 1) {
        const file = await library.file(ids[0]);
        const result = await dialog.showSaveDialog(window, {
          defaultPath: path.basename(file.name),
        });
        if (result.canceled) return { done: 0 };
        await library.download(ids[0], result.filePath);
        return { done: 1 };
      }
      const result = await dialog.showOpenDialog(window, {
        properties: ["openDirectory", "createDirectory"],
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
  handle("files:pick-upload", (folderId, folders = false) =>
    transferOperation(async () => {
      const result = await dialog.showOpenDialog(window, {
        properties: folders
          ? ["openDirectory", "multiSelections"]
          : ["openFile", "multiSelections"],
      });
      if (result.canceled) return { done: 0, failures: [] };
      return library.uploadPaths(result.filePaths, folderId, (value) =>
        progress({ kind: "upload", ...value }),
      );
    }),
  );
  handle("files:drop-upload", (paths, folderId) =>
    transferOperation(() =>
      library.uploadPaths(paths, folderId, (value) =>
        progress({ kind: "upload", ...value }),
      ),
    ),
  );
  handle("files:import", () =>
    transferOperation(() =>
      library.importBucket((value) => progress({ kind: "import", ...value })),
    ),
  );
  handle("folders:list", () => library.folders());
  handle("folders:create", (name, parentId) =>
    library.createFolder(name, parentId),
  );
  handle("folders:update", (id, input) => library.updateFolder(id, input));
  handle("folders:delete", (id) => library.deleteFolder(id));
  handle("stats", () => library.stats());
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
  window.on("close", (event) => {
    if (activeOperations || changingConnection) {
      const choice = dialog.showMessageBoxSync(window, {
        type: "question",
        buttons: ["Продолжить работу", "Закрыть приложение"],
        defaultId: 0,
        cancelId: 0,
        message:
          "Ещё выполняются операции с облаком. Закрытие может прервать передачу. Закрыть приложение?",
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
      store = new ConfigStore(
        path.join(app.getPath("userData"), "jellyree-cloud"),
        safeStorage,
      );
      try {
        await store.load();
        if (store.current) {
          library = new Library(store.current);
        }
      } catch (error) {
        startupError = redact(error.message);
      }
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          ...(process.platform === "darwin"
            ? [
                {
                  label: "Jellyree",
                  submenu: [
                    { role: "about" },
                    { type: "separator" },
                    { role: "quit" },
                  ],
                },
              ]
            : []),
          {
            label: "Правка",
            submenu: [
              { role: "undo" },
              { role: "redo" },
              { type: "separator" },
              { role: "cut" },
              { role: "copy" },
              { role: "paste" },
              { role: "selectAll" },
            ],
          },
          {
            label: "Вид",
            submenu: [
              { role: "resetZoom" },
              { role: "zoomIn" },
              { role: "zoomOut" },
              { role: "togglefullscreen" },
              ...(devUrl ? [{ role: "toggleDevTools" }] : []),
            ],
          },
        ]),
      );
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
