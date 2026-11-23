export function createPreviewQueue(limit = 3) {
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError("Invalid preview concurrency");
  let active = 0;
  const waiting: Array<{ start(): void }> = [];
  const pump = () => {
    while (active < limit && waiting.length) waiting.shift()!.start();
  };
  return <T>(
    job: (signal: AbortSignal) => Promise<T>,
    {
      signal,
      timeoutMs = 30000,
    }: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> => {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let started = false,
        settled = false,
        timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: unknown, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (started) active--;
        else {
          const index = waiting.indexOf(entry);
          if (index >= 0) waiting.splice(index, 1);
        }
        if (error !== undefined) reject(error);
        else resolve(value as T);
        pump();
      };
      const abort = () => {
        const error =
          signal?.reason || new DOMException("Preview canceled", "AbortError");
        controller.abort(error);
        finish(error);
      };
      const entry = {
        start() {
          started = true;
          active++;
          timer = setTimeout(() => {
            const error = new DOMException("Preview timed out", "TimeoutError");
            controller.abort(error);
            finish(error);
          }, timeoutMs);
          Promise.resolve()
            .then(() => {
              controller.signal.throwIfAborted();
              return job(controller.signal);
            })
            .then(
              (value) => finish(undefined, value),
              (error) => finish(error),
            );
        },
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      waiting.push(entry);
      pump();
    });
  };
}
export const runVideoPreview = createPreviewQueue();
export const runThumbnailPreview = createPreviewQueue(3);
export function videoDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.floor(seconds),
    hours = Math.floor(total / 3600),
    minutes = Math.floor(total / 60) % 60;
  return `${hours ? `${hours}:` : ""}${hours ? String(minutes).padStart(2, "0") : minutes}:${String(total % 60).padStart(2, "0")}`;
}
