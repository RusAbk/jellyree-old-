import { translate, normalizeLanguage } from "../../electron/locales.mjs";
import type {
  Jellyree,
  Progress,
  ThumbnailEntry,
  UploadConflict,
  UploadResult,
} from "../types";

const base = new URL(".", document.baseURI);
const language = () =>
  normalizeLanguage(localStorage.getItem("jellyree-desktop-language"));
type Message = { key: string; values?: Record<string, unknown> };
type Result<T> = {
  ok: boolean;
  value: T;
  error?: string;
  values?: Record<string, unknown>;
};
type Cached = Omit<ThumbnailEntry, "data"> & { bytes: string };
const text = (message: string | Message) =>
  typeof message === "string"
    ? message
    : translate(language(), message.key, message.values);

function encodeArgs(args: unknown[]) {
  const bytes = new TextEncoder().encode(JSON.stringify(args));
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_");
}

async function request(method: string, args: unknown[], bytes?: Uint8Array) {
  return fetch(new URL(`_rpc/${method}`, base), {
    method: "POST",
    cache: "no-store",
    headers: bytes
      ? {
          "Content-Type": "application/octet-stream",
          "X-Jellyree-Args": encodeArgs(args),
        }
      : { "Content-Type": "application/json" },
    body: bytes ? new Uint8Array(bytes).buffer : JSON.stringify(args),
  });
}

async function call<T>(
  method: string,
  args: unknown[] = [],
  bytes?: Uint8Array,
): Promise<T> {
  const response = await request(method, args, bytes);
  const result = (await response.json().catch(() => null)) as Result<T> | null;
  if (!response.ok || !result?.ok)
    throw new Error(
      translate(
        language(),
        result?.error || "Не удалось выполнить операцию.",
        result?.values,
      ),
    );
  return result.value;
}

async function binary(method: string, args: unknown[]) {
  const response = await request(method, args);
  const mimeType =
    response.headers.get("Content-Type") || "application/octet-stream";
  if (!response.ok || mimeType.startsWith("application/json")) {
    const result = (await response
      .json()
      .catch(() => null)) as Result<never> | null;
    throw new Error(
      translate(
        language(),
        result?.error || "Не удалось выполнить операцию.",
        result?.values,
      ),
    );
  }
  return {
    data: new Uint8Array(await response.arrayBuffer()),
    mimeType,
    kind: response.headers.get("X-Jellyree-Kind") as
      "pdf" | "text" | "markdown",
  };
}

function uploads(result: UploadResult) {
  return {
    ...result,
    warnings: result.warnings?.map(text),
    failures: result.failures.map((failure) => ({
      ...failure,
      message: text(failure.message),
    })),
  };
}

async function persistPreferences() {
  const stored = await call<Record<string, string>>("preferences").catch(
    () => ({}),
  );
  for (const [key, value] of Object.entries(stored)) {
    if (key.startsWith("jellyree-desktop-")) localStorage.setItem(key, value);
  }
  const set = Storage.prototype.setItem;
  const remove = Storage.prototype.removeItem;
  const pending: Record<string, string | null> = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writes = Promise.resolve();
  const schedule = (key: string, value: string | null) => {
    if (!key.startsWith("jellyree-desktop-")) return;
    pending[key] = value;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const snapshot = { ...pending };
      for (const key of Object.keys(snapshot)) delete pending[key];
      writes = writes
        .then(() => call<void>("setPreferences", [snapshot]))
        .catch(() => {});
    }, 100);
  };
  Storage.prototype.setItem = function (key, value) {
    set.call(this, key, value);
    if (this === localStorage) schedule(key, value);
  };
  Storage.prototype.removeItem = function (key) {
    remove.call(this, key);
    if (this === localStorage) schedule(key, null);
  };
}

export async function installMobileBridge() {
  await persistPreferences();
  const events = new EventSource(new URL("_events", base));
  const subscribe = <T>(type: string, callback: (value: T) => void) => {
    const receive = (event: Event) =>
      callback(JSON.parse((event as MessageEvent).data));
    events.addEventListener(type, receive);
    return () => events.removeEventListener(type, receive);
  };
  // Safari 15 did not expose randomUUID to every WebView. Values remain random.
  if (!crypto.randomUUID) {
    Object.defineProperty(crypto, "randomUUID", {
      value: () => {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6]! & 0x0f) | 0x40;
        bytes[8] = (bytes[8]! & 0x3f) | 0x80;
        const hex = Array.from(bytes, (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        return [
          hex.slice(0, 8),
          hex.slice(8, 12),
          hex.slice(12, 16),
          hex.slice(16, 20),
          hex.slice(20),
        ].join("-");
      },
    });
  }
  const bridge: Jellyree = {
    thumbnails: {
      async get(revision) {
        const result = await call<{ epoch: number; entry: Cached | null }>(
          "thumb.get",
          [revision],
        );
        return {
          epoch: result.epoch,
          entry: result.entry
            ? {
                width: result.entry.width,
                height: result.entry.height,
                duration: result.entry.duration,
                data: Uint8Array.from(atob(result.entry.bytes), (char) =>
                  char.charCodeAt(0),
                ),
              }
            : null,
        };
      },
      dimensions: (revisions) => call("thumb.dimensions", [revisions]),
      put: (revision, { data, ...entry }, epoch) =>
        call("thumb.put", [revision, entry, epoch], data),
      source: (revision, id) => call("thumb.source", [revision, id]),
      stats: () => call("thumb.stats"),
      clear: () => call("thumb.clear"),
    },
    settings: {
      get: () => call("settings.get"),
      test: (input) => call("settings.test", [input]),
      save: (input) => call("settings.save", [input]),
      select: (id) => call("settings.select", [id]),
      clear: (id) => call("settings.clear", [id]),
    },
    setLocale: (locale) => call("setLocale", [locale]),
    list: (input) => call("list", [input]),
    timelineBounds: (kind) => call("timelineBounds", [kind]),
    update: (ids, patch) => call("update", [ids, patch]),
    remove: (ids) => call("remove", [ids]),
    emptyTrash: () => call("emptyTrash"),
    url: (id) => call("url", [id]),
    imageSource: (id, request, revision) =>
      binary("imageSource", [id, request, revision]),
    documentSource: (id, revision) => binary("documentSource", [id, revision]),
    cancelPreview: (id) => call("cancelPreview", [id]),
    releaseMedia: (url) => call("releaseMedia", [url]),
    saveTextDocument: async (id, revision, data) => {
      const result = await call<
        Awaited<ReturnType<Jellyree["saveTextDocument"]>>
      >("saveTextDocument", [id, revision], data);
      return {
        file: result.file,
        warning: result.warning ? text(result.warning) : undefined,
      };
    },
    saveEditedImage: async (id, revision, data) => {
      const result = await call<
        Awaited<ReturnType<Jellyree["saveEditedImage"]>>
      >("saveEditedImage", [id, revision], data);
      return {
        file: result.file,
        warning: result.warning ? text(result.warning) : undefined,
      };
    },
    setDocumentDraft: (owner, dirty) =>
      call("setDocumentDraft", [owner, dirty]),
    videoSource: (revision) => call("videoSource", [revision]),
    duplicatePhoto: (id, key) => call("duplicatePhoto", [id, key]),
    saveVideoFrame: (id, key, timestamp, data) =>
      call("saveVideoFrame", [id, key, timestamp], data),
    downloadVideoFrame: (id, key, timestamp, data) =>
      call("downloadVideoFrame", [id, key, timestamp], data),
    exportImage: (id, data, format) => call("exportImage", [id, format], data),
    share: (id) => call("share", [id]),
    download: (ids) => call("download", [ids]),
    pickUpload: async (folder, folders, job) =>
      uploads(await call("pickUpload", [folder, folders, job])),
    dropUpload: async () => ({ done: 0, canceled: true, failures: [] }),
    retryUpload: async (ids, job) =>
      uploads(await call("retryUpload", [ids, job])),
    importBucket: () => call("importBucket"),
    answerUploadConflict: (input) => call("answerUploadConflict", [input]),
    onUploadConflict: (callback) =>
      subscribe<UploadConflict>("conflict", callback),
    onProgress: (callback) => subscribe<Progress>("progress", callback),
    folders: () => call("folders"),
    createFolder: (name, parent) => call("createFolder", [name, parent]),
    updateFolder: (id, patch) => call("updateFolder", [id, patch]),
    deleteFolder: (id) => call("deleteFolder", [id]),
    stats: () => call("stats"),
  };
  window.jellyree = bridge;
}
