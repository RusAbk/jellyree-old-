import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

  // Leave the production profile store and IPC intact, and fake Cloudflare.
  await electron.evaluate(async ({ app }) => {
    const path = process.getBuiltinModule("node:path");
    const { pathToFileURL } = process.getBuiltinModule("node:url");
    const vm = process.getBuiltinModule("node:vm");
    const load = vm.runInThisContext("(url) => import(url)", {
      importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    });
    const { Library } = await load(
      pathToFileURL(path.join(app.getAppPath(), "electron/library.mjs")).href,
    );
    const fixture = { holdNextList: false, release: null, original: {} };
    globalThis.__jellyreeProfilesFixture = fixture;
    const cloud = {
      async check() {
        return { ok: true };
      },
      async initialize() {},
      async list() {
        if (fixture.holdNextList) {
          fixture.holdNextList = false;
          await new Promise((resolve) => {
            fixture.release = resolve;
          });
          fixture.release = null;
        }
        const name = this.config.databaseId.startsWith("b")
          ? "profile-first.txt"
          : "profile-second.txt";
        return {
          page: 1,
          hasMore: false,
          items: [
            {
              id: "same-file-id",
              object_key: "same-object-key",
              name,
              folder_id: null,
              mime_type: "text/plain",
              size_bytes: 50,
              favorite: false,
              trashed_at: null,
              tags: [],
              adjustments: {},
              created_at: "2026-11-25",
              updated_at: "2026-11-25",
            },
          ],
        };
      },
      async cachedFolders() {
        return [];
      },
      async cachedStats() {
        return { files: 1, bytes: 50, trashed: 0, tags: [] };
      },
    };
    for (const [name, method] of Object.entries(cloud)) {
      fixture.original[name] = Library.prototype[name];
      Library.prototype[name] = method;
    }
    fixture.restore = () => Object.assign(Library.prototype, fixture.original);
  });
  const profileDialog = window.getByRole("dialog", {
    name: "Подключение Cloudflare",
    exact: true,
  });
  const connectionTrigger = (target) =>
    target.getByRole("button", {
      name: "Переключить подключение",
      exact: true,
    });
  const connectionPicker = window.getByRole("dialog", {
    name: "Подключения",
    exact: true,
  });
  const openProfileSettings = async () => {
    await connectionTrigger(window).click();
    await connectionPicker
      .getByRole("button", { name: "Настройки подключения", exact: true })
      .click();
  };
  const fillProfile = async (name, databaseId) => {
    await profileDialog
      .getByLabel("Название подключения", { exact: true })
      .fill(name);
    await profileDialog
      .getByLabel("ID аккаунта Cloudflare", { exact: true })
      .fill("a".repeat(32));
    await profileDialog
      .getByLabel("ID базы данных", { exact: true })
      .fill(databaseId);
    await profileDialog
      .getByLabel("Имя bucket", { exact: true })
      .fill("shared-vault");
    await profileDialog
      .getByLabel(/API-токен Cloudflare/)
      .fill("fake-d1-token-for-" + name);
    await profileDialog
      .getByLabel("ID ключа доступа R2", { exact: true })
      .fill("fake-r2-key-for-" + name);
    await profileDialog
      .getByLabel(/Секретный ключ R2/)
      .fill("fake-r2-secret-for-" + name);
    await profileDialog
      .getByRole("button", { name: "Сохранить и открыть", exact: true })
      .click();
    await profileDialog.waitFor({ state: "hidden" });
  };
  await openProfileSettings();
  await fillProfile("Первый", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  await window.getByText("profile-first.txt", { exact: true }).waitFor();
  await connectionTrigger(window).click();
  await connectionPicker
    .getByRole("button", { name: "Добавить подключение", exact: true })
    .click();
  assert.equal(
    await profileDialog
      .getByLabel("ID базы данных", { exact: true })
      .inputValue(),
    "",
  );
  assert.equal(
    await profileDialog
      .getByLabel(/API-токен Cloudflare/)
      .getAttribute("required"),
    "",
  );
  await fillProfile("Второй", "cccccccc-cccc-cccc-cccc-cccccccccccc");
  await window.getByText("profile-second.txt", { exact: true }).waitFor();
  await connectionTrigger(window).click();
  const current = connectionPicker.locator('[aria-current="true"]');
  await current.getByText("Второй", { exact: true }).waitFor();
  await current.getByText("shared-vault/jellyree", { exact: true }).waitFor();
  await connectionPicker.press("Escape");
  await connectionPicker.waitFor({ state: "hidden" });
  assert.equal(
    await connectionTrigger(window).getAttribute("aria-expanded"),
    "false",
  );
  assert.equal(
    await connectionTrigger(window).evaluate(
      (button) => button === document.activeElement,
    ),
    true,
  );
  const profileState = await window.evaluate(() =>
    window.jellyree.settings.get(),
  );
  assert.equal(profileState.profiles.length, 2);
  assert.ok(!JSON.stringify(profileState).includes("fake-d1-token"));
  assert.ok(!JSON.stringify(profileState).includes("fake-r2-secret"));
  const oldRevision = {
    id: "same-file-id",
    objectKey: "same-object-key",
    mimeType: "image/jpeg",
    sizeBytes: 50,
    adjustments: {},
  };
  const { epoch } = await window.evaluate(
    (revision) => window.jellyree.thumbnails.get(revision),
    oldRevision,
  );
  await electron.evaluate(() => {
    globalThis.__jellyreeProfilesFixture.holdNextList = true;
  });
  await window.getByRole("button", { name: "Обновить", exact: true }).click();
  await connectionTrigger(window).click();
  await connectionPicker.press("ArrowDown");
  const firstConnection = connectionPicker.getByRole("button", {
    name: "Открыть подключение «Первый»",
    exact: true,
  });
  assert.equal(
    await firstConnection.evaluate(
      (button) => button === document.activeElement,
    ),
    true,
  );
  await firstConnection.press("Enter");
  await window.waitForFunction(
    () => document.querySelector(".app-shell").inert,
  );
  await electron.evaluate(() => globalThis.__jellyreeProfilesFixture.release());
  await window.getByText("profile-first.txt", { exact: true }).waitFor();
  assert.equal(
    await window.getByText("profile-second.txt", { exact: true }).count(),
    0,
  );
  assert.equal(
    await window.evaluate(
      ({ revision, epoch }) =>
        window.jellyree.thumbnails.put(
          revision,
          { width: 2, height: 2, duration: 0, data: new Uint8Array(16) },
          epoch,
        ),
      { revision: oldRevision, epoch },
    ),
    false,
  );
  const secondId = profileState.activeProfileId;
  await openProfileSettings();
  await profileDialog
    .getByRole("combobox", { name: "Подключения", exact: true })
    .selectOption(secondId);
  await profileDialog
    .getByRole("button", { name: "Открыть подключение", exact: true })
    .click();
  await window.getByText("profile-second.txt", { exact: true }).waitFor();
  const forgetProfile = async () => {
    await openProfileSettings();
    await profileDialog
      .getByRole("button", {
        name: "Забыть подключение на этом устройстве",
        exact: true,
      })
      .click();
    await profileDialog
      .getByRole("button", { name: "Отключить", exact: true })
      .click();
    await profileDialog.waitFor({ state: "hidden" });
  };
  await forgetProfile();
  await window.getByText("profile-first.txt", { exact: true }).waitFor();
  assert.equal(
    (await window.evaluate(() => window.jellyree.settings.get())).profiles
      .length,
    1,
  );
  await forgetProfile();
  await window
    .getByRole("heading", { name: "Ваши файлы. Ваше облако." })
    .waitFor();
  await electron.evaluate(() => globalThis.__jellyreeProfilesFixture.restore());
  console.log(
    "PASS: real IPC creates and switches named profiles, waits for old readers, isolates thumbnail writes and removes one profile at a time",
  );

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
    replace("folders:list", () => [
      { id: "album", name: "Альбом", parent_id: null },
    ]);
    replace("stats", () => ({
      files: state.files.length,
      bytes: 40,
      trashed: state.files.filter((f) => f.trashed_at).length,
      tags: [],
    }));
    replace("files:list", (input) => {
      let items = state.files.filter((f) =>
        input.section === "trash" ? f.trashed_at : !f.trashed_at,
      );
      if (input.section === "drive")
        items = items.filter((f) => f.folder_id === (input.folderId || null));
      return { items, total: items.length, page: 1, hasMore: false };
    });
    replace("files:update", (ids, patch) => {
      state.calls.push({ channel: "update", ids, patch });
      for (const file of state.files.filter((f) => ids.includes(f.id))) {
        if ("name" in patch) file.name = patch.name;
        if ("trashed" in patch)
          file.trashed_at = patch.trashed ? "2026-11-24" : null;
        if ("folderId" in patch) file.folder_id = patch.folderId;
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
      const jobId = args.at(-1);
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
                jobId,
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
    await window.locator(".uploads-toggle strong").waitFor({ state: "hidden" });
  }
  const overallUploadProgress = window.getByRole("progressbar", {
    name: "Общий прогресс загрузки",
    exact: true,
  });
  await window.locator(".upload-panel").waitFor();
  assert.equal(
    await overallUploadProgress.count(),
    0,
    "completion removes the progress bar while the panel stays open",
  );
  await window.locator(".upload-button").click();
  await window
    .getByRole("dialog", {
      name: "Файл с таким именем уже существует",
      exact: true,
    })
    .waitFor();
  assert.equal(await window.locator(".upload-panel").count(), 1);
  await overallUploadProgress.waitFor();
  await window.keyboard.press("Tab");
  await window.keyboard.press("Escape");
  await window.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(
    await electron.evaluate(
      () => globalThis.__jellyreeUploadFixture.answers.length,
    ),
    3,
    "dismissing a conflict keeps the batch waiting",
  );
  await window
    .getByRole("button", { name: "Разобрать совпадение", exact: true })
    .click();
  await window
    .getByRole("button", { name: "Отменить оставшиеся загрузки", exact: true })
    .click();
  await window.locator(".uploads-toggle strong").waitFor({ state: "hidden" });
  assert.equal(
    await overallUploadProgress.count(),
    0,
    "canceling the last job removes the progress bar",
  );
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

  // Real mouse drags must cross preload/IPC as file IDs, never native uploads.
  const uploadBatches = await electron.evaluate(
    () => globalThis.__jellyreeUploadFixture.batches,
  );
  await electron.evaluate(() => {
    const state = globalThis.__jellyreeIpcFixture;
    state.files[0].trashed_at = null;
    state.files.push({ ...state.files[0], id: "second", name: "second.txt" });
    state.calls = [];
  });
  await window.reload();
  const nativeFile = (name) =>
    window.locator(".file-card").filter({ hasText: name });
  const nativeAlbum = window
    .locator(".folder-card")
    .filter({ hasText: "Альбом" });
  await nativeFile("keep-me.txt").dragTo(nativeAlbum);
  await nativeFile("keep-me.txt").waitFor({ state: "hidden" });
  await nativeAlbum.click();
  await nativeFile("keep-me.txt").waitFor();
  await nativeFile("keep-me.txt").dragTo(
    window.locator(".breadcrumbs button").first(),
  );
  await nativeFile("keep-me.txt").waitFor({ state: "hidden" });
  await window
    .locator(".main-nav")
    .getByRole("button", { name: "Мой диск", exact: true })
    .click();
  await window
    .getByRole("button", { name: "Выбрать keep-me.txt", exact: true })
    .click();
  await window
    .getByRole("button", { name: "Выбрать second.txt", exact: true })
    .click();
  await nativeFile("second.txt").dragTo(
    window.locator(".tree-row").filter({ hasText: "Альбом" }),
  );
  await window.waitForFunction(
    () => document.querySelectorAll(".file-card").length === 0,
  );
  const moved = await electron.evaluate(() => globalThis.__jellyreeIpcFixture);
  assert.deepEqual(moved.calls, [
    { channel: "update", ids: ["keep-me"], patch: { folderId: "album" } },
    { channel: "update", ids: ["keep-me"], patch: { folderId: null } },
    {
      channel: "update",
      ids: ["keep-me", "second"],
      patch: { folderId: "album" },
    },
  ]);
  assert.ok(moved.files.every((file) => file.folder_id === "album"));
  assert.equal(
    await electron.evaluate(() => globalThis.__jellyreeUploadFixture.batches),
    uploadBatches,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: native file and multiselection drags to album card/tree and root breadcrumb use real move IPC, not uploads",
  );

  // Hold real IPC requests open through the production queue while using the UI.
  await electron.evaluate(
    async ({ ipcMain, BrowserWindow }, queuePath) => {
      const { OperationQueue } = process
        .getBuiltinModule("module")
        .createRequire(queuePath)(queuePath);
      const queue = new OperationQueue();
      const state = {
        records: [],
        active: null,
        resolve: null,
        downloads: [],
        retries: [],
      };
      globalThis.__jellyreeBackgroundFixture = state;
      const fixture = globalThis.__jellyreeIpcFixture;
      for (const id of ["during-upload", "extra-1", "extra-2"]) {
        fixture.files.push({
          ...fixture.files[0],
          id,
          name: `${id}.txt`,
          folder_id: null,
        });
      }
      ipcMain.removeHandler("jellyree:files:list");
      ipcMain.handle("jellyree:files:list", (_event, input) => {
        const items = fixture.files.filter(
          (file) =>
            !file.trashed_at &&
            (input.section !== "drive" ||
              file.folder_id === (input.folderId || null)),
        );
        const page = input.page || 1;
        const end = input.throughPage || page;
        return {
          ok: true,
          value: {
            items: items.slice((page - 1) * 2, end * 2),
            ...(input.includeTotal ? { total: items.length } : {}),
            page: end,
            hasMore: items.length > end * 2,
          },
        };
      });
      const report = (job, phase) =>
        BrowserWindow.getAllWindows()[0].webContents.send("jellyree:progress", {
          kind: "upload",
          jobId: job.id,
          phase,
          name: "background.jpg",
          done: 0,
          total: 2,
          loaded: 40,
          totalBytes: 100,
        });
      for (const channel of ["files:pick-upload", "files:drop-upload"]) {
        ipcMain.removeHandler(`jellyree:${channel}`);
        ipcMain.handle(`jellyree:${channel}`, async (_event, ...args) => {
          const job = {
            id: args.at(-1),
            folderId: channel === "files:pick-upload" ? args[0] : args[1],
          };
          state.records.push(job);
          report(job, "queued");
          return queue.run(async () => {
            state.active = job;
            report(job, "uploading");
            const result = await new Promise((resolve) => {
              state.resolve = resolve;
            });
            state.active = null;
            return { ok: true, value: result };
          });
        });
      }
      ipcMain.removeHandler("jellyree:files:retry-upload");
      ipcMain.handle("jellyree:files:retry-upload", (_event, ids, jobId) =>
        queue.run(async () => {
          state.retries.push(ids);
          for (const [index, id] of ids.entries()) {
            BrowserWindow.getAllWindows()[0].webContents.send(
              "jellyree:progress",
              {
                kind: "upload",
                jobId,
                name: "failed.jpg",
                fileIndex: index,
                done: index + 1,
                total: ids.length,
                fileState: "uploaded",
                targetPath: id === "retry-a" ? "Альбом / a" : "Альбом / b",
              },
            );
          }
          return {
            ok: true,
            value: { done: ids.length, failures: [], resolvedRetryIds: ids },
          };
        }),
      );
      ipcMain.removeHandler("jellyree:files:download");
      ipcMain.handle("jellyree:files:download", (_event, ids) => {
        state.downloads.push({ ids, duringUpload: !!state.active });
        return { ok: true, value: { done: ids.length } };
      });
      ipcMain.removeHandler("jellyree:files:url");
      ipcMain.handle("jellyree:files:url", () => ({
        ok: true,
        value: "https://preview-test.r2.cloudflarestorage.com/placeholder",
      }));
    },
    path.join(directory, "electron/operation-queue.mjs"),
  );
  await window.reload();
  await nativeFile("during-upload.txt").waitFor();
  await window.locator(".upload-button").click();
  const uploads = window.getByRole("region", { name: "Загрузки", exact: true });
  await window
    .locator(".upload-compact-percent")
    .filter({ hasText: "40%" })
    .waitFor();
  assert.equal(await uploads.count(), 1, "starting an upload opens its panel");
  await uploads.locator('.upload-job[data-state="uploading"]').waitFor();
  assert.equal(
    await uploads
      .getByRole("progressbar", { name: "Прогресс загрузки", exact: true })
      .getAttribute("value"),
    "40",
  );
  assert.equal(await window.locator(".transfer-bar").count(), 0);
  assert.equal(await window.locator(".upload-button").isEnabled(), true);
  await nativeFile("during-upload.txt").click({ button: "right" });
  await window
    .getByRole("menuitem", { name: "Переименовать", exact: true })
    .click();
  await window
    .getByRole("dialog")
    .getByRole("textbox")
    .fill("renamed-during-upload.txt");
  await window
    .getByRole("dialog")
    .getByRole("button", { name: "Сохранить", exact: true })
    .click();
  await nativeFile("renamed-during-upload.txt").waitFor();
  await nativeFile("renamed-during-upload.txt").dblclick();
  await window.getByRole("dialog", { name: "Просмотр файла" }).waitFor();
  await window
    .getByRole("button", { name: "Закрыть просмотр", exact: true })
    .click();
  await nativeAlbum.click();
  await window.getByRole("heading", { name: "Альбом", exact: true }).waitFor();
  await window
    .getByRole("button", { name: "Скрыть загрузки", exact: true })
    .click();
  await window.locator(".upload-button").click();
  await window.waitForFunction(
    () => document.querySelector(".uploads-toggle strong")?.textContent === "2",
  );
  assert.equal(
    await uploads.count(),
    1,
    "adding another batch opens the panel again",
  );
  await uploads.locator('.upload-job[data-state="queued"]').waitFor();
  assert.equal(
    await uploads.locator('.upload-job[data-state="uploading"]').count(),
    1,
  );
  await connectionTrigger(window).click();
  assert.ok(
    await connectionPicker
      .getByRole("button", { name: "Добавить подключение", exact: true })
      .isDisabled(),
  );
  await connectionPicker
    .getByRole("button", { name: "Настройки подключения", exact: true })
    .click();
  const connection = window.getByRole("dialog");
  assert.equal(
    await connection
      .getByRole("button", { name: "Сохранить и открыть", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await connection
      .getByRole("button", { name: "Закрыть", exact: true })
      .isEnabled(),
    true,
  );
  await connection
    .getByRole("button", { name: "Закрыть", exact: true })
    .click();
  await window
    .locator(".main-nav")
    .getByRole("button", { name: "Мой диск", exact: true })
    .click();
  await nativeFile("renamed-during-upload.txt").click();
  await window.getByRole("button", { name: "Скачать", exact: true }).click();
  await window
    .locator(".banner.info")
    .filter({ hasText: "Скачано файлов: 1" })
    .waitFor();
  assert.equal(
    await uploads
      .getByRole("progressbar", { name: "Прогресс загрузки", exact: true })
      .getAttribute("value"),
    "40",
    "foreground actions do not reset upload progress",
  );
  await nativeFile("extra-2.txt").waitFor();
  await window
    .getByRole("button", { name: "Выбрать extra-2.txt", exact: true })
    .click();
  await electron.evaluate(({ BrowserWindow }) => {
    const jobId = globalThis.__jellyreeBackgroundFixture.records[0].id;
    for (let index = 0; index < 24; index++)
      BrowserWindow.getAllWindows()[0].webContents.send("jellyree:progress", {
        kind: "upload",
        jobId,
        fileIndex: index,
        fileState: "uploaded",
        name: `completed-${index}.jpg`,
        done: index + 1,
        total: 30,
        loaded: (index + 1) * 10,
        totalBytes: 300,
        sizeBytes: 10,
      });
  });
  await uploads.getByRole("tab", { name: /Загруженные/ }).click();
  await uploads.getByText("completed-23.jpg", { exact: true }).waitFor();
  assert.equal(
    await uploads.locator(".upload-job").count(),
    24,
    "individual files enter history before their batch finishes",
  );
  const scroll = await uploads.getByRole("tabpanel").evaluate((element) => {
    element.scrollTop = 120;
    return {
      scroll: element.scrollTop,
      scrollable: element.scrollHeight > element.clientHeight,
    };
  });
  assert.equal(scroll.scrollable, true);
  assert.ok(scroll.scroll > 0);
  const uploadPanelBounds = await uploads.boundingBox();
  assert.ok(uploadPanelBounds.width <= 321 && uploadPanelBounds.height <= 341);
  assert.ok(
    (await uploads.locator(".upload-job").first().boundingBox()).height < 45,
  );
  await uploads
    .getByRole("progressbar", { name: "Общий прогресс загрузки", exact: true })
    .waitFor();
  await uploads.getByRole("tab", { name: /В работе/ }).click();
  await window
    .getByRole("button", { name: "Скрыть загрузки", exact: true })
    .click();
  await electron.evaluate(() => {
    const state = globalThis.__jellyreeBackgroundFixture;
    const files = globalThis.__jellyreeIpcFixture.files;
    files.push({
      ...files[0],
      id: "uploaded-first",
      name: "uploaded-first.txt",
      folder_id: state.active.folderId,
    });
    state.resolve({ done: 1, skipped: 0, failures: [] });
  });
  await nativeFile("uploaded-first.txt").waitFor();
  assert.equal(
    await nativeFile("extra-2.txt").count(),
    1,
    "background refresh preserves loaded pages",
  );
  assert.equal(
    await window.locator(".file-card.selected").count(),
    2,
    "background refresh preserves selection",
  );
  assert.equal(
    await uploads.count(),
    0,
    "a finished batch does not reopen the panel",
  );
  await nativeAlbum.click();
  await window.getByRole("heading", { name: "Альбом", exact: true }).waitFor();
  await electron.evaluate(({ BrowserWindow }) => {
    const state = globalThis.__jellyreeBackgroundFixture;
    const files = globalThis.__jellyreeIpcFixture.files;
    files.unshift({
      ...files[0],
      id: "uploaded-second",
      name: "uploaded-second.txt",
      folder_id: state.active.folderId,
    });
    for (const [index, sub] of ["a", "b"].entries()) {
      BrowserWindow.getAllWindows()[0].webContents.send("jellyree:progress", {
        kind: "upload",
        jobId: state.active.id,
        name: "failed.jpg",
        fileIndex: index + 1,
        done: index + 2,
        total: 3,
        fileState: "failed",
        targetPath: `Альбом / ${sub}`,
        message: "Test network failure",
      });
    }
    state.resolve({
      done: 1,
      skipped: 0,
      failures: ["a", "b"].map((sub, index) => ({
        name: "failed.jpg",
        message: index ? "Test network failure B" : "Test network failure",
        fileIndex: index + 1,
        retryId: `retry-${sub}`,
        targetPath: `Альбом / ${sub}`,
      })),
    });
  });
  await nativeFile("uploaded-second.txt").waitFor();
  await window.locator(".uploads-toggle.attention").waitFor();
  assert.equal(
    await uploads.count(),
    0,
    "errors draw attention in the toolbar without opening a panel",
  );
  await window
    .locator(".topbar")
    .getByRole("button", { name: "Загрузки", exact: true })
    .click();
  await uploads.getByRole("tab", { name: /Загруженные/ }).click();
  await uploads.locator('.upload-job[data-state="issues"]').first().waitFor();
  assert.equal(await uploads.getByRole("progressbar").count(), 0);
  assert.equal(await window.locator(".upload-compact-percent").count(), 0);
  await uploads.getByText("Подробности", { exact: false }).click();
  await uploads
    .getByText("failed.jpg: Test network failure", { exact: true })
    .waitFor();
  assert.equal(
    await window.getByRole("heading", { name: "Альбом", exact: true }).count(),
    1,
  );
  assert.equal(
    await window
      .locator(".banner.info")
      .filter({ hasText: "Скачано файлов: 1" })
      .count(),
    1,
    "upload completion cannot overwrite foreground notices",
  );
  const background = await electron.evaluate(() => ({
    records: globalThis.__jellyreeBackgroundFixture.records,
    downloads: globalThis.__jellyreeBackgroundFixture.downloads,
  }));
  assert.deepEqual(
    background.records.map((job) => job.folderId),
    [null, "album"],
  );
  assert.ok(background.records.every((job) => typeof job.id === "string"));
  assert.deepEqual(background.downloads, [
    { ids: ["during-upload"], duringUpload: true },
  ]);
  await window.screenshot({
    path: path.join(os.tmpdir(), "jellyree-background-uploads.png"),
  });
  await uploads
    .locator('.upload-job[data-state="issues"]')
    .filter({ hasText: "Альбом / b" })
    .getByRole("button", { name: "Повторить", exact: true })
    .click();
  await uploads
    .locator('.upload-job[data-state="issues"]')
    .filter({ hasText: "Альбом / b" })
    .waitFor({ state: "detached" });
  await uploads.getByRole("button", { name: "Повторить неудачные" }).click();
  await uploads.locator('.upload-job[data-state="issues"]').first().waitFor({
    state: "detached",
  });
  assert.deepEqual(
    await electron.evaluate(
      () => globalThis.__jellyreeBackgroundFixture.retries,
    ),
    [["retry-b"], ["retry-a"]],
  );
  await uploads
    .getByRole("button", { name: "Убрать завершённые", exact: true })
    .click();
  await uploads
    .getByText("Завершённых загрузок пока нет", { exact: true })
    .waitFor();
  assert.equal(await window.locator(".uploads-toggle.attention").count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: native background upload queue, browsing/preview/rename/download during transfer, captured destinations, isolated progress/errors, pagination and selection preserved",
  );

  const mp4 = await readFile(path.join(directory, "test/fixtures/preview.mp4"));
  await window.route(
    "https://preview-test.r2.cloudflarestorage.com/**",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "video/mp4",
        body: route.request().url().endsWith("broken.mp4")
          ? Buffer.from("invalid video")
          : mp4,
      }),
  );
  await electron.evaluate(
    ({ ipcMain, protocol }, input) => {
      const state = globalThis.__jellyreeIpcFixture;
      state.files = state.files.filter((file) => file.folder_id !== null);
      for (const id of ["preview", "broken"]) {
        state.files.push({
          ...state.files[0],
          id,
          name: `${id}.mp4`,
          mime_type: "video/mp4",
          folder_id: null,
        });
      }
      ipcMain.removeHandler("jellyree:files:url");
      ipcMain.handle("jellyree:files:url", (_event, id) => ({
        ok: true,
        value: `https://preview-test.r2.cloudflarestorage.com/${id}.mp4`,
      }));
      // Keep the real private-media transport: a metadata failure must no longer
      // trigger another signed-URL/D1 request as an automatic fallback.
      const require = process
        .getBuiltinModule("module")
        .createRequire(input.module);
      const { ThumbnailMedia } = require(input.module);
      const media = new ThumbnailMedia(async (url, options) => {
        const bytes = url.endsWith("broken")
          ? Buffer.from("invalid video")
          : Buffer.from(input.bytes);
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
            "Content-Type": "video/mp4",
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
      ipcMain.removeHandler("jellyree:thumbnails:source");
      ipcMain.handle("jellyree:thumbnails:source", (_event, revision) => ({
        ok: true,
        value: media.create(`https://fixture.invalid/${revision.id}`),
      }));
      ipcMain.removeHandler("jellyree:media:release");
      ipcMain.handle("jellyree:media:release", (_event, url) => ({
        ok: true,
        value: media.release(url),
      }));
    },
    {
      module: path.join(directory, "electron/thumbnail-media.mjs"),
      bytes: [...mp4],
    },
  );
  await window.reload();
  const nativeVideo = nativeFile("preview.mp4");
  await nativeVideo.locator(".video-poster").waitFor({ state: "visible" });
  assert.equal(await nativeVideo.locator(".video-badge").innerText(), "0:02");
  assert.equal(await nativeVideo.locator("video").count(), 0);
  await nativeFile("broken.mp4")
    .getByText("Превью недоступно", { exact: true })
    .waitFor();
  await nativeVideo.screenshot({
    path: path.join(os.tmpdir(), "jellyree-electron-video.png"),
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: real Electron H.264/MP4 poster and duration, decoder cleanup and broken-video fallback",
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
  const mediaEvents = [];
  page.on("console", (message) => {
    if (message.type() === "error") mediaEvents.push(message.text());
  });
  const previewBytes = await readFile(
    path.join(directory, "test/fixtures/preview.webm"),
  );
  await page.route(
    "https://preview-test.r2.cloudflarestorage.com/**",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "video/webm",
        body: previewBytes,
      }),
  );
  const editorPng = (
    await readFile(path.join(directory, "test/fixtures/editor.png"))
  ).toString("base64");
  await page.addInitScript((editorPng) => {
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
    window.__jellyreeReplacePreview = (id = "photo") => {
      files = files.map((file) =>
        file.id === id ? { ...file, object_key: "new-object-key" } : file,
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
        tags: [
          ...new Set([
            ...files
              .filter((file) => !file.trashed_at)
              .flatMap((file) => file.tags),
            ...Array.from({ length: 12 }, (_, index) => `проект ${index + 1}`),
          ]),
        ],
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
      duplicatePhoto: async (id, objectKey) => {
        const index = files.findIndex(
          (file) => file.id === id && file.object_key === objectKey,
        );
        if (index < 0) throw new Error("Invalid source revision");
        const file = files[index];
        const copy = {
          ...file,
          id: id + "-copy",
          object_key: objectKey + "-copy",
          name: file.name.replace(".jpg", " (1).jpg"),
        };
        files.splice(index + 1, 0, copy);
        return copy;
      },
      remove: async (ids) => {
        files = files.filter((file) => !ids.includes(file.id));
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
      imageSource: async () => ({
        data: Uint8Array.from(atob(editorPng), (char) => char.charCodeAt(0)),
        mimeType: "image/png",
      }),
      url: async (id) => {
        if (id === "video")
          return "https://preview-test.r2.cloudflarestorage.com/preview.webm";
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
      dropUpload: async (files, folderId) => {
        calls.push({ folderId, dropped: files.map((file) => file.name) });
        return { done: files.length, failures: [] };
      },
      onProgress: () => () => {},
    };
  }, editorPng);
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
  await page
    .getByRole("button", { name: "Switch connection", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Connections", exact: true })
    .getByRole("button", { name: "Connection settings", exact: true })
    .click();
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
  const videoCard = page
    .locator(".file-card")
    .filter({ hasText: "Выходные.mp4" });
  await videoCard.scrollIntoViewIfNeeded();
  try {
    await videoCard.locator(".video-poster").waitFor({ state: "visible" });
  } catch (error) {
    console.log(
      "Video diagnostics",
      mediaEvents,
      await videoCard.evaluate((element) => {
        const video = element.querySelector("video");
        return {
          html: element.innerHTML,
          video: video && {
            src: video.currentSrc,
            error: video.error?.message,
            state: video.readyState,
            network: video.networkState,
            time: video.currentTime,
            duration: video.duration,
            seeking: video.seeking,
          },
        };
      }),
    );
    throw error;
  }
  assert.equal(await videoCard.locator(".video-badge").innerText(), "0:02");
  const videoFrame = await videoCard.locator("canvas").evaluate((canvas) => {
    const bounds = canvas.getBoundingClientRect();
    let crossOrigin = false;
    try {
      canvas.toDataURL();
    } catch (error) {
      crossOrigin = error.name === "SecurityError";
    }
    return {
      width: canvas.width,
      height: canvas.height,
      ratio: bounds.width / bounds.height,
      crossOrigin,
    };
  });
  assert.equal(videoFrame.width, 320);
  assert.equal(videoFrame.height, 180);
  assert.ok(Math.abs(videoFrame.ratio - 16 / 9) < 0.03);
  assert.equal(
    videoFrame.crossOrigin,
    true,
    "a cross-origin R2 video renders without bucket CORS",
  );
  assert.equal(
    await videoCard.locator("video").count(),
    0,
    "decoder is released after capturing the frame",
  );
  await videoCard.screenshot({
    path: path.join(os.tmpdir(), "jellyree-video-preview.png"),
  });
  console.log(
    "PASS: cross-origin video poster without CORS, duration, original aspect ratio and decoder cleanup",
  );
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
        ratio: bounds.width / bounds.height,
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
  const tagDialog = page.getByRole("dialog", { name: "Теги", exact: true });
  const catalogTagInput = tagDialog.getByRole("textbox", {
    name: "Добавить тег",
  });
  const catalogExistingTags = tagDialog.getByRole("group", {
    name: "Существующие теги",
  });
  const visibleTags = (
    await catalogExistingTags.getByRole("button").allTextContents()
  ).map((tag) => tag.trim());
  const byTagName = new Intl.Collator("ru", {
    sensitivity: "base",
    numeric: true,
  });
  assert.deepEqual(visibleTags, [...visibleTags].sort(byTagName.compare));
  await catalogTagInput.fill("ПРОЕКТ 1");
  await catalogExistingTags
    .getByRole("button", { name: "проект 12", exact: true })
    .click();
  assert.equal(await catalogTagInput.inputValue(), "");
  await tagDialog
    .getByRole("button", { name: "Удалить тег «море»", exact: true })
    .click();
  await catalogTagInput.fill("из каталога, МО");
  await tagDialog
    .getByRole("group", { name: "Подсказки" })
    .getByRole("button", { name: "море", exact: true })
    .click();
  await catalogTagInput.fill("проверка");
  await tagDialog
    .getByRole("button", { name: "Сохранить", exact: true })
    .click();
  await tagDialog.waitFor({ state: "hidden" });
  const catalogTags = await page.evaluate(async () => {
    const { items } = await window.jellyree.list({ section: "all" });
    return items
      .filter((file) => ["Море.jpg", "Заметки.txt"].includes(file.name))
      .map((file) => file.tags);
  });
  assert.deepEqual(
    catalogTags,
    Array(2).fill(["отпуск", "проект 12", "из каталога", "море", "проверка"]),
  );
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
  const fileNames = page.locator(".files .file-name > span");
  const namesInOrder = await fileNames.allTextContents();
  const selectedNames = () =>
    page.locator(".file-card.selected .file-name > span").allTextContents();
  await fileNames.nth(1).click();
  await fileNames.nth(4).click({ modifiers: ["Shift"] });
  assert.deepEqual(await selectedNames(), namesInOrder.slice(1, 5));
  await fileNames.nth(0).click({ modifiers: ["Shift"] });
  assert.deepEqual(await selectedNames(), namesInOrder.slice(0, 2));
  await fileNames.nth(5).click({ modifiers: ["Control"] });
  assert.deepEqual(await selectedNames(), [
    ...namesInOrder.slice(0, 2),
    namesInOrder[5],
  ]);

  const fileCards = page.locator(".files .file-card");
  await fileCards.first().scrollIntoViewIfNeeded();
  const firstCard = await fileCards.nth(0).boundingBox();
  const thirdCard = await fileCards.nth(2).boundingBox();
  const gutter = firstCard.x - 10;
  const firstY = firstCard.y + firstCard.height / 2;
  const thirdY = thirdCard.y + thirdCard.height / 2;
  await page.mouse.move(gutter, thirdY);
  await page.mouse.down();
  await page.mouse.move(firstCard.x + 90, firstY, { steps: 8 });
  await page.locator(".selection-box").waitFor();
  await page.waitForFunction(
    () => document.querySelectorAll(".file-card.selected").length === 3,
  );
  assert.deepEqual(await selectedNames(), namesInOrder.slice(0, 3));
  await page.mouse.up();
  await page.locator(".selection-box").waitFor({ state: "detached" });
  assert.deepEqual(await selectedNames(), namesInOrder.slice(0, 3));

  const fifthCard = await fileCards.nth(4).boundingBox();
  await page.mouse.move(gutter, firstY);
  await page.mouse.down();
  await page.mouse.move(fifthCard.x + 90, fifthCard.y + 10, { steps: 8 });
  await page.locator(".selection-box").waitFor();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await page.locator(".selection-box").waitFor({ state: "detached" });
  assert.deepEqual(await selectedNames(), namesInOrder.slice(0, 3));
  console.log(
    "PASS: Shift ranges in both directions, Ctrl toggle, reverse box drag and Escape restoration",
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

  const portraitCard = page
    .locator(".file-card")
    .filter({ hasText: "Портрет.jpg" });
  const panoramaCard = page
    .locator(".file-card")
    .filter({ hasText: "Панорама.jpg" });
  for (const photo of [portraitCard, panoramaCard]) {
    await photo.scrollIntoViewIfNeeded();
    await photo.locator("img").evaluate((image) => image.decode());
  }
  await page.evaluate(() => {
    const gate = new Promise((resolve) => {
      window.__jellyreeFinishPrefetch = resolve;
    });
    const url = window.jellyree.url;
    window.__jellyreePhotoLoads = { portrait: 0, panorama: 0 };
    window.jellyree.url = async (id) => {
      if (id === "portrait" || id === "panorama")
        window.__jellyreePhotoLoads[id]++;
      if (id === "panorama") await gate;
      return url(id);
    };
  });
  const fullPhoto = (name) => page.locator(`.photo-frame img[alt="${name}"]`);
  const portraitFrame = fullPhoto("Портрет.jpg");
  const panoramaFrame = fullPhoto("Панорама.jpg");
  const closePhoto = () =>
    page.getByRole("button", { name: "Закрыть просмотр", exact: true }).click();
  await portraitCard.dblclick();
  await portraitFrame.waitFor();
  await portraitFrame.evaluate((image) => {
    window.__jellyreePortrait = image;
  });
  // The next photo has already started loading before navigation.
  await page.waitForFunction(() => window.__jellyreePhotoLoads.panorama === 1);
  await page.keyboard.press("ArrowRight");
  await page.locator(".photo-loading").waitFor();
  assert.equal(await portraitFrame.isVisible(), true);
  assert.equal(await panoramaFrame.count(), 0);
  await page.evaluate(() => window.__jellyreeFinishPrefetch());
  await panoramaFrame.waitFor();
  await page.keyboard.press("ArrowLeft");
  await portraitFrame.waitFor();
  assert.ok(
    await portraitFrame.evaluate(
      (image) => image === window.__jellyreePortrait,
    ),
  );
  assert.equal(await page.locator(".preview-stage .loading-state").count(), 0);
  await closePhoto();
  await portraitCard.dblclick();
  await portraitFrame.waitFor();
  assert.ok(
    await portraitFrame.evaluate(
      (image) => image === window.__jellyreePortrait,
    ),
  );
  assert.deepEqual(await page.evaluate(() => window.__jellyreePhotoLoads), {
    portrait: 1,
    panorama: 1,
  });
  await closePhoto();
  await page.evaluate(() => window.__jellyreeReplacePreview("portrait"));
  await page
    .locator(".topbar")
    .getByRole("button", { name: "Обновить", exact: true })
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector('.file-card img[alt="Портрет.jpg"]')
      ?.src.includes("new-object-key"),
  );
  await portraitCard.dblclick();
  await portraitFrame.waitFor();
  assert.ok(
    (await portraitFrame.getAttribute("src")).includes("new-object-key"),
  );
  const viewport = page.locator(".photo-viewport");
  const zoom = page.locator(".photo-zoom-reset");
  await viewport.hover();
  await page.mouse.wheel(0, -480);
  await page.waitForFunction(() =>
    document.querySelector(".photo-viewport.photo-zoomed"),
  );
  await page
    .getByRole("button", { name: "Увеличить фото", exact: true })
    .click();
  const bounds = await viewport.boundingBox();
  const center = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  const frame = page.locator(".photo-frame");
  const beforePan = await frame.evaluate((element) => element.style.transform);
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x, center.y + 75);
  await page.mouse.up();
  assert.notEqual(
    await frame.evaluate((element) => element.style.transform),
    beforePan,
  );
  await page.keyboard.press("ArrowRight");
  await panoramaFrame.waitFor();
  assert.equal(await zoom.innerText(), "100%");
  await page.keyboard.press("ArrowLeft");
  await portraitFrame.waitFor();
  const photoViewer = page.locator(".preview-overlay");
  assert.ok(
    (await photoViewer.locator(".preview-header").boundingBox()).height <= 52,
  );
  await photoViewer.getByRole("button", { name: "Теги", exact: true }).click();
  const previewTags = photoViewer.locator(".preview-tags");
  const tagInput = previewTags.getByRole("textbox", { name: "Добавить тег" });
  await tagInput.fill("из просмотра");
  await tagInput.press("Enter");
  await previewTags
    .getByRole("button", { name: "Удалить тег «из просмотра»" })
    .waitFor();
  await tagInput.fill("ОТПУ");
  await previewTags
    .getByRole("group", { name: "Подсказки" })
    .getByRole("button", { name: "отпуск", exact: true })
    .click();
  await previewTags
    .getByRole("button", { name: "Удалить тег «отпуск»" })
    .click();
  await previewTags
    .getByRole("group", { name: "Существующие теги" })
    .getByRole("button", { name: "проект 12", exact: true })
    .click();
  await previewTags
    .getByRole("button", { name: "Удалить тег «проект 12»" })
    .waitFor();
  await previewTags
    .getByRole("button", { name: "Скопировать теги", exact: true })
    .click();
  await photoViewer
    .getByRole("button", { name: "Следующий файл", exact: true })
    .click();
  await panoramaFrame.waitFor();
  await tagInput.fill("панорама");
  await tagInput.press("Enter");
  const pasteTags = previewTags.getByRole("button", {
    name: "Вставить теги",
    exact: true,
  });
  await pasteTags.click();
  await previewTags
    .getByRole("button", { name: "Удалить тег «из просмотра»" })
    .waitFor();
  await previewTags
    .getByRole("button", { name: "Удалить тег «проект 12»" })
    .waitFor();
  assert.ok(
    await previewTags
      .getByRole("button", { name: "Удалить тег «панорама»" })
      .isVisible(),
  );
  assert.ok(await pasteTags.isDisabled());
  await photoViewer
    .getByRole("button", { name: "Предыдущий файл", exact: true })
    .click();
  await portraitFrame.waitFor();
  await tagInput.press("Escape");
  await previewTags.waitFor({ state: "hidden" });
  await photoViewer.getByRole("button", { name: "Создать дубликат" }).click();
  await fullPhoto("Портрет (1).jpg").waitFor();
  await photoViewer.getByRole("button", { name: "Теги", exact: true }).click();
  await previewTags
    .getByRole("button", { name: "Удалить тег «из просмотра»" })
    .waitFor();
  await tagInput.press("Escape");
  await photoViewer
    .getByRole("button", { name: "В корзину", exact: true })
    .click();
  await portraitFrame.waitFor();
  await closePhoto();
  await page.getByRole("button", { name: "Корзина", exact: true }).click();
  await page
    .locator(".file-card")
    .filter({ hasText: "Портрет (1).jpg" })
    .dblclick();
  await photoViewer
    .getByRole("button", { name: "Удалить навсегда", exact: true })
    .click();
  await page
    .locator(".action-dialog")
    .getByRole("button", { name: "Удалить", exact: true })
    .click();
  await photoViewer.waitFor({ state: "hidden" });
  await page
    .locator(".main-nav")
    .getByRole("button", { name: "Мой диск", exact: true })
    .click();
  console.log(
    "PASS: photo prefetch, decoded preview reuse, zoom and pan, tags, duplication, and deletion inside the viewer",
  );

  // Folder destinations support external uploads, internal folders and cycle rejection.
  const trip = page.locator(".folder-card").filter({ hasText: "Поездки" });
  await trip.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(["photo"], "dropped.jpg", { type: "image/jpeg" }),
    );
    element.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
  });
  await page.waitForFunction(() => window.__jellyreeBrowserCalls.length === 2);
  assert.deepEqual(
    await page.evaluate(() => window.__jellyreeBrowserCalls[1]),
    { folderId: "travel", dropped: ["dropped.jpg"] },
  );
  const work = page.locator(".folder-card").filter({ hasText: "Проекты" });
  await work.dragTo(trip);
  await work.waitFor({ state: "hidden" });
  await trip.click();
  await work.waitFor();
  // Dragging the parent into its child must not invoke a move or root fallback.
  const tripTree = page.locator(".tree-row").filter({ hasText: "Поездки" });
  await tripTree.dragTo(work);
  await work.waitFor();
  assert.equal(
    await page
      .locator(".breadcrumbs")
      .innerText()
      .then((text) => text.includes("Поездки")),
    true,
  );
  await work.dragTo(
    page
      .locator(".main-nav")
      .getByRole("button", { name: "Мой диск", exact: true }),
  );
  await work.waitFor({ state: "hidden" });
  await page
    .locator(".main-nav")
    .getByRole("button", { name: "Мой диск", exact: true })
    .click();
  await work.waitFor();
  assert.equal(await page.locator(".drag-summary").count(), 0);
  assert.equal(await page.locator(".drop-overlay").count(), 0);
  console.log(
    "PASS: external drop uploads into target album; folders move into albums and root; descendant drops rejected",
  );

  await page.evaluate(() => {
    const list = window.jellyree.list;
    const stats = window.jellyree.stats;
    const folders = window.jellyree.folders;
    const state = { pages: [], metadata: [], counts: [] };
    window.__paginationFixture = state;
    const gate = new Promise((resolve) => {
      state.finish = resolve;
    });
    const lastGate = new Promise((resolve) => {
      state.finishLast = resolve;
    });
    window.jellyree.stats = () => {
      state.metadata.push("stats");
      return stats();
    };
    window.jellyree.folders = () => {
      state.metadata.push("folders");
      return folders();
    };
    window.jellyree.list = async (input) => {
      if (input.search !== "pagination") return list(input);
      const page = input.page;
      state.pages.push(page);
      state.counts.push(input.includeTotal);
      if (page === 2 && state.pages.filter((n) => n === 2).length === 1)
        throw new Error("Pagination test: temporary failure");
      if (page === 3) await gate;
      if (page === 4) await lastGate;
      const size = page >= 3 ? 1 : 25;
      const items = Array.from({ length: size }, (_, index) => {
        const id = page >= 3 ? 48 + page : (page - 1) * 25 + index + 1;
        return {
          id: `pagination-${id}`,
          name: `pagination-${id}.txt`,
          mime_type: "text/plain",
          size_bytes: 100,
          tags: [],
          adjustments: {},
          created_at: "2026-11-01",
        };
      });
      return {
        items,
        ...(input.includeTotal ? { total: 52 } : {}),
        page,
        hasMore: page < 4,
      };
    };
  });
  await tripTree.click();
  await page
    .locator(".breadcrumbs")
    .getByRole("button", { name: "Поездки" })
    .waitFor();
  await page
    .getByRole("textbox", { name: "Поиск файлов и тегов" })
    .fill("pagination");
  await page.getByText("pagination-25.txt", { exact: true }).waitFor();
  assert.deepEqual(
    await page.evaluate(() => window.__paginationFixture.pages),
    [1],
  );
  const fixedPositions = () =>
    page.evaluate(() =>
      [
        ".topbar",
        ".breadcrumbs",
        ".page-header",
        ".file-controls",
        ".workspace-footer",
      ].map(
        (selector) =>
          document.querySelector(selector).getBoundingClientRect().top,
      ),
    );
  const beforeScroll = await fixedPositions();
  assert.ok((await page.locator(".topbar").boundingBox()).height <= 56);
  assert.ok((await page.locator(".file-controls").boundingBox()).height <= 81);
  const filesPane = page.locator(".files-scroll");
  const pane = await filesPane.boundingBox();
  const firstRow = await fileCards.first().boundingBox();
  await page.mouse.move(firstRow.x - 10, firstRow.y + 18);
  await page.mouse.down();
  await page.mouse.move(firstRow.x + 90, pane.y + pane.height - 5, {
    steps: 8,
  });
  await page.waitForFunction(
    () => document.querySelector(".files-scroll").scrollTop > 80,
  );
  await page.keyboard.press("Escape");
  await page.mouse.up();
  assert.deepEqual(await fixedPositions(), beforeScroll);
  await page.mouse.move(pane.x + 120, pane.y + 120);
  const scrollTop = await filesPane.evaluate((element) => element.scrollTop);
  await page.mouse.wheel(0, 180);
  await page.waitForFunction(
    (previous) => document.querySelector(".files-scroll").scrollTop > previous,
    scrollTop,
  );
  assert.deepEqual(await fixedPositions(), beforeScroll);
  assert.equal(await page.evaluate(() => window.scrollY), 0);
  await page.locator(".load-more").scrollIntoViewIfNeeded();
  await page
    .getByText("Pagination test: temporary failure", { exact: true })
    .waitFor();
  const retryPage = page.getByRole("button", {
    name: "Повторить",
    exact: true,
  });
  await retryPage.waitFor();
  assert.deepEqual(
    await page.evaluate(() => window.__paginationFixture.pages),
    [1, 2],
  );
  await retryPage.click();
  await page.getByText("pagination-50.txt", { exact: true }).waitFor();
  assert.equal(await page.locator(".file-card").count(), 50);
  assert.deepEqual(
    await page.evaluate(() => window.__paginationFixture.pages),
    [1, 2, 2],
  );
  await page
    .locator('[data-file-id="pagination-50"]')
    .dispatchEvent("dblclick");
  const viewer = page.getByRole("dialog", {
    name: "Просмотр файла",
    exact: true,
  });
  const next = viewer.getByRole("button", {
    name: "Следующий файл",
    exact: true,
  });
  await next.click();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() =>
    window.__paginationFixture.pages.includes(3),
  );
  await viewer
    .locator(".preview-header")
    .filter({ hasText: "pagination-50.txt" })
    .waitFor();
  assert.equal(await next.getAttribute("aria-busy"), "true");
  await page.evaluate(() => window.__paginationFixture.finish());
  await viewer
    .locator(".preview-header")
    .filter({ hasText: "pagination-51.txt" })
    .waitFor();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() =>
    window.__paginationFixture.pages.includes(4),
  );
  await viewer
    .getByRole("button", { name: "Закрыть просмотр", exact: true })
    .click();
  await viewer.waitFor({ state: "detached" });
  await page
    .locator(".breadcrumbs")
    .getByRole("button", { name: "Мой диск", exact: true })
    .click();
  await page.getByRole("heading", { name: "Мой диск", exact: true }).waitFor();
  await page.locator(".files[aria-busy=false]").waitFor({ state: "attached" });
  await page.evaluate(async () => {
    window.__paginationFixture.finishLast();
    await new Promise(requestAnimationFrame);
  });
  assert.equal(
    await page.locator(".file-card").filter({ hasText: "pagination-" }).count(),
    0,
  );
  assert.equal(await filesPane.evaluate((element) => element.scrollTop), 0);
  await viewer.waitFor({ state: "detached" });
  assert.deepEqual(
    await page.evaluate(() => window.__paginationFixture.pages),
    [1, 2, 2, 3, 4],
  );
  assert.deepEqual(
    await page.evaluate(() => window.__paginationFixture.counts),
    [false, false, false, false, false],
  );
  assert.deepEqual(
    await page.evaluate(() => window.__paginationFixture.metadata),
    [],
  );
  console.log(
    "PASS: only the file pane scrolls (wheel and selection), header and breadcrumbs stay fixed, pagination and folder reset work",
  );

  await page.evaluate(() => {
    const list = window.jellyree.list;
    const rows = [
      ...Array.from({ length: 56 }, (_, index) => ({
        id: `timeline-recent-${String(index).padStart(2, "0")}`,
        created_at: `2026-11-${25 - Math.floor(index / 17)}T12:00:00.000Z`,
        mime_type: "image/jpeg",
      })),
      {
        id: "timeline-clip",
        created_at: "2023-02-02T12:00:00.000Z",
        mime_type: "video/mp4",
      },
      {
        id: "timeline-archive",
        created_at: "2019-04-14T12:00:00.000Z",
        mime_type: "image/jpeg",
      },
      {
        id: "timeline-oldest",
        created_at: "2015-03-07T12:00:00.000Z",
        mime_type: "image/jpeg",
      },
      {
        id: "timeline-document",
        created_at: "2019-04-14T12:00:00.000Z",
        mime_type: "application/pdf",
      },
    ].map((file) => ({
      ...file,
      name: file.id + (file.mime_type === "video/mp4" ? ".mp4" : ".jpg"),
      object_key: file.id,
      folder_id: null,
      updated_at: file.created_at,
      size_bytes: 500,
      tags: [],
      adjustments: {},
    }));
    const queries = [];
    window.__timelineFixture = queries;
    const bounds = new Promise((resolve) => {
      window.__finishTimelineBounds = resolve;
    });
    let attempts = 0;
    window.jellyree.timelineBounds = async () => {
      if (attempts++ === 0) {
        await bounds;
        throw new Error("Timeline bounds unavailable");
      }
      return {
        oldest: "2015-03-07T12:00:00.000Z",
        newest: "2026-11-25T12:00:00.000Z",
      };
    };
    window.jellyree.list = async (input) => {
      if (input.section !== "timeline") return list(input);
      queries.push(input);
      let matches = rows.filter((row) => row.mime_type !== "application/pdf");
      if (input.timelineBefore)
        matches = matches.filter(
          (row) => row.created_at < input.timelineBefore,
        );
      if (input.timelineSince)
        matches = matches
          .filter((row) => row.created_at >= input.timelineSince)
          .reverse();
      const end = (input.throughPage || input.page) * 16;
      return {
        items: matches.slice((input.page - 1) * 16, end),
        page: input.page,
        hasMore: matches.length > end,
      };
    };
  });
  await page.getByRole("button", { name: "Медиалента", exact: true }).click();
  await page
    .getByRole("heading", { name: "Медиалента", exact: true })
    .waitFor();
  const rail = page.getByRole("complementary", { name: "Временная шкала" });
  await rail.waitFor();
  const media = page.locator(".media-feed");
  await media.locator('[data-file-id="timeline-recent-00"]').waitFor();
  const railBox = await rail.boundingBox();
  const mediaBox = await page.locator(".timeline-scroll").boundingBox();
  assert.ok(
    railBox.height > 200 && railBox.x >= mediaBox.x + mediaBox.width - 1,
  );
  assert.equal(
    await rail.getByRole("button", { name: "Перейти к 2015" }).count(),
    0,
  );
  await page.evaluate(() => window.__finishTimelineBounds());
  await rail.getByRole("button", { name: "Повторить", exact: true }).click();
  await rail
    .getByRole("button", { name: "Перейти к 2015", exact: true })
    .waitFor();
  const yearCount = await rail.locator(".year-mark").count();
  for (let count = 0; count < 3; count++)
    await rail.getByRole("button", { name: "Увеличить масштаб шкалы" }).click();
  assert.ok((await rail.locator(".year-mark").count()) < yearCount);
  assert.ok((await rail.locator(".timeline-mark:not(.year-mark)").count()) > 0);
  for (let count = 0; count < 3; count++)
    await rail.getByRole("button", { name: "Уменьшить масштаб шкалы" }).click();
  await page.locator(".load-more").scrollIntoViewIfNeeded();
  await media.locator('[data-file-id="timeline-recent-16"]').waitFor();
  assert.equal(
    await media.locator(".media-day").first().locator(".media-card").count(),
    17,
  );
  assert.equal(
    await page
      .locator(".timeline-scroll")
      .evaluate((root) => getComputedStyle(root).scrollbarWidth),
    "none",
  );
  await page.screenshot({
    path: path.join(os.tmpdir(), "jellyree-media-timeline.png"),
  });

  await rail
    .getByRole("button", { name: "Перейти к 2019", exact: true })
    .click();
  const historical = media.locator('[data-file-id="timeline-archive"]');
  await historical.waitFor();
  assert.equal(
    await media.locator('[data-file-id="timeline-document"]').count(),
    0,
  );
  assert.equal(
    await media.locator('[data-file-id="timeline-recent-00"]').count(),
    0,
  );
  const historicalQuery = await page.evaluate(() =>
    window.__timelineFixture.find((input) => input.timelineBefore),
  );
  assert.equal(historicalQuery.page, 1);
  assert.equal(historicalQuery.includeTotal, false);
  await historical.dblclick();
  await viewer
    .locator(".preview-header")
    .filter({ hasText: "timeline-archive.jpg" })
    .waitFor();
  await viewer
    .getByRole("button", { name: "Закрыть просмотр", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Более новые медиафайлы", exact: true })
    .click();
  await media.locator('[data-file-id="timeline-clip"]').waitFor();
  assert.equal(
    await page.evaluate(
      () =>
        window.__timelineFixture.find((input) => input.timelineSince)
          .timelineSince,
    ),
    historicalQuery.timelineBefore,
  );
  await rail.getByRole("slider").press("Home");
  await media.locator('[data-file-id="timeline-recent-00"]').waitFor();
  const track = await rail.getByRole("slider").boundingBox();
  const beforeDrag = await page.evaluate(
    () =>
      window.__timelineFixture.filter((input) => input.timelineBefore).length,
  );
  await page.mouse.move(track.x + track.width / 2, track.y + 6);
  await page.mouse.down();
  await page.mouse.move(track.x + track.width / 2, track.y + track.height - 3, {
    steps: 12,
  });
  assert.equal(
    await page.evaluate(
      () =>
        window.__timelineFixture.filter((input) => input.timelineBefore).length,
    ),
    beforeDrag,
  );
  await page.mouse.up();
  await media.locator('[data-file-id="timeline-oldest"]').waitFor();
  console.log(
    "PASS: media timeline groups days across pages, seeks historical dates, zooms and loads in both directions",
  );

  await page.evaluate(() => {
    const list = window.jellyree.list;
    const url = window.jellyree.url;
    const state = { pages: [] };
    window.__stableGalleryFixture = state;
    const preview = new Promise((resolve) => {
      state.finishPreview = resolve;
    });
    const next = new Promise((resolve) => {
      state.finishPage = resolve;
    });
    window.jellyree.thumbnails = {
      ...window.jellyree.thumbnails,
      dimensions: async (items) =>
        items.map(({ id }) => {
          if (id === "stable-gallery-01") return { width: 480, height: 960 };
          if (id === "stable-gallery-02") return { width: 1200, height: 480 };
          return null;
        }),
    };
    window.jellyree.url = async (id) => {
      if (!id.startsWith("stable-gallery-")) return url(id);
      if (id === "stable-gallery-00") await preview;
      const [width, height] =
        id === "stable-gallery-00"
          ? [280, 1100]
          : id === "stable-gallery-01"
            ? [480, 960]
            : id === "stable-gallery-02"
              ? [1200, 480]
              : [600, 440];
      return (
        "data:image/svg+xml," +
        encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#87a1bc"/></svg>`,
        )
      );
    };
    window.jellyree.list = async (input) => {
      if (input.search !== "stable-gallery") return list(input);
      state.pages.push(input.page);
      if (input.page === 2) await next;
      const items = Array.from(
        { length: input.page === 1 ? 22 : 10 },
        (_, i) => {
          const id =
            "stable-gallery-" +
            String(i + (input.page - 1) * 22).padStart(2, "0");
          return {
            id,
            name: id + ".jpg",
            object_key: id,
            folder_id: null,
            mime_type: "image/jpeg",
            size_bytes: 1234,
            favorite: false,
            tags: [],
            adjustments: {},
            updated_at: "2026-11-20",
            created_at: "2026-11-20",
          };
        },
      );
      return { items, page: input.page, hasMore: input.page === 1 };
    };
  });
  await page
    .locator(".main-nav")
    .getByRole("button", { name: "Мой диск", exact: true })
    .click();
  await page.getByRole("button", { name: "Галерея", exact: true }).click();
  const gallery = page.locator(".files.gallery");
  await page
    .getByRole("textbox", { name: "Поиск файлов и тегов" })
    .fill("stable-gallery");
  const tile = (id) => gallery.locator(`[data-file-id="stable-gallery-${id}"]`);
  await tile("00").waitFor();
  const positions = (limit = 22) =>
    gallery.evaluate((root, limit) => {
      const anchor = root.getBoundingClientRect();
      return [...root.querySelectorAll(".file-card")]
        .slice(0, limit)
        .map((card) => {
          const bounds = card.getBoundingClientRect();
          return {
            id: card.dataset.fileId,
            left: bounds.left - anchor.left,
            top: bounds.top - anchor.top,
            width: bounds.width,
            height: bounds.height,
          };
        });
    }, limit);
  const frozen = await positions();
  assert.equal(frozen.length, 22);
  assert.equal(frozen[0].top, frozen[1].top);
  assert.ok(frozen[0].left < frozen[1].left && frozen[1].left < frozen[2].left);
  assert.ok(frozen[1].width < frozen[2].width);
  const stablePoint = await tile("00").locator(".file-thumb").boundingBox();
  await page.evaluate(() => window.__stableGalleryFixture.finishPreview());
  await tile("00").locator(".natural-loaded img").waitFor();
  assert.deepEqual(
    await positions(),
    frozen,
    "a delayed portrait must not resize or shift the cards",
  );
  await page.mouse.click(
    stablePoint.x + stablePoint.width / 2,
    stablePoint.y + stablePoint.height / 2,
  );
  assert.ok(
    await tile("00").evaluate((card) => card.classList.contains("selected")),
  );
  // Put the sentinel close enough for automatic loading and keep that scroll position.
  await page.locator(".load-more").scrollIntoViewIfNeeded();
  await page.waitForFunction(() =>
    window.__stableGalleryFixture.pages.includes(2),
  );
  const scrollBefore = await page
    .locator(".files-scroll")
    .evaluate((root) => root.scrollTop);
  await page.evaluate(() => window.__stableGalleryFixture.finishPage());
  await tile("31").waitFor();
  assert.deepEqual(
    await positions(),
    frozen,
    "appended pages must not rebalance earlier rows",
  );
  assert.ok(
    Math.abs(
      (await page.locator(".files-scroll").evaluate((root) => root.scrollTop)) -
        scrollBefore,
    ) < 2,
  );
  console.log(
    "PASS: justified gallery order, fixed geometry after cold thumbnails and append, stable clicks and scroll",
  );
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
