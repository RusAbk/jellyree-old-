import { t } from "./locales.mjs";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";

const secretKeys = ["apiToken", "accessKeyId", "secretAccessKey"];
const keychainUnavailable = () =>
  t(
    "Системное хранилище ключей недоступно. Разблокируйте его или введите реквизиты заново.",
  );

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
  for (const key of secretKeys)
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
  #profiles = new Map();
  #onDisk = new Map();
  #unreadFile = false;
  #activeId = null;

  constructor(directory, safeStorage) {
    this.directory = directory;
    this.filename = path.join(directory, "connection.enc");
    this.safe = safeStorage;
  }
  get activeId() {
    return this.#activeId;
  }
  get current() {
    return this.connection();
  }
  connection(id = this.#activeId) {
    if (id === null) return null;
    const profile = this.#profiles.get(id);
    if (!profile) throw new Error(t("Подключение не найдено."));
    return profile.config;
  }
  usesLibrary(config) {
    if (this.#unreadFile) return true;
    const namespace = libraryId(config);
    return [...this.#profiles.values()].some(
      ({ config: other }) =>
        other.databaseId === config.databaseId &&
        libraryId(other) === namespace,
    );
  }
  redact(message, input) {
    let result = String(message);
    const candidates = [
      ...this.#profiles.values(),
      ...this.#onDisk.values(),
      { config: input },
    ];
    for (const { config } of candidates)
      for (const key of secretKeys) {
        const value =
          typeof config?.[key] === "string" ? config[key].trim() : "";
        if (value) result = result.replaceAll(value, t("[скрыто]"));
      }
    return result;
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
      const encrypted = await readFile(this.filename);
      this.#unreadFile = true;
      if (!(await this.secureAvailable()))
        throw new Error(keychainUnavailable());
      const decrypted = await this.safe.decryptStringAsync(encrypted);
      const saved = JSON.parse(decrypted.result);
      const profiles = new Map();
      if (saved.version === 2) {
        for (const { id, name, config } of saved.profiles) {
          if (typeof id !== "string" || !id || profiles.has(id))
            throw new Error(t("Не удалось прочитать сохранённые подключения."));
          profiles.set(id, { id, name, config: normalizeConfig(config) });
        }
      } else {
        const config = normalizeConfig(saved);
        profiles.set("legacy", { id: "legacy", name: config.bucket, config });
      }
      this.#profiles = profiles;
      this.#onDisk = new Map(profiles);
      this.#activeId = profiles.has(saved.activeId)
        ? saved.activeId
        : (profiles.keys().next().value ?? null);
      this.#unreadFile = false;
    } catch (error) {
      if (this.#unreadFile || error.code !== "ENOENT") {
        this.#unreadFile = true;
        throw error;
      }
    }
    return this.summary();
  }
  merge(input) {
    const existing = this.connection(input?.profileId);
    return normalizeConfig({
      ...input,
      ...Object.fromEntries(
        secretKeys.map((k) => [
          k,
          String(input?.[k] ?? "").trim() || existing?.[k] || "",
        ]),
      ),
    });
  }
  async #persist(profiles, activeId) {
    if (this.#unreadFile || !(await this.secureAvailable())) return false;
    if (!profiles.size) {
      await rm(this.filename, { force: true });
      this.#onDisk.clear();
      return true;
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.tmp`;
    try {
      await writeFile(
        temporary,
        await this.safe.encryptStringAsync(
          JSON.stringify({
            version: 2,
            activeId,
            profiles: [...profiles.values()],
          }),
        ),
        { mode: 0o600 },
      );
      await rename(temporary, this.filename);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    this.#onDisk = new Map(profiles);
    return true;
  }
  async save(config, input = {}) {
    const previousId =
      input.profileId === undefined ? this.#activeId : input.profileId;
    this.connection(previousId);
    const id = previousId ?? randomUUID();
    const name =
      String(input.name ?? this.#profiles.get(id)?.name ?? "").trim() ||
      config.bucket;
    if (name.length > 80 || /[\x00-\x1f\x7f]/.test(name))
      throw new Error(t("Укажите название подключения до 80 символов."));
    const profiles = new Map(this.#profiles);
    profiles.set(id, { id, name, config: normalizeConfig(config) });
    await this.#persist(profiles, id);
    this.#profiles = profiles;
    this.#activeId = id;
    return this.summary();
  }
  async select(id) {
    if (!this.#profiles.has(id)) throw new Error(t("Подключение не найдено."));
    if (id !== this.#activeId) {
      await this.#persist(this.#profiles, id);
      this.#activeId = id;
    }
    return this.summary();
  }
  async clear(id = this.#activeId) {
    if (id === null) return this.summary();
    this.connection(id);
    const profiles = new Map(this.#profiles);
    profiles.delete(id);
    const activeId =
      id === this.#activeId
        ? (profiles.keys().next().value ?? null)
        : this.#activeId;
    const persisted = await this.#persist(profiles, activeId);
    if (!persisted && this.#onDisk.has(id)) {
      if (this.#onDisk.size > 1) throw new Error(keychainUnavailable());
      await rm(this.filename, { force: true });
      this.#onDisk.clear();
    }
    this.#profiles = profiles;
    this.#activeId = activeId;
    return this.summary();
  }
  summary() {
    const profiles = [...this.#profiles.values()].map((profile) => {
      const {
        id,
        name,
        config: { accountId, databaseId, bucket, prefix },
      } = profile;
      return {
        id,
        name,
        accountId,
        databaseId,
        bucket,
        prefix,
        persisted: profile === this.#onDisk.get(id),
      };
    });
    const { id, ...active } =
      profiles.find(({ id }) => id === this.#activeId) ?? {};
    return {
      configured: !!id,
      persisted: false,
      ...(id ? { ...active, hasSecrets: true, activeProfileId: id } : {}),
      profiles,
    };
  }
}
