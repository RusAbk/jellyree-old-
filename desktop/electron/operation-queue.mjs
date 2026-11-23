// Keep uploads (and bucket indexing) ordered while reads and downloads continue.
export class OperationQueue {
  pending = 0;
  #tail = Promise.resolve();
  run(operation) {
    this.pending++;
    const result = this.#tail.then(operation).finally(() => {
      this.pending--;
    });
    this.#tail = result.catch(() => {});
    return result;
  }
}
