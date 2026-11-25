import 'dart:convert';

import 'package:uuid/uuid.dart';

import 'cloudflare.dart';

const _blocks = {'paragraph', 'heading', 'bulletList', 'orderedList'};
const _inline = {'text', 'hardBreak'};
const _marks = {'bold', 'italic', 'underline'};
const _children = {
  'doc': _blocks,
  'listItem': _blocks,
  'paragraph': _inline,
  'heading': _inline,
  'bulletList': {'listItem'},
  'orderedList': {'listItem'},
};
const _invalid = CloudError('Некорректный формат заметки.');
const _tooLong = CloudError('Заметка может содержать до 500 символов.');
const _conflict = CloudError(
  'Заметка уже изменилась. Загрузите список заново.',
);

String _noteText(Json node) {
  final type = node['type'];
  if (type == 'text') return node['text'] as String;
  if (type == 'hardBreak') return '\n';
  final separator = type == 'paragraph' || type == 'heading' ? '' : '\n';
  return ((node['content'] as List<Json>?) ?? [])
      .map(_noteText)
      .join(separator);
}

Json normalizeNote(Object? body) {
  var visited = 0;
  Json sanitize(Object? node, Set<String> allowed, int depth) {
    if (node is! Json ||
        !allowed.contains(node['type']) ||
        depth > 12 ||
        ++visited > 2500) {
      throw _invalid;
    }
    final type = node['type'] as String;
    if (type == 'text') {
      final text = node['text'];
      if (text is! String || text.isEmpty || text.length > 1000) {
        throw _tooLong;
      }
      final marks = node['marks'];
      if (marks != null &&
          (marks is! List ||
              marks.length > _marks.length ||
              marks.any(
                (mark) => mark is! Json || !_marks.contains(mark['type']),
              ))) {
        throw _invalid;
      }
      final kinds = {
        for (final mark in (marks as List? ?? [])) (mark as Json)['type'],
      };
      return {
        'type': type,
        'text': text,
        if (kinds.isNotEmpty)
          'marks': [
            for (final kind in kinds) {'type': kind},
          ],
      };
    }
    if (type == 'hardBreak') return {'type': type};
    final content = node['content'] ?? [];
    if (content is! List ||
        ({'doc', 'listItem', 'bulletList', 'orderedList'}.contains(type) &&
            content.isEmpty) ||
        (type == 'listItem' &&
            (content[0] is! Json || content[0]['type'] != 'paragraph'))) {
      throw _invalid;
    }
    final normalized = <String, dynamic>{'type': type};
    final attrs = node['attrs'];
    if (type == 'heading') {
      final level = attrs is Json ? attrs['level'] : null;
      if (![1, 2, 3].contains(level)) throw _invalid;
      normalized['attrs'] = {'level': level};
    }
    if (type == 'orderedList') {
      final start = (attrs is Json ? attrs['start'] : null) ?? 1;
      if (start is! int || start < 1 || start > 9007199254740991) {
        throw _invalid;
      }
      normalized['attrs'] = {'start': start};
    }
    if (content.isNotEmpty) {
      normalized['content'] = [
        for (final child in content)
          sanitize(child, _children[type]!, depth + 1),
      ];
    }
    return normalized;
  }

  final normalized = sanitize(body, {'doc'}, 0);
  final text = _noteText(normalized);
  if (text.runes.length > 500) throw _tooLong;
  if (text.trim().isEmpty) throw const CloudError('Введите текст заметки.');
  return normalized;
}

const _columns = 'id, body, revision, created_at, updated_at';
const _belongsToLibrary =
    'EXISTS (SELECT 1 FROM jr_files WHERE jr_files.id = jr_file_notes.file_id AND library_id = ?)';

class FileNotes {
  FileNotes(this.cloud, this.timestamp);
  final Cloudflare cloud;
  final String Function() timestamp;
  Future<void>? _ready;

  Future<void> _prepare() => _ready ??= (() async {
    try {
      await cloud.query('''CREATE TABLE IF NOT EXISTS jr_file_notes (
        id TEXT PRIMARY KEY NOT NULL,
        file_id TEXT NOT NULL REFERENCES jr_files(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )''');
      await cloud.query(
        'CREATE INDEX IF NOT EXISTS jr_file_notes_by_file ON jr_file_notes(file_id, created_at DESC, id DESC)',
      );
    } on Object {
      _ready = null;
      rethrow;
    }
  })();

  Json _noteRow(Json row) => {
    ...row,
    'body': jsonDecode(row['body'] as String),
  };

  Future<List<Json>> list(String fileId) async {
    await _prepare();
    final rows = await cloud.query(
      'SELECT $_columns FROM jr_file_notes WHERE file_id = ? AND $_belongsToLibrary ORDER BY created_at DESC, id DESC',
      [fileId, cloud.config.libraryId],
    );
    return rows.map(_noteRow).toList();
  }

  Future<Json> save(String fileId, Json input) async {
    final body = jsonEncode(normalizeNote(input['body']));
    await _prepare();
    final now = timestamp();
    final id = input['id'];
    final library = cloud.config.libraryId;
    if (id == null) {
      final rows = await cloud.query(
        'INSERT INTO jr_file_notes (id, file_id, body, created_at, updated_at) '
        'SELECT ?, id, ?, ?, ? FROM jr_files WHERE id = ? AND library_id = ? RETURNING $_columns',
        [const Uuid().v4(), body, now, now, fileId, library],
      );
      if (rows.isEmpty) {
        throw const CloudError('Файл не найден в этом хранилище.');
      }
      return _noteRow(rows.single);
    }
    final rows = await cloud.query(
      'UPDATE jr_file_notes SET body = ?, revision = revision + 1, updated_at = ? '
      'WHERE id = ? AND file_id = ? AND revision = ? AND $_belongsToLibrary RETURNING $_columns',
      [body, now, id, fileId, input['revision'], library],
    );
    if (rows.isEmpty) throw _conflict;
    return _noteRow(rows.single);
  }

  Future<void> remove(String fileId, String id, int revision) async {
    await _prepare();
    final rows = await cloud.query(
      'DELETE FROM jr_file_notes WHERE id = ? AND file_id = ? AND revision = ? '
      'AND $_belongsToLibrary RETURNING id',
      [id, fileId, revision, cloud.config.libraryId],
    );
    if (rows.isEmpty) throw _conflict;
  }
}
