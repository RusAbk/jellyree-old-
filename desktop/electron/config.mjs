import { t } from "./locales.mjs";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";

export function normalizeConfig(input) {
  const config = Object.fromEntries(
    [
      "accountId",
      "databaseId",
      "apiToken",
      "bucket",
      "accessKeyId",
      "secretAccessKey",
      "prefix",
    ].map((key) => [key, String(input?.[key] ?? "").trim()]),
  );
  if (!/^[a-f\d]{32}$/i.test(config.accountId))
    throw new Error(
      t("Account ID должен содержать 32 шестнадцатеричных символа."),
    );
  if (
    !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(
      config.databaseId,
    )
  )
    throw new Error(t("Укажите UUID базы Cloudflare D1."));
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket))
    throw new Error(t("Некорректное имя R2 bucket."));
  for (const key of ["apiToken", "accessKeyId", "secretAccessKey"])
    if (!config[key]) throw new Error(t("Заполните {0}.", { 0: key }));
  config.prefix = config.prefix.replace(/^\/+|\/+$/g, "");
  if (
    config.prefix.split("/").some((p) => p === ".." || p === ".") ||
    /[\\\x00-\x1f]/.test(config.prefix)
  )
    throw new Error(t("Некорректный префикс объектов."));
  config.accountId = config.accountId.toLowerCase();
  config.databaseId = config.databaseId.toLowerCase();
  return config;
}

export function libraryId(config) {
  return createHash("sha256")
    .update([config.accountId, config.bucket, config.prefix].join("\0"))
    .digest("hex");
}

export class ConfigStore {
  constructor(directory, safeStorage) {
    this.directory = directory;
    this.safe = safeStorage;
    this.current = null;
    this.persisted = false;
  }
  async secureAvailable() {
    return (
      (await this.safe.isAsyncEncryptionAvailable()) &&
      (process.platform !== "linux" ||
        this.safe.getSelectedStorageBackend() !== "basic_text")
    );
  }
  async load() {
    try {
      const encrypted = await readFile(
        path.join(this.directory, "connection.enc"),
      );
      if (!(await this.secureAvailable()))
        throw new Error(
          t(
            "Системное хранилище ключей недоступно. Разблокируйте его или введите реквизиты заново.",
          ),
        );
      const decrypted = await this.safe.decryptStringAsync(encrypted);
      this.current = normalizeConfig(JSON.parse(decrypted.result));
      this.persisted = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return this.summary();
  }
  merge(input) {
    return normalizeConfig({
      ...input,
      ...Object.fromEntries(
        ["apiToken", "accessKeyId", "secretAccessKey"].map((k) => [
          k,
          input[k] || this.current?.[k] || "",
        ]),
      ),
    });
  }
  async save(config) {
    const persisted = await this.secureAvailable();
    if (persisted) {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const target = path.join(this.directory, "connection.enc");
      await writeFile(
        `${target}.tmp`,
        await this.safe.encryptStringAsync(JSON.stringify(config)),
        { mode: 0o600 },
      );
      await rename(`${target}.tmp`, target);
    } else {
      await rm(path.join(this.directory, "connection.enc"), { force: true });
    }
    this.current = config;
    this.persisted = persisted;
    return this.summary();
  }
  async clear() {
    await rm(path.join(this.directory, "connection.enc"), { force: true });
    this.current = null;
    this.persisted = false;
  }
  summary() {
    if (!this.current) return { configured: false, persisted: false };
    const { accountId, databaseId, bucket, prefix } = this.current;
    return {
      configured: true,
      persisted: this.persisted,
      accountId,
      databaseId,
      bucket,
      prefix,
      hasSecrets: true,
    };
  }
}
