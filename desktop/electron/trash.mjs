import { createHash } from "node:crypto";
import { DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { t } from "./locales.mjs";

const batchSize = 250;
const pending = "jr_pending_trash_deletes";
const restoreBlocked = "jellyree_trash_delete_pending";
const schema = [
  `CREATE TABLE IF NOT EXISTS ${pending} (
    file_id TEXT NOT NULL PRIMARY KEY REFERENCES jr_files(id) ON DELETE CASCADE,
    object_key TEXT NOT NULL,
    trashed_at TEXT NOT NULL,
    retried INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TRIGGER IF NOT EXISTS jr_block_restore_during_delete
    BEFORE UPDATE OF trashed_at ON jr_files
    WHEN NEW.trashed_at IS NULL AND EXISTS (SELECT 1 FROM ${pending} WHERE file_id = OLD.id)
    BEGIN SELECT RAISE(ABORT, '${restoreBlocked}'); END`,
];
const trashIndex =
  "CREATE INDEX IF NOT EXISTS jr_trash_by_id ON jr_files(library_id, id) WHERE trashed_at IS NOT NULL";

export function pendingRestoreError(error) {
  return error.message?.includes(restoreBlocked)
    ? new Error(
        t(
          "Для этого файла уже началось окончательное удаление. Повторите удаление из корзины.",
        ),
      )
    : error;
}

export class Trash {
  #schema;
  #index;

  constructor(db, s3, libraryId, bucket) {
    this.db = db;
    this.s3 = s3;
    this.libraryId = libraryId;
    this.bucket = bucket;
  }
  async #prepare(empty) {
    this.#schema ??= (async () => {
      for (const sql of schema) await this.db.query(sql);
    })().catch((error) => {
      this.#schema = undefined;
      throw error;
    });
    await this.#schema;
    if (empty) {
      this.#index ??= this.db.query(trashIndex).catch(() => {
        this.#index = undefined;
      });
      await this.#index;
    }
  }
  async #claim(filter, params) {
    try {
      return await this.db.query(
        `INSERT INTO ${pending}(file_id, object_key, trashed_at)
         SELECT id, object_key, trashed_at FROM jr_files WHERE library_id = ? AND ${filter}
         ON CONFLICT(file_id) DO UPDATE SET retried = 1 RETURNING file_id, object_key`,
        [this.libraryId, ...params],
      );
    } catch (error) {
      if (error.message?.includes(`${pending}.trashed_at`))
        throw new Error(t("Сначала переместите файл в корзину."));
      throw error;
    }
  }
  async #deleteObjects(keys) {
    const command = new DeleteObjectsCommand({
      Bucket: this.bucket,
      Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: false },
    });
    command.middlewareStack.add(
      (next) => (args) => {
        args.request.headers["content-md5"] = createHash("md5")
          .update(args.request.body)
          .digest("base64");
        return next(args);
      },
      { step: "build", name: "trashDeleteContentMd5" },
    );
    const result = await this.s3.send(command);
    const rejected = new Set(result.Errors?.map(({ Key }) => Key));
    const removed = new Set(result.Deleted?.map(({ Key }) => Key));
    return { removed, rejected };
  }
  async #finish(claims) {
    if (!claims.length) return { done: 0, failed: 0 };
    const { removed, rejected } = await this.#deleteObjects(
      claims.map(({ object_key }) => object_key),
    );
    const succeeded = [];
    const denied = [];
    for (const { file_id, object_key } of claims) {
      if (rejected.has(object_key)) denied.push(file_id);
      else if (removed.has(object_key)) succeeded.push(file_id);
    }
    if (succeeded.length) {
      await this.db.query(
        `DELETE FROM jr_files WHERE library_id = ? AND trashed_at IS NOT NULL
         AND id IN (SELECT value FROM json_each(?))
         AND EXISTS (SELECT 1 FROM ${pending} WHERE file_id = jr_files.id AND object_key = jr_files.object_key)`,
        [this.libraryId, JSON.stringify(succeeded)],
      );
    }
    // A definitive rejection can release a first attempt. An earlier attempt
    // with an unknown outcome may already have deleted the same object.
    if (denied.length) {
      await this.db.query(
        `DELETE FROM ${pending} WHERE retried = 0 AND file_id IN (SELECT value FROM json_each(?))`,
        [JSON.stringify(denied)],
      );
    }
    return { done: succeeded.length, failed: claims.length - succeeded.length };
  }
  async remove(ids) {
    const selected = [...new Set(ids)];
    if (!selected.length) return { done: 0, failed: 0 };
    await this.#prepare(false);
    // Claim the whole selection before deleting anything, including when an
    // active row slipped into the selection. The NOT NULL constraint aborts it.
    const claims = await this.#claim("id IN (SELECT value FROM json_each(?))", [
      JSON.stringify(selected),
    ]);
    return this.#finish(claims);
  }
  async empty() {
    await this.#prepare(true);
    const result = { done: 0, failed: 0 };
    let after = "";
    for (;;) {
      const claims = await this.#claim(
        "trashed_at IS NOT NULL AND id > ? ORDER BY id LIMIT ?",
        [after, batchSize],
      );
      const batch = await this.#finish(claims);
      result.done += batch.done;
      result.failed += batch.failed;
      if (claims.length < batchSize) return result;
      for (const { file_id } of claims) if (file_id > after) after = file_id;
    }
  }
}
