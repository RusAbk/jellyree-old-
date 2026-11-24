export const changesTable = "jr_catalog_scope_changes";
export const folderTreeScope = "folders";

export function catalogScope(section, folderId) {
  if (section === "drive") return `folder:${folderId ?? ""}`;
  if (section === "trash") return "trash";
  return "active";
}

export function scopeFilter(scope) {
  return scope === "active"
    ? ["library_id = ? AND current_state = 1 AND scope <> 'folders'", []]
    : ["library_id = ? AND scope = ?", [scope]];
}

const fileScope = (row) =>
  `CASE WHEN ${row}.trashed_at IS NOT NULL THEN 'trash' ELSE 'folder:' || IFNULL(${row}.folder_id, '') END`;
const record = (row, scope, current, when = "1") =>
  `INSERT INTO ${changesTable}(library_id, scope, entity_id, current_state)
   SELECT ${row}.library_id, ${scope}, ${row}.id, ${current} WHERE ${when}
   ON CONFLICT(library_id, scope, entity_id) DO UPDATE
   SET revision = excluded.revision, token = excluded.token, current_state = excluded.current_state;`;
const trigger = (table, event, body) =>
  `CREATE TRIGGER IF NOT EXISTS jr_scope_${table}_${event.toLowerCase()}
   AFTER ${event} ON jr_${table} BEGIN ${body} END`;

export const journalSchema = [
  `CREATE TABLE IF NOT EXISTS ${changesTable} (
    revision INTEGER PRIMARY KEY AUTOINCREMENT, library_id TEXT NOT NULL,
    scope TEXT NOT NULL, entity_id TEXT NOT NULL, current_state INTEGER NOT NULL,
    token TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
    UNIQUE(library_id, scope, entity_id)
  )`,
  `CREATE INDEX IF NOT EXISTS jr_change_by_scope ON ${changesTable}(library_id, scope, revision)`,
  `CREATE INDEX IF NOT EXISTS jr_change_active ON ${changesTable}(library_id, revision)
   WHERE current_state = 1 AND scope <> 'folders'`,
  trigger("files", "INSERT", record("new", fileScope("new"), 1)),
  trigger(
    "files",
    "UPDATE",
    record(
      "old",
      fileScope("old"),
      0,
      `${fileScope("old")} <> ${fileScope("new")}`,
    ) + record("new", fileScope("new"), 1),
  ),
  trigger("files", "DELETE", record("old", fileScope("old"), 1)),
  ...["INSERT", "UPDATE", "DELETE"].map((event) =>
    trigger(
      "folders",
      event,
      record(event === "DELETE" ? "old" : "new", "'folders'", 1),
    ),
  ),
];
