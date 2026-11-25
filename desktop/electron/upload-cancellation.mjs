export async function untilUploadCanceled(signal, operation) {
  if (!signal) return operation();
  signal.throwIfAborted();
  let abort;
  const canceled = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([
      canceled,
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return operation();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export class UploadCancellation {
  count = 0;
  #files = new Map();
  #finished = new Set();

  file(index) {
    if (!this.#files.has(index)) {
      const controller = new AbortController();
      this.#files.set(index, {
        signal: controller.signal,
        committing: false,
        abort: () => controller.abort(),
        commit() {
          controller.signal.throwIfAborted();
          this.committing = true;
        },
      });
    }
    return this.#files.get(index);
  }

  cancel(index) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.count ||
      this.#finished.has(index)
    )
      return false;
    const file = this.file(index);
    if (file.committing || file.signal.aborted) return false;
    file.abort();
    return true;
  }

  finish(index) {
    this.#finished.add(index);
    this.#files.delete(index);
  }
}
