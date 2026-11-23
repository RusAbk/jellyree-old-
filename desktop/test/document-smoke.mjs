import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "@playwright/test";
import { pdfFixture } from "./pdf-fixture.mjs";
import { createServer } from "vite";
const directory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const profile = await mkdtemp(path.join(os.tmpdir(), "jellyree-documents-"));
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
  page.setDefaultTimeout(20000);
  const errors = [],
    requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (
      /^https?:/.test(request.url()) &&
      !request.url().startsWith("http://127.0.0.1:5174/")
    )
      requests.push(request.url());
  });
  await page
    .getByRole("heading", { name: "Cloudflare connection", exact: true })
    .waitFor();
  await app.evaluate(
    ({ ipcMain }, input) => {
      const files = [
        {
          id: "txt",
          name: "Notes.TXT",
          mime_type: "application/octet-stream",
          kind: "text",
          bytes: [
            ...Buffer.from(
              "Hello España\nFind a+b and A+B\n<script>window.__injected = true</script>\n" +
                "long line ".repeat(100),
            ),
          ],
        },
        {
          id: "md",
          name: "Readme.MD",
          mime_type: "text/plain",
          kind: "markdown",
          bytes: [
            ...Buffer.from(
              '# Jellyree Markdown\n\n**Strong text** and _emphasis_.\n\n| Name | Value |\n| --- | --- |\n| One | 1 |\n\n```js\nconst demo = true;\n```\n\n- List item\n- [x] Done\n\n<script>window.__injected = true</script>\n<img src="https://example.com/tracker" onerror="window.__injected = true">\n[unsafe](javascript:alert(1))\n<form><input id="danger" autofocus></form>',
            ),
          ],
        },
        {
          id: "pdf",
          name: "Guide.PDF",
          mime_type: "application/octet-stream",
          kind: "pdf",
          bytes: input.pdf,
        },
        {
          id: "bad",
          name: "Broken.pdf",
          mime_type: "application/pdf",
          kind: "pdf",
          bytes: [1, 2, 3],
        },
        {
          id: "empty",
          name: "Empty.txt",
          mime_type: "text/plain",
          kind: "text",
          bytes: [],
        },
        {
          id: "cyrillic",
          name: "Legacy.txt",
          mime_type: "text/plain",
          kind: "text",
          bytes: [0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2],
        },
      ];
      for (const file of files) file.objectKey = `objects/${file.id}`;
      const publicFile = (file) => ({
        id: file.id,
        name: file.name,
        object_key: file.objectKey,
        mime_type: file.mime_type,
        size_bytes: file.bytes.length,
        tags: [],
        adjustments: {},
        favorite: false,
        folder_id: null,
        trashed_at: null,
        created_at: "2026-11-24",
        updated_at: "2026-11-24",
      });
      const state = {
        files,
        failNext: false,
        pending: null,
        saves: [],
        failSave: false,
        pendingSave: null,
        dialogs: [],
      };
      globalThis.__documents = state;
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
        bucket: "documents",
      }));
      replace("files:list", () => ({
        items: files.map(publicFile),
        total: files.length,
        hasMore: false,
        page: 1,
      }));
      replace("folders:list", () => []);
      replace("stats", () => ({
        files: files.length,
        bytes: 1000,
        tags: [],
        trashed: 0,
      }));
      replace("files:url", () => {
        throw new Error("Document preview requested a signed URL");
      });
      replace("files:document-source", async (id, key) => {
        const file = files.find((f) => f.id === id);
        if (key !== file.objectKey) throw new Error("stale document");
        if (state.failNext) {
          state.failNext = false;
          throw new Error("Simulated R2 failure");
        }
        if (state.pending)
          await new Promise((resolve) => (state.pending = resolve));
        return { data: new Uint8Array(file.bytes), kind: file.kind };
      });
      replace("files:save-text-document", async (id, key, data) => {
        const file = files.find((f) => f.id === id);
        if (key !== file.objectKey)
          throw new Error("Document changed on another device.");
        if (state.failSave) {
          state.failSave = false;
          throw new Error("Simulated save failure");
        }
        const snapshot = [...data];
        state.saves.push({ id, key, bytes: snapshot });
        if (state.pendingSave)
          await new Promise((resolve) => (state.pendingSave = resolve));
        file.bytes = snapshot;
        file.objectKey = `objects/${id}-save-${state.saves.length}`;
        file.mime_type =
          file.kind === "markdown" ? "text/markdown" : "text/plain";
        return { file: publicFile(file) };
      });
    },
    { pdf: pdfFixture() },
  );
  await page.reload();
  const open = async (name) => {
    await page.locator(".file-card").filter({ hasText: name }).dblclick();
  };
  const close = async () => {
    await page
      .getByRole("button", { name: "Close preview", exact: true })
      .click();
  };
  await open("Notes.TXT");
  const text = page.getByRole("region", { name: "Text viewer", exact: true });
  await text.waitFor();
  assert.match(await text.locator("pre").textContent(), /Hello España/);
  assert.match(await text.locator("pre").textContent(), /<script>/);
  await text.getByRole("searchbox", { name: "Find in document" }).fill("a+b");
  assert.equal(await text.locator("mark").count(), 2);
  await text.getByRole("button", { name: "Next match", exact: true }).click();
  assert.equal(await text.locator("mark.current").textContent(), "A+B");
  await text
    .getByRole("checkbox", { name: "Word wrap", exact: true })
    .uncheck();
  assert.equal(
    await text.locator("pre").evaluate((el) => getComputedStyle(el).whiteSpace),
    "pre",
  );
  await text
    .getByRole("combobox", { name: "Text size", exact: true })
    .selectOption("20");
  assert.equal(
    await text.locator("pre").evaluate((el) => getComputedStyle(el).fontSize),
    "20px",
  );
  await text.locator("pre").click();
  await page.keyboard.press("ArrowRight");
  await text.waitFor();
  await close();
  await open("Readme.MD");
  const md = page.getByRole("region", { name: "Markdown viewer", exact: true });
  await md.getByRole("heading", { name: "Jellyree Markdown" }).waitFor();
  assert.equal(await md.locator("table tbody tr").count(), 1);
  assert.equal(
    await md.locator("pre code").textContent(),
    "const demo = true;\n",
  );
  assert.equal(
    await md
      .locator(
        "script,img,iframe,object,form,#danger,[onclick],[onerror],a[href^='javascript:']",
      )
      .count(),
    0,
  );
  assert.equal(await md.locator('input[type="checkbox"]:disabled').count(), 1);
  assert.equal(await page.evaluate(() => !!window.__injected), false);
  await md.getByRole("tab", { name: "Source", exact: true }).click();
  assert.match(await md.locator("pre.plain-text").textContent(), /^# Jellyree/);
  await md.locator("pre").click();
  await page.keyboard.press("Control+f");
  assert.equal(
    await md
      .getByRole("searchbox", { name: "Find in document" })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await close();
  await open("Guide.PDF");
  // Reusable editor exercises real CodeMirror, preload and the save IPC boundary.
  await close();
  await open("Notes.TXT");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const txtEditor = page.getByRole("region", {
    name: "Text editor",
    exact: true,
  });
  const txtInput = txtEditor.getByRole("textbox", {
    name: "Document text",
    exact: true,
  });
  await txtInput.fill("One token\nTwo token");
  await txtEditor
    .getByRole("button", { name: "Find and replace", exact: true })
    .click();
  await txtEditor.locator('input[name="search"]').fill("token");
  await txtEditor.locator('input[name="search"]').press("Tab");
  await txtEditor.locator('input[name="replace"]').fill("word");
  await txtEditor.locator('input[name="replace"]').press("Tab");
  await txtEditor.locator('button[name="replaceAll"]').click();
  assert.match(await txtInput.textContent(), /One wordTwo word/);
  await txtEditor.locator('button[name="close"]').click();
  await txtInput.press("Control+s");
  await txtEditor.getByText("Document saved.", { exact: true }).waitFor();
  assert.equal(
    await app.evaluate(() =>
      Buffer.from(globalThis.__documents.saves.at(-1).bytes).toString(),
    ),
    "One word\nTwo word",
  );
  await txtEditor
    .getByRole("button", { name: "Back to viewer", exact: true })
    .click();
  assert.equal(
    await page.locator("pre.plain-text").textContent(),
    "One word\nTwo word",
  );
  await close();
  await open("Notes.TXT");
  assert.equal(
    await page.locator("pre.plain-text").textContent(),
    "One word\nTwo word",
  );
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await txtInput.fill("Unsaved content");
  const clearBlocked = await page.evaluate(async () => {
    try {
      await window.jellyree.settings.clear();
      return false;
    } catch (error) {
      return error.message.includes("Save or close");
    }
  });
  assert.equal(
    clearBlocked,
    true,
    "connection changes protect unsaved documents",
  );
  await close();
  const discard = page.getByRole("dialog", {
    name: "Unsaved changes",
    exact: true,
  });
  await discard.waitFor();
  await discard
    .getByRole("button", { name: "Keep editing", exact: true })
    .click();
  assert.equal(await txtInput.textContent(), "Unsaved content");
  await app.evaluate(({ dialog, BrowserWindow }) => {
    dialog.showMessageBoxSync = (_window, options) => {
      globalThis.__documents.dialogs.push(options.message);
      return 0;
    };
    BrowserWindow.getAllWindows()[0].webContents.reload();
  });
  let warned = false;
  for (let i = 0; i < 100; i++) {
    warned = await app.evaluate(
      () => globalThis.__documents.dialogs.length > 0,
    );
    if (warned) break;
    await page.waitForTimeout(20);
  }
  assert.equal(warned, true, "native reload asks before discarding edits");
  assert.equal(await txtInput.textContent(), "Unsaved content");
  await close();
  await discard
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await page.locator(".text-editor").waitFor({ state: "detached" });
  await open("Readme.MD");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const mdEditor = page.getByRole("region", {
    name: "Markdown editor",
    exact: true,
  });
  const mdInput = mdEditor.getByRole("textbox", {
    name: "Document text",
    exact: true,
  });
  await mdInput.fill("# Live heading\n\nBody");
  await mdEditor
    .locator(".text-editor-preview")
    .getByRole("heading", { name: "Live heading" })
    .waitFor();
  await mdEditor.getByRole("button", { name: "Preview", exact: true }).click();
  assert.equal(await mdEditor.locator(".text-editor-preview").count(), 0);
  await mdEditor.getByRole("button", { name: "Preview", exact: true }).click();
  await mdEditor
    .locator(".text-editor-preview")
    .getByRole("heading", { name: "Live heading" })
    .waitFor();
  await mdInput.press("Control+End");
  await mdEditor.getByRole("button", { name: "Bold", exact: true }).click();
  assert.match(await mdInput.textContent(), /\*\*text\*\*/);
  await mdEditor.getByRole("button", { name: "Undo", exact: true }).click();
  assert.doesNotMatch(await mdInput.textContent(), /\*\*text\*\*/);
  await mdEditor.getByRole("button", { name: "Redo", exact: true }).click();
  assert.match(await mdInput.textContent(), /\*\*text\*\*/);
  await app.evaluate(() => {
    globalThis.__documents.failSave = true;
  });
  await mdEditor.getByRole("button", { name: "Save", exact: true }).click();
  await mdEditor.getByText("Simulated save failure", { exact: true }).waitFor();
  assert.match(await mdInput.textContent(), /Live heading/);
  await app.evaluate(() => {
    globalThis.__documents.pendingSave = true;
  });
  await mdEditor.getByRole("button", { name: "Save", exact: true }).click();
  let saving = false;
  for (let i = 0; i < 100; i++) {
    saving = await app.evaluate(
      () => typeof globalThis.__documents.pendingSave === "function",
    );
    if (saving) break;
    await page.waitForTimeout(20);
  }
  assert.equal(saving, true);
  await mdInput.press("Control+End");
  await mdInput.press("End");
  await mdInput.pressSequentially(" after save started");
  await app.evaluate(() => {
    globalThis.__documents.pendingSave();
    globalThis.__documents.pendingSave = null;
  });
  await mdEditor.getByRole("button", { name: "Save", exact: true }).waitFor();
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll(".text-editor button")].find(
      (el) => el.textContent.trim() === "Save",
    );
    return button && !button.disabled;
  });
  assert.doesNotMatch(
    await app.evaluate(() =>
      Buffer.from(globalThis.__documents.saves.at(-1).bytes).toString(),
    ),
    /after save started/,
  );
  await close();
  await discard
    .getByRole("button", { name: "Save and leave", exact: true })
    .click();
  await page.locator(".text-editor").waitFor({ state: "detached" });
  assert.match(
    await app.evaluate(() =>
      Buffer.from(
        globalThis.__documents.files.find((file) => file.id === "md").bytes,
      ).toString(),
    ),
    /after save started/,
  );
  await open("Readme.MD");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await mdInput.press("Control+End");
  await mdInput.pressSequentially(" keep this draft");
  await app.evaluate(() => {
    globalThis.__documents.files.find((file) => file.id === "md").objectKey =
      "external-version";
  });
  await mdEditor.getByRole("button", { name: "Save", exact: true }).click();
  await mdEditor
    .getByText("Document changed on another device.", { exact: true })
    .waitFor();
  assert.match(await mdInput.textContent(), /keep this draft/);
  await page.screenshot({
    path: path.join(os.tmpdir(), "jellyree-text-editor.png"),
  });
  await close();
  await discard
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await page.locator(".text-editor").waitFor({ state: "detached" });
  await open("Guide.PDF");
  const pdf = page.getByRole("region", { name: "PDF viewer", exact: true });
  await pdf
    .locator(".pdf-text-layer")
    .getByText("Jellyree PDF page 1", { exact: true })
    .waitFor();
  const nonwhite = await pdf.locator("canvas").evaluate((canvas) => {
    const pixels = canvas
      .getContext("2d")
      .getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4)
      if (pixels[i] < 240 && pixels[i + 3]) count++;
    return count;
  });
  assert.ok(nonwhite > 1000, "PDF paints real text and shapes");
  await pdf.getByRole("button", { name: "Next page", exact: true }).click();
  await pdf
    .locator(".pdf-text-layer")
    .getByText("Jellyree PDF page 2", { exact: true })
    .waitFor();
  await pdf
    .getByRole("combobox", { name: "Zoom", exact: true })
    .selectOption("1.5");
  await page.waitForFunction(
    () => document.querySelector(".pdf-page")?.style.width === "900px",
  );
  await pdf.getByRole("spinbutton", { name: "Page", exact: true }).fill("1");
  await pdf
    .getByRole("spinbutton", { name: "Page", exact: true })
    .press("Enter");
  await pdf
    .locator(".pdf-text-layer")
    .getByText("Jellyree PDF page 1", { exact: true })
    .waitFor();
  await pdf
    .getByRole("combobox", { name: "Zoom", exact: true })
    .selectOption("fit");
  await page.screenshot({
    path: path.join(os.tmpdir(), "jellyree-document-pdf.png"),
  });
  await close();
  await open("Broken.pdf");
  await page
    .getByText(
      "Unable to open this PDF. The file is damaged or has an unsupported format.",
      { exact: true },
    )
    .waitFor();
  await close();
  await open("Empty.txt");
  await page.getByText("This file is empty.", { exact: true }).waitFor();
  await close();
  await open("Legacy.txt");
  await page
    .getByRole("combobox", { name: "Encoding", exact: true })
    .selectOption("windows-1251");
  assert.equal(await page.locator("pre.plain-text").textContent(), "Привет");
  await close();
  await app.evaluate(() => {
    globalThis.__documents.failNext = true;
  });
  await open("Notes.TXT");
  await page.getByText("Simulated R2 failure", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await text.waitFor();
  await close();
  // Finishing a download after the user has closed preview must not reopen it.
  await app.evaluate(() => {
    globalThis.__documents.pending = true;
  });
  await open("Guide.PDF");
  let pending = false;
  for (let i = 0; i < 100; i++) {
    pending = await app.evaluate(
      () => typeof globalThis.__documents.pending === "function",
    );
    if (pending) break;
    await page.waitForTimeout(20);
  }
  assert.ok(pending, "document request reaches main process");
  await close();
  await app.evaluate(() => {
    globalThis.__documents.pending();
    globalThis.__documents.pending = null;
  });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert.equal(await page.locator(".preview-overlay").count(), 0);
  assert.equal(await page.locator(".document-viewer").count(), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    requests,
    [],
    "document viewers do not load remote scripts, fonts, links or tracking images",
  );
  console.log(
    "PASS: PDF pages/zoom/text; TXT and Markdown viewers/editors; find/replace and undo/redo; live preview toggle; UTF-8 saves and reopening; dirty/reload/connection guards; snapshot saves while typing; save errors and stale versions; offline assets and cleanup",
  );
} catch (error) {
  const failedPage = await app?.firstWindow().catch(() => null);
  await failedPage
    ?.screenshot({
      path: path.join(os.tmpdir(), "jellyree-text-editor-failure.png"),
    })
    .catch(() => {});
  console.error(error);
  throw error;
} finally {
  await app
    ?.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = () => 1;
    })
    .catch(() => {});
  await app?.close();
  await server?.close();
  await rm(profile, { recursive: true, force: true });
}
