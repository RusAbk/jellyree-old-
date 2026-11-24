import { computed, onBeforeUnmount, shallowRef, watch, type Ref } from "vue";
import { documentKind } from "../electron/document-preview.mjs";
import { needsImageProcessing } from "../electron/image-adjustments.mjs";
import { isHeicFile, isImageFile } from "../electron/image-formats.mjs";
import { api } from "./api";
import { imageStyle } from "./format";
import { t } from "./i18n";
import { cancelImageWork, renderImage } from "./image-service";
import { thumbnailRevision } from "./thumbnail";
import type { DriveFile } from "./types";

export function isPhotoPreview(file: DriveFile) {
  return isHeicFile(file) || (isImageFile(file) && !documentKind(file));
}

const cacheLimit = 192 * 1024 * 1024;
const maxEntries = 8;
const keyFor = (file: DriveFile) => JSON.stringify(thumbnailRevision(file));
const unsupported = () =>
  new Error(
    t("Формат не поддерживается встроенным просмотром. Скачайте оригинал."),
  );

type Frame = {
  key: string;
  element: HTMLImageElement | HTMLCanvasElement;
  bytes: number;
};

export function usePhotoPreview(
  photo: Ref<DriveFile | null>,
  files: Ref<DriveFile[]>,
  editing: Ref<boolean>,
  releaseMedia: (url: string) => void,
) {
  const stage = shallowRef<HTMLElement>();
  const displayed = shallowRef<Frame>();
  const error = shallowRef("");
  const key = computed(() => (photo.value ? keyFor(photo.value) : ""));
  const loading = computed(
    () => !!key.value && displayed.value?.key !== key.value && !error.value,
  );
  const cache = new Map<string, Frame>();
  let work:
    | { key: string; controller: AbortController; result: Promise<Frame> }
    | undefined;
  let generation = 0;
  function remember(frame: Frame) {
    const pinned = displayed.value;
    if (
      frame.bytes + (pinned && pinned !== frame ? pinned.bytes : 0) >
      cacheLimit
    ) {
      if (pinned !== frame) dispose(frame);
      return;
    }
    cache.delete(frame.key);
    cache.set(frame.key, frame);
    let bytes = [...cache.values()].reduce(
      (total, entry) => total + entry.bytes,
      0,
    );
    for (const [id, entry] of cache) {
      if (cache.size <= maxEntries && bytes <= cacheLimit) break;
      if (entry === pinned) continue;
      cache.delete(id);
      dispose(entry);
      bytes -= entry.bytes;
    }
  }
  function stop() {
    const pending = work;
    work = undefined;
    pending?.controller.abort();
  }
  function dispose(frame: Frame) {
    if (frame.element instanceof HTMLImageElement) {
      releaseMedia(frame.element.src);
      frame.element.removeAttribute("src");
    }
  }
  function display(frame?: Frame) {
    const previous = displayed.value;
    displayed.value = frame;
    if (previous && previous !== frame && cache.get(previous.key) !== previous)
      dispose(previous);
  }
  async function decode(
    file: DriveFile,
    signal: AbortSignal,
    priority: boolean,
  ) {
    if (isHeicFile(file) || needsImageProcessing(file.adjustments)) {
      const owner = crypto.randomUUID();
      const cancel = () => cancelImageWork(owner);
      signal.addEventListener("abort", cancel, { once: true });
      try {
        const { bitmap } = await renderImage(
          owner,
          file,
          { adjustments: file.adjustments, maxSize: 1600 },
          priority,
        );
        try {
          signal.throwIfAborted();
          const canvas = document.createElement("canvas");
          canvas.className = "processed-image";
          canvas.dataset.imageId = file.id;
          canvas.setAttribute("role", "img");
          canvas.draggable = false;
          canvas.width = bitmap!.width;
          canvas.height = bitmap!.height;
          canvas.getContext("2d")!.drawImage(bitmap!, 0, 0);
          return { element: canvas, bytes: canvas.width * canvas.height * 4 };
        } finally {
          bitmap?.close();
        }
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    }
    const url = await api.url(file.id);
    const image = new Image();
    const cancel = () => image.removeAttribute("src");
    try {
      signal.throwIfAborted();
      signal.addEventListener("abort", cancel, { once: true });
      image.alt = file.name;
      Object.assign(image.style, imageStyle(file.adjustments));
      image.src = url;
      await image.decode().catch(() => {
        signal.throwIfAborted();
        throw unsupported();
      });
      signal.throwIfAborted();
      return {
        element: image,
        bytes: image.naturalWidth * image.naturalHeight * 4,
      };
    } catch (failure) {
      cancel();
      releaseMedia(url);
      throw failure;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
  function load(file: DriveFile, id: string, priority: boolean) {
    if (work?.key === id) return work.result;
    stop();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(unsupported()), 45000);
    const { signal } = controller;
    const result = new Promise<Frame>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      void decode(file, signal, priority)
        .then((decoded) => {
          const frame = { key: id, ...decoded };
          if (signal.aborted) dispose(frame);
          else resolve(frame);
        }, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    }).finally(() => {
      clearTimeout(timeout);
      if (work?.controller === controller) work = undefined;
    });
    work = { key: id, controller, result };
    return result;
  }
  async function prefetch(current: DriveFile, sequence: number) {
    const index = files.value.findIndex((file) => file.id === current.id);
    if (index < 0 || (displayed.value?.bytes ?? 0) >= cacheLimit) return;
    for (const offset of [1, -1]) {
      if (sequence !== generation || work) return;
      const file = files.value[index + offset];
      if (!file || !isPhotoPreview(file) || file.size_bytes > 16 * 1024 * 1024)
        continue;
      const id = keyFor(file);
      if (cache.has(id)) continue;
      try {
        const frame = await load(file, id, false);
        if (sequence === generation) remember(frame);
        else if (key.value !== id) dispose(frame);
      } catch {
        // Opening the photo later can retry a failed prefetch.
      }
    }
  }
  async function show() {
    const sequence = ++generation;
    const file = photo.value;
    const id = key.value;
    error.value = "";
    if (!file) {
      stop();
      display();
      return;
    }
    if (editing.value) {
      stop();
      return;
    }
    if (work?.key !== id) stop();
    try {
      const frame =
        displayed.value?.key === id
          ? displayed.value
          : (cache.get(id) ?? (await load(file, id, true)));
      if (sequence !== generation) {
        if (key.value !== id && cache.get(id) !== frame) dispose(frame);
        return;
      }
      display(frame);
      remember(frame);
      void prefetch(file, sequence);
    } catch (failure) {
      if (sequence === generation) error.value = (failure as Error).message;
    }
  }
  watch([key, editing], show);
  watch(
    [stage, displayed, () => photo.value?.name, loading],
    ([host, frame, name, pending]) => {
      if (!host || !frame) return;
      // Move the already decoded node into view without setting its source again.
      if (host.firstChild !== frame.element)
        host.replaceChildren(frame.element);
      if (pending || !name) return;
      if (frame.element instanceof HTMLImageElement) frame.element.alt = name;
      else frame.element.setAttribute("aria-label", name);
    },
    { flush: "post" },
  );
  function clear() {
    generation++;
    stop();
    display();
    for (const frame of cache.values()) dispose(frame);
    cache.clear();
  }
  onBeforeUnmount(clear);
  return { stage, displayed, loading, error, retry: show, clear };
}
