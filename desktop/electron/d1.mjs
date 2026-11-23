import { t } from "./locales.mjs";
export class D1 {
  constructor(config, request = fetch) {
    this.url = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}/query`;
    this.token = config.apiToken;
    this.request = request;
  }
  async execute(body, { signal } = {}) {
    const response = await this.request(this.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
        : AbortSignal.timeout(60000),
      redirect: "error",
    });
    const data = await response.json().catch(() => null);
    if (
      !response.ok ||
      !data?.success ||
      data.result?.some((r) => r.success === false)
    ) {
      // Never include request headers or credentials in errors sent to the renderer.
      const message =
        data?.errors?.map((e) => e.message).join("; ") ||
        data?.result?.find((r) => r.error)?.error ||
        `HTTP ${response.status}`;
      throw new Error(
        `Cloudflare D1: ${String(message).replaceAll(this.token, t("[скрыто]"))}`,
      );
    }
    if (!Array.isArray(data.result))
      throw new Error(t("Cloudflare D1: некорректный ответ API."));
    return data.result;
  }
  async query(sql, params = [], options) {
    return (await this.execute({ sql, params }, options))[0]?.results ?? [];
  }
  async batch(statements) {
    return this.execute({ batch: statements });
  }
}
