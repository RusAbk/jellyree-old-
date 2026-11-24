import ImageWorker from "./image-worker?worker";
import { api } from "./api";
import { t } from "./i18n";
import { normalizeImageAdjustments } from "../electron/image-adjustments.mjs";
import type { Adjustments, DriveFile } from "./types";
import type { Histogram } from "./image-pixels.mjs";
export type ImageRenderRequest = {
  adjustments: Adjustments;
  maxSize: number;
  uncropped?: boolean;
  clipping?: boolean;
  export?: "png" | "jpeg" | "webp";
  quality?: number;
};
export type ImageRenderResult = {
  bitmap?: ImageBitmap;
  bytes?: ArrayBuffer;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  histogram: Histogram;
};
type Job = {
  id: number;
  owner: string;
  file: DriveFile;
  options: ImageRenderRequest;
  priority: boolean;
  canceled?: boolean;
  posted?: boolean;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  resolve(value: ImageRenderResult): void;
  reject(error: Error): void;
};
let worker: Worker | undefined,
  active: Job | undefined,
  serial = 0;
let cached = new Set<string>();
const queue: Job[] = [],
  sources = new Map<string, { data: Uint8Array; mimeType: string }>();
const keyFor = (file: DriveFile) => `${file.id}:${file.object_key}`;
const abort = () => new DOMException("Superseded image render", "AbortError");
function failure(code: string) {
  if (code === "heic-too-large")
    return new Error(
      t("Для просмотра HEIC доступны изображения до 50 мегапикселей."),
    );
  if (code === "heic-decode-failed")
    return new Error(
      t("Не удалось открыть HEIC/HEIF. Проверьте файл или скачайте оригинал."),
    );
  if (code === "image-too-large")
    return new Error(
      t("Для редактирования доступны изображения до 48 мегапикселей."),
    );
  if (code === "export-too-large")
    return new Error(
      t("Для экспорта этого изображения выберите ограничение размера."),
    );
  return new Error(
    t(
      "Не удалось обработать изображение. Проверьте формат и повторите попытку.",
    ),
  );
}
function stopJob(job: Job, error: Error) {
  job.canceled = true;
  clearTimeout(job.timer);
  job.controller.abort();
  if (active === job) {
    active = undefined;
    if (job.posted) {
      worker?.terminate();
      worker = undefined;
      cached.clear();
    }
  }
  job.reject(error);
}
function createWorker() {
  const currentWorker = new ImageWorker();
  worker = currentWorker;
  currentWorker.onmessage = ({ data }) => {
    const job = active;
    if (worker !== currentWorker || !job || job.id !== data.id) {
      data.bitmap?.close();
      return;
    }
    cached = new Set(data.cached || []);
    active = undefined;
    clearTimeout(job.timer);
    if (job.canceled) {
      data.bitmap?.close();
      job.reject(abort());
    } else if (data.error) job.reject(failure(data.error));
    else job.resolve(data);
    void pump();
  };
  currentWorker.onerror = (event) => {
    event.preventDefault();
    if (worker !== currentWorker) return;
    currentWorker.terminate();
    worker = undefined;
    cached.clear();
    if (active) stopJob(active, failure("worker-failed"));
    void pump();
  };
  currentWorker.onmessageerror = () => {
    if (worker !== currentWorker) return;
    currentWorker.terminate();
    worker = undefined;
    cached.clear();
    if (active) stopJob(active, failure("worker-failed"));
    void pump();
  };
}
async function pump() {
  if (active || !queue.length) return;
  const job = queue.shift()!;
  active = job;
  job.timer = setTimeout(() => {
    if (active === job) {
      stopJob(job, failure("worker-timeout"));
      void pump();
    }
  }, 45000);
  try {
    if (!worker) createWorker();
    const key = keyFor(job.file);
    let source: ArrayBuffer | undefined, mimeType: string | undefined;
    if (!cached.has(key)) {
      let entry = sources.get(key);
      if (!entry) {
        if (typeof window.jellyree.imageSource !== "function")
          throw new Error(
            t("Перезапустите приложение, чтобы обновить обработку загрузки."),
          );
        const requestId = crypto.randomUUID();
        const cancel = () => {
          if (typeof window.jellyree.cancelPreview === "function")
            void api.cancelPreview(requestId).catch(() => {});
        };
        job.controller.signal.addEventListener("abort", cancel, { once: true });
        try {
          entry = await api.imageSource(job.file.id, requestId, {
            objectKey: job.file.object_key,
            thumbnail: false,
          });
        } finally {
          job.controller.signal.removeEventListener("abort", cancel);
        }
        if (active !== job) return;
        sources.set(key, entry);
        let total = [...sources.values()].reduce(
          (sum, value) => sum + value.data.byteLength,
          0,
        );
        for (const [oldKey, value] of sources) {
          if (total <= 40 * 1024 * 1024) break;
          if (oldKey !== key) {
            sources.delete(oldKey);
            total -= value.data.byteLength;
          }
        }
      }
      source = new Uint8Array(entry.data).buffer;
      mimeType = entry.mimeType;
    }
    if (active !== job) return;
    if (job.canceled) {
      active = undefined;
      clearTimeout(job.timer);
      job.reject(abort());
      void pump();
      return;
    }
    job.posted = true;
    worker!.postMessage(
      {
        ...job.options,
        id: job.id,
        key,
        source,
        mimeType,
        fileName: job.file.name,
      },
      source ? [source] : [],
    );
  } catch (error) {
    if (active === job) {
      active = undefined;
      clearTimeout(job.timer);
      job.reject(error as Error);
      void pump();
    }
  }
}
function cancelOwner(owner: string, force: boolean) {
  for (let index = queue.length - 1; index >= 0; index--) {
    if (queue[index]!.owner === owner) {
      stopJob(queue[index]!, abort());
      queue.splice(index, 1);
    }
  }
  if (active?.owner === owner) {
    if (force) stopJob(active, abort());
    else {
      active.canceled = true;
      active.reject(abort());
    }
  }
}
export function cancelImageWork(owner: string) {
  cancelOwner(owner, true);
  void pump();
}
export function renderImage(
  owner: string,
  file: DriveFile,
  options: ImageRenderRequest,
  priority = false,
): Promise<ImageRenderResult> {
  cancelOwner(owner, false);
  return new Promise((resolve, reject) => {
    const job: Job = {
      id: ++serial,
      owner,
      controller: new AbortController(),
      file,
      options: {
        ...options,
        adjustments: normalizeImageAdjustments(options.adjustments),
      },
      priority,
      resolve,
      reject,
    };
    if (priority) queue.unshift(job);
    else queue.push(job);
    void pump();
  });
}
