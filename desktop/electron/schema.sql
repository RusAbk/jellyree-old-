CREATE TABLE IF NOT EXISTS jr_folders (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL,
  parent_id TEXT REFERENCES jr_folders(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jr_folder_parent ON jr_folders(library_id, parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS jr_folder_name ON jr_folders(library_id, IFNULL(parent_id, ''), name);
CREATE TABLE IF NOT EXISTS jr_files (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL,
  folder_id TEXT REFERENCES jr_folders(id) ON DELETE RESTRICT,
  object_key TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  favorite INTEGER NOT NULL DEFAULT 0,
  trashed_at TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  adjustments TEXT NOT NULL DEFAULT '{}',
  captured_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(library_id, object_key)
);
CREATE INDEX IF NOT EXISTS jr_file_folder ON jr_files(library_id, folder_id, trashed_at);
CREATE INDEX IF NOT EXISTS jr_file_date ON jr_files(library_id, created_at);
