import 'dart:convert';

import 'cloudflare.dart';

const _pending = 'jr_pending_trash_deletes';
const _batchSize = 250;
const _schema = [
  '''CREATE TABLE IF NOT EXISTS $_pending (
    file_id TEXT NOT NULL PRIMARY KEY REFERENCES jr_files(id) ON DELETE CASCADE,
    object_key TEXT NOT NULL,
    trashed_at TEXT NOT NULL,
    retried INTEGER NOT NULL DEFAULT 0
  )''',
  '''CREATE TRIGGER IF NOT EXISTS jr_block_restore_during_delete
    BEFORE UPDATE OF trashed_at ON jr_files
    WHEN NEW.trashed_at IS NULL AND EXISTS (SELECT 1 FROM $_pending WHERE file_id = OLD.id)
    BEGIN SELECT RAISE(ABORT, 'jellyree_trash_delete_pending'); END''',
];

class TrashOperations {
  TrashOperations(this.cloud);

  final Cloudflare cloud;
  Future<void>? _installed;
  Future<void>? _index;
  String get _libraryId => cloud.config.libraryId;

  Future<void> _install() async {
    try {
      for (final sql in _schema) {
        await cloud.query(sql);
      }
    } on Object {
      _installed = null;
      rethrow;
    }
  }

  Future<void> _createIndex() async {
    try {
      await cloud.query(
        'CREATE INDEX IF NOT EXISTS jr_trash_by_id ON jr_files(library_id, id) WHERE trashed_at IS NOT NULL',
      );
    } on Object {
      _index = null;
    }
  }

  Future<List<Json>> _claim(String filter, List<Object?> params) => cloud.query(
    '''INSERT INTO $_pending(file_id, object_key, trashed_at)
           SELECT id, object_key, trashed_at FROM jr_files WHERE library_id = ? AND $filter
           ON CONFLICT(file_id) DO UPDATE SET retried = 1 RETURNING file_id, object_key''',
    [_libraryId, ...params],
  );

  Future<({int done, int failed})> _finish(List<Json> claims) async {
    if (claims.isEmpty) return (done: 0, failed: 0);
    final response = await cloud.deleteBatch([
      for (final claim in claims) claim['object_key'] as String,
    ]);
    final removed = <String>[];
    final denied = <String>[];
    for (final claim in claims) {
      if (response.rejected.contains(claim['object_key'])) {
        denied.add(claim['file_id'] as String);
      } else if (response.removed.contains(claim['object_key'])) {
        removed.add(claim['file_id'] as String);
      }
    }
    if (removed.isNotEmpty) {
      await cloud.query(
        '''DELETE FROM jr_files WHERE library_id = ? AND trashed_at IS NOT NULL
           AND id IN (SELECT value FROM json_each(?))
           AND EXISTS (SELECT 1 FROM $_pending WHERE file_id = jr_files.id AND object_key = jr_files.object_key)''',
        [_libraryId, jsonEncode(removed)],
      );
    }
    // A definitive rejection can release a first attempt. An earlier attempt
    // with an unknown outcome may already have deleted the same object.
    if (denied.isNotEmpty) {
      await cloud.query(
        'DELETE FROM $_pending WHERE retried = 0 AND file_id IN (SELECT value FROM json_each(?))',
        [jsonEncode(denied)],
      );
    }
    return (done: removed.length, failed: claims.length - removed.length);
  }

  Future<Json> remove(List<String> ids) async {
    await (_installed ??= _install());
    final claims = await _claim('id IN (SELECT value FROM json_each(?))', [
      jsonEncode(ids.toSet().toList()),
    ]);
    final result = await _finish(claims);
    return {'done': result.done, 'failed': result.failed};
  }

  Future<Json> empty() async {
    await (_installed ??= _install());
    await (_index ??= _createIndex());
    var done = 0;
    var failed = 0;
    var after = '';
    while (true) {
      final claims = await _claim(
        'trashed_at IS NOT NULL AND id > ? ORDER BY id LIMIT ?',
        [after, _batchSize],
      );
      final result = await _finish(claims);
      done += result.done;
      failed += result.failed;
      if (claims.length < _batchSize) return {'done': done, 'failed': failed};
      for (final claim in claims) {
        final fileId = claim['file_id'] as String;
        if (fileId.compareTo(after) > 0) after = fileId;
      }
    }
  }
}
