export class UploadCancellation {
  count = 0;
  #files = new Map();
  #next = 0;

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
    if (!Number.isInteger(index) || index < this.#next || index >= this.count)
      return false;
    const file = this.file(index);
    if (file.committing || file.signal.aborted) return false;
    file.abort();
    return true;
  }

  finish(index) {
    this.#next = index + 1;
    this.#files.delete(index);
  }
}
