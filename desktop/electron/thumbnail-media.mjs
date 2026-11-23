import { randomUUID } from "node:crypto";
export class ThumbnailMedia {
  constructor(fetch, { now = Date.now } = {}) {
    this.fetch = fetch;
    this.now = now;
    this.sources = new Map();
  }
  create(url) {
    for (const [key, value] of this.sources)
      if (value.expires < this.now()) this.sources.delete(key);
    while (this.sources.size >= 512)
      this.sources.delete(this.sources.keys().next().value);
    const token = randomUUID();
    this.sources.set(token, { url, expires: this.now() + 50 * 60 * 1000 });
    return `jellyree-media://preview/${token}`;
  }
  clear() {
    this.sources.clear();
  }
  async handle(request) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Range",
      "Cache-Control": "no-store",
    };
    const url = new URL(request.url),
      source = this.sources.get(url.pathname.slice(1));
    if (url.hostname !== "preview" || !source || source.expires < this.now())
      return new Response(null, { status: 404, headers: cors });
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors });
    if (!["GET", "HEAD"].includes(request.method))
      return new Response(null, { status: 405, headers: cors });
    try {
      const headers = new Headers();
      if (request.headers.get("range"))
        headers.set("range", request.headers.get("range"));
      const response = await this.fetch(source.url, {
        method: request.method,
        headers,
        credentials: "omit",
      });
      const output = new Headers(cors);
      for (const key of [
        "content-type",
        "content-length",
        "content-range",
        "accept-ranges",
      ])
        if (response.headers.has(key))
          output.set(key, response.headers.get(key));
      return new Response(request.method === "HEAD" ? null : response.body, {
        status: response.status,
        headers: output,
      });
    } catch {
      return new Response(null, { status: 502, headers: cors });
    }
  }
}
