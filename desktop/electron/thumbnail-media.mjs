import { randomUUID } from "node:crypto";
export class ThumbnailMedia {
  constructor(
    fetch,
    {
      now = Date.now,
      headerTimeoutMs = 15000,
      idleTimeoutMs = 30000,
      maxSources = 512,
    } = {},
  ) {
    this.fetch = fetch;
    this.now = now;
    this.headerTimeoutMs = headerTimeoutMs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.maxSources = maxSources;
    this.sources = new Map();
  }
  create(url) {
    for (const [key, value] of this.sources)
      if (value.expires < this.now()) this.remove(key);
    while (this.sources.size >= this.maxSources) {
      // A paused player still needs its token for future Range requests.
      const idle = [...this.sources].find(
        ([, source]) =>
          !source.controllers.size && typeof source.url !== "function",
      );
      if (!idle) throw new Error("Media preview capacity reached");
      this.remove(idle[0]);
    }
    const token = randomUUID();
    const lifetime =
      typeof url === "function" ? 24 * 60 * 60 * 1000 : 50 * 60 * 1000;
    this.sources.set(token, {
      url,
      expires: this.now() + lifetime,
      controllers: new Set(),
    });
    return `jellyree-media://preview/${token}`;
  }
  remove(token) {
    const source = this.sources.get(token);
    this.sources.delete(token);
    for (const controller of source?.controllers || [])
      controller.abort(new DOMException("Media source released", "AbortError"));
  }
  release(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== "jellyree-media:" || url.hostname !== "preview")
        return false;
      const token = url.pathname.slice(1),
        exists = this.sources.has(token);
      this.remove(token);
      return exists;
    } catch {
      return false;
    }
  }
  clear() {
    for (const key of this.sources.keys()) this.remove(key);
  }
  async handle(request) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Range",
      "Access-Control-Expose-Headers":
        "Content-Length, Content-Range, Accept-Ranges",
      "Cache-Control": "no-store",
    };
    const url = new URL(request.url),
      token = url.pathname.slice(1),
      source = this.sources.get(token);
    if (url.hostname !== "preview" || !source || source.expires < this.now())
      return new Response(null, { status: 404, headers: cors });
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors });
    if (!["GET", "HEAD"].includes(request.method))
      return new Response(null, { status: 405, headers: cors });
    this.sources.delete(token);
    this.sources.set(token, source);
    const controller = new AbortController();
    source.controllers.add(controller);
    let reader, timer;
    const clearTimer = () => clearTimeout(timer);
    const arm = (delay) => {
      clearTimer();
      timer = setTimeout(
        () =>
          controller.abort(
            new DOMException("Media request timed out", "TimeoutError"),
          ),
        delay,
      );
    };
    const cancel = () => controller.abort(request.signal.reason);
    const cleanup = () => {
      clearTimer();
      source.controllers.delete(controller);
      request.signal.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", onAbort);
    };
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => {
        reject(controller.signal.reason);
        void reader?.cancel(controller.signal.reason).catch(() => {});
        cleanup();
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    // This promise may reject after handle() returned its streaming response.
    void aborted.catch(() => {});
    request.signal.addEventListener("abort", cancel, { once: true });
    if (request.signal.aborted) cancel();
    try {
      controller.signal.throwIfAborted();
      arm(this.headerTimeoutMs);
      const headers = new Headers();
      if (request.headers.get("range"))
        headers.set("range", request.headers.get("range"));
      const fetching = Promise.resolve().then(async () => {
        const target =
          typeof source.url === "function" ? await source.url() : source.url;
        controller.signal.throwIfAborted();
        const response = await this.fetch(target, {
          method: request.method,
          headers,
          credentials: "omit",
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          controller.signal.throwIfAborted();
        }
        return response;
      });
      const response = await Promise.race([fetching, aborted]);
      clearTimer();
      const output = new Headers(cors);
      for (const key of [
        "content-type",
        "content-length",
        "content-range",
        "accept-ranges",
      ])
        if (response.headers.has(key))
          output.set(key, response.headers.get(key));
      if (request.method === "HEAD" || !response.body) {
        void response.body?.cancel().catch(() => {});
        cleanup();
        return new Response(null, { status: response.status, headers: output });
      }
      reader = response.body.getReader();
      const body = new ReadableStream({
        pull: async (sink) => {
          try {
            controller.signal.throwIfAborted();
            arm(this.idleTimeoutMs);
            const part = await Promise.race([reader.read(), aborted]);
            controller.signal.throwIfAborted();
            clearTimer();
            if (part.done) {
              cleanup();
              sink.close();
            } else sink.enqueue(part.value);
          } catch (error) {
            controller.abort(error);
            cleanup();
            sink.error(error);
          }
        },
        cancel: (reason) => {
          controller.abort(reason);
          cleanup();
        },
      });
      return new Response(body, { status: response.status, headers: output });
    } catch {
      controller.abort();
      cleanup();
      return new Response(null, { status: 502, headers: cors });
    }
  }
}
