export function createPreviewQueue(limit = 3) {
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError("Invalid preview concurrency");
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(job: () => Promise<T>): Promise<T> => {
    await new Promise<void>((resolve) => {
      const enter = () => {
        active++;
        resolve();
      };
      if (active < limit) enter();
      else waiting.push(enter);
    });
    try {
      return await job();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}
export const runVideoPreview = createPreviewQueue();
export function videoDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.floor(seconds),
    hours = Math.floor(total / 3600),
    minutes = Math.floor(total / 60) % 60;
  return `${hours ? `${hours}:` : ""}${hours ? String(minutes).padStart(2, "0") : minutes}:${String(total % 60).padStart(2, "0")}`;
}
