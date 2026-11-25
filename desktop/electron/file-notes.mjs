import { randomUUID } from "node:crypto";
import { t } from "./locales.mjs";
import { normalizeNote } from "./note-content.mjs";

const columns = "id, body, revision, created_at, updated_at";
const belongsToLibrary =
  "EXISTS (SELECT 1 FROM jr_files WHERE jr_files.id = jr_file_notes.file_id AND library_id = ?)";
const noteRow = (row) => ({ ...row, body: JSON.parse(row.body) });

export class FileNotes {
  #ready;

  constructor(db, libraryId) {
    this.db = db;
    this.libraryId = libraryId;
  }

  #prepare() {
    this.#ready ??= this.db
      .query(
        `CREATE TABLE IF NOT EXISTS jr_file_notes (
         id TEXT PRIMARY KEY NOT NULL,
         file_id TEXT NOT NULL REFERENCES jr_files(id) ON DELETE CASCADE,
         body TEXT NOT NULL,
         revision INTEGER NOT NULL DEFAULT 1,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       );
       CREATE INDEX IF NOT EXISTS jr_file_notes_by_file ON jr_file_notes(file_id, created_at DESC, id DESC);`,
      )
      .catch((error) => {
        this.#ready = undefined;
        throw error;
      });
    return this.#ready;
  }

  async list(fileId) {
    await this.#prepare();
    return (
      await this.db.query(
        `SELECT ${columns} FROM jr_file_notes WHERE file_id = ? AND ${belongsToLibrary}
       ORDER BY created_at DESC, id DESC`,
        [fileId, this.libraryId],
      )
    ).map(noteRow);
  }

  async save(fileId, input) {
    let body;
    try {
      body = JSON.stringify(normalizeNote(input?.body));
    } catch (error) {
      throw new Error(t(error.message));
    }
    await this.#prepare();
    const now = new Date().toISOString();
    if (input.id === undefined) {
      const [row] = await this.db.query(
        `INSERT INTO jr_file_notes (id, file_id, body, created_at, updated_at)
         SELECT ?, id, ?, ?, ? FROM jr_files WHERE id = ? AND library_id = ? RETURNING ${columns}`,
        [randomUUID(), body, now, now, fileId, this.libraryId],
      );
      if (!row) throw new Error(t("Файл не найден в этом хранилище."));
      return noteRow(row);
    }
    const [row] = await this.db.query(
      `UPDATE jr_file_notes SET body = ?, revision = revision + 1, updated_at = ?
       WHERE id = ? AND file_id = ? AND revision = ? AND ${belongsToLibrary} RETURNING ${columns}`,
      [body, now, input.id, fileId, input.revision ?? null, this.libraryId],
    );
    if (!row)
      throw new Error(t("Заметка уже изменилась. Загрузите список заново."));
    return noteRow(row);
  }

  async remove(fileId, id, revision) {
    await this.#prepare();
    const [row] = await this.db.query(
      `DELETE FROM jr_file_notes WHERE id = ? AND file_id = ? AND revision = ?
       AND ${belongsToLibrary} RETURNING id`,
      [id, fileId, revision, this.libraryId],
    );
    if (!row)
      throw new Error(t("Заметка уже изменилась. Загрузите список заново."));
  }
}
