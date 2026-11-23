import ImageWorker from "./image-worker?worker&inline";
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
function createWorker() {
  worker = new ImageWorker();
  worker.onmessage = ({ data }) => {
    cached = new Set(data.cached || []);
    const job = active;
    if (!job || job.id !== data.id) {
      data.bitmap?.close();
      return;
    }
    active = undefined;
    if (job.canceled) {
      data.bitmap?.close();
      job.reject(abort());
    } else if (data.error) job.reject(failure(data.error));
    else job.resolve(data);
    void pump();
  };
  worker.onerror = (event) => {
    event.preventDefault();
    worker?.terminate();
    worker = undefined;
    cached.clear();
    const job = active;
    active = undefined;
    job?.reject(failure("worker-failed"));
    void pump();
  };
}
async function pump() {
  if (active || !queue.length) return;
  const job = queue.shift()!;
  active = job;
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
        entry = await api.imageSource(job.file.id);
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
    if (job.canceled) throw abort();
    worker!.postMessage(
      { ...job.options, id: job.id, key, source, mimeType },
      source ? [source] : [],
    );
  } catch (error) {
    active = undefined;
    job.reject(error as Error);
    void pump();
  }
}
export function cancelImageWork(owner: string) {
  for (let index = queue.length - 1; index >= 0; index--) {
    if (queue[index]!.owner === owner) {
      queue[index]!.reject(abort());
      queue.splice(index, 1);
    }
  }
  if (active?.owner === owner) active.canceled = true;
}
export function renderImage(
  owner: string,
  file: DriveFile,
  options: ImageRenderRequest,
  priority = false,
): Promise<ImageRenderResult> {
  cancelImageWork(owner);
  return new Promise((resolve, reject) => {
    const job: Job = {
      id: ++serial,
      owner,
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
