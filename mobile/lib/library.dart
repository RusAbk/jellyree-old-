import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:mime/mime.dart';
import 'package:uuid/uuid.dart';
import 'package:xml/xml.dart';

import 'capture_date.dart';
import 'cloudflare.dart';

const mobilePageSize = 80;
const _visualMedia =
    "mime_type LIKE 'image/%' OR mime_type LIKE 'video/%' OR "
    "LOWER(name) LIKE '%.heic' OR LOWER(name) LIKE '%.heif' OR "
    "LOWER(name) LIKE '%.pxz' OR LOWER(mime_type) = 'application/pxz'";
const mobileVisualMedia = '($_visualMedia)';
const mobileTimelineMedia = "($_visualMedia OR mime_type LIKE 'audio/%')";
const mediaDateColumn = 'COALESCE(captured_at, created_at)';
final _uuid = Uuid();

String cleanName(Object? value) {
  final name = (value as String? ?? '').trim();
  if (name.isEmpty ||
      name.length > 255 ||
      name == '.' ||
      name == '..' ||
      name.contains(RegExp(r'[/\\\x00-\x1f]'))) {
    throw const CloudError(
      'Имя должно содержать от 1 до 255 символов без слешей и управляющих символов.',
    );
  }
  return name;
}

String timestamp() => DateTime.now()
    .toUtc()
    .toIso8601String()
    .replaceFirstMapped(RegExp(r'(\.\d{3})\d+Z$'), (match) => '${match[1]}Z');

bool isPxz(Json file) =>
    (file['name'] as String).toLowerCase().endsWith('.pxz') ||
    ['application/pxz', 'image/pxz'].contains(file['mime_type']);

String mediaType(Json file) {
  if (isPxz(file)) return 'application/pxz';
  final name = (file['name'] as String).toLowerCase();
  if (name.endsWith('.heic') || name.endsWith('.heif')) return 'image/heic';
  return (file['mime_type'] as String).split(';').first.toLowerCase();
}

String? documentKind(Json file) {
  final name = (file['name'] as String).toLowerCase();
  final type = mediaType(file);
  if (name.endsWith('.pdf') || type == 'application/pdf') return 'pdf';
  if (name.endsWith('.md') ||
      name.endsWith('.markdown') ||
      type == 'text/markdown') {
    return 'markdown';
  }
  if (name.endsWith('.txt') || type == 'text/plain') return 'text';
  return null;
}

Json fileRow(Json row) => {
  ...row,
  'favorite': row['favorite'] == 1,
  'tags': jsonDecode(row['tags'] as String) as List,
  'adjustments': jsonDecode(row['adjustments'] as String) as Json,
};

class ListingQuery {
  ListingQuery(Json input, String libraryId) {
    final section = input['section'] as String? ?? 'drive';
    feedScope = switch (section) {
      'drive' => "folder:${input['folderId'] ?? ''}",
      'trash' => 'trash',
      _ => 'active',
    };
    where = [
      'library_id = ?',
      section == 'trash' ? 'trashed_at IS NOT NULL' : 'trashed_at IS NULL',
    ];
    params = [libraryId];
    if (section == 'drive') {
      where.add('folder_id IS ?');
      params.add(input['folderId']);
    }
    if (section == 'favorites') where.add('favorite = 1');
    usesCaptureDate =
        section == 'timeline' ||
        (section == 'photos' && !['name', 'size'].contains(input['sort']));
    if (section == 'photos') {
      if (usesCaptureDate) where.add(mobileTimelineMedia);
      where.add(mobileVisualMedia);
    }
    bool ascending = false;
    if (section == 'timeline') {
      where.add(mobileTimelineMedia);
      final before = DateTime.tryParse(
        input['timelineBefore'] as String? ?? '',
      );
      final since = DateTime.tryParse(input['timelineSince'] as String? ?? '');
      if (before != null || since != null) {
        ascending = before == null;
        where.add('$mediaDateColumn ${ascending ? '>=' : '<'} ?');
        params.add(
          ascending ? input['timelineSince'] : input['timelineBefore'],
        );
      }
    }
    final search = input['search'] as String? ?? '';
    if (search.isNotEmpty) {
      where.add(
        r"(name LIKE ? ESCAPE '\' OR EXISTS (SELECT 1 FROM json_each(jr_files.tags) WHERE value LIKE ? ESCAPE '\'))",
      );
      final term =
          '%${search.replaceAllMapped(RegExp(r'[\\%_]'), (match) => '\\${match[0]}')}%';
      params.addAll([term, term]);
    }
    final tag = input['tag'] as String? ?? '';
    if (tag.isNotEmpty) {
      where.add(
        'EXISTS (SELECT 1 FROM json_each(jr_files.tags) WHERE value = ?)',
      );
      params.add(tag);
    }
    sortKey = 'created_at';
    column = usesCaptureDate ? mediaDateColumn : 'created_at';
    dir = ascending ? 'ASC' : 'DESC';
    if (section != 'timeline') {
      switch (input['sort']) {
        case 'name':
          sortKey = 'name';
          column = 'name COLLATE NOCASE';
          dir = 'ASC';
        case 'size':
          sortKey = column = 'size_bytes';
      }
    }
  }

  late final List<String> where;
  late final List<Object?> params;
  late final String sortKey, column, dir, feedScope;
  late final bool usesCaptureDate;
  String get base => 'FROM jr_files WHERE ${where.join(' AND ')}';
  String get cacheKey => jsonEncode([where, params, column, dir]);

  ({String sql, List<Object?> params}) select(
    int limit,
    Json? after,
    int offset,
  ) {
    final op = dir == 'ASC' ? '>' : '<';
    final cursor = after == null ? '' : ' AND ($column, id) $op (?, ?)';
    return (
      sql:
          'SELECT * $base$cursor ORDER BY $column $dir, id $dir LIMIT ? OFFSET ?',
      params: [
        ...params,
        if (after != null) ...[
          (usesCaptureDate ? after['captured_at'] : null) ?? after[sortKey],
          after['id'],
        ],
        limit,
        offset,
      ],
    );
  }
}

class MobileLibrary {
  MobileLibrary(this.cloud, this.cache);
  final Cloudflare cloud;
  final Directory cache;
  final Map<String, (DateTime, Json)> _files = {};
  final Map<String, (DateTime, Future<String?>)> _heads = {};
  Future<void>? _captureSchema;
  Future<void>? _mediaDateIndex;
  int _revision = 0;
  String get id => cloud.config.libraryId;

  Future<void> check() async {
    await (await cloud.object('HEAD')).drain<void>();
    await cloud.query('SELECT 1 AS ready');
  }

  Future<void> initialize(String schema, List<String> journal) async {
    for (final statement in schema.split(';')) {
      if (statement.trim().isNotEmpty) await cloud.query(statement.trim());
    }
    await _ensureCaptureSchema();
    await cloud.query(
      'CREATE INDEX IF NOT EXISTS jr_active_folder_date ON jr_files(library_id, folder_id, created_at DESC, id DESC) WHERE trashed_at IS NULL',
    );
    await cloud.query(
      'CREATE INDEX IF NOT EXISTS jr_active_folder_name ON jr_files(library_id, folder_id, name, created_at DESC, id DESC) WHERE trashed_at IS NULL',
    );
    final installed = await cloud.query(
      "SELECT 1 AS ok FROM sqlite_schema WHERE type = 'trigger' AND name = 'jr_scope_folders_delete'",
    );
    if (installed.isEmpty) {
      for (final statement in journal) {
        await cloud.query(statement);
      }
    }
  }

  Future<void> _ensureCaptureSchema() {
    Future<bool> hasColumn() async =>
        (await cloud.query('PRAGMA table_info(jr_files)'))
            .any((column) => column['name'] == 'captured_at');
    return _captureSchema ??=
        (() async {
          if (await hasColumn()) return;
          try {
            await cloud.query(
              'ALTER TABLE jr_files ADD COLUMN captured_at TEXT',
            );
          } on Object {
            if (!await hasColumn()) rethrow;
          }
        })().catchError((Object error, StackTrace stackTrace) {
          _captureSchema = null;
          Error.throwWithStackTrace(error, stackTrace);
        });
  }

  Future<void> _ensureMediaDateIndex() async {
    await _ensureCaptureSchema();
    await (_mediaDateIndex ??= (() async {
      try {
        await cloud.query(
          'CREATE INDEX IF NOT EXISTS jr_media_capture_date ON jr_files(library_id, $mediaDateColumn DESC, id DESC) WHERE trashed_at IS NULL AND $mobileTimelineMedia',
        );
      } on CloudError {
        // The list remains usable if D1 limits delay the index build.
      }
    })());
  }

  void remember(Json file) {
    if (_files.length >= 2000) _files.remove(_files.keys.first);
    _files[file['id'] as String] = (DateTime.now(), file);
  }

  Future<Json> file(
    String fileId, {
    String? expected,
    bool fresh = false,
  }) async {
    final cached = _files[fileId];
    if (!fresh &&
        cached != null &&
        DateTime.now().difference(cached.$1) < const Duration(minutes: 2) &&
        (expected == null || cached.$2['object_key'] == expected)) {
      return cached.$2;
    }
    final rows = await cloud.query(
      'SELECT * FROM jr_files WHERE id = ? AND library_id = ?',
      [fileId, id],
    );
    if (rows.isEmpty) {
      throw const CloudError('Файл не найден в этом хранилище.');
    }
    final file = fileRow(rows.single);
    if (expected != null && file['object_key'] != expected) {
      throw const CloudError('Изображение изменилось. Откройте его заново.');
    }
    remember(file);
    return file;
  }

  Future<void> invalidate() async {
    _revision++;
    _files.clear();
    _heads.clear();
  }

  Future<void> purgeCache() async {
    await invalidate();
    if (await cache.exists()) {
      try {
        await cache.delete(recursive: true);
      } on FileSystemException {
        /* Cache is optional. */
      }
    }
  }

  Future<String?> _head(String scope, {required bool refresh}) {
    final checked = _heads[scope];
    final now = DateTime.now();
    if (!refresh &&
        checked != null &&
        now.difference(checked.$1) < const Duration(seconds: 60)) {
      return checked.$2;
    }
    final active = scope == 'active';
    final head = () async {
      try {
        final rows = await cloud.query(
          "SELECT revision, token FROM jr_catalog_scope_changes WHERE library_id = ? AND "
          "${active ? "current_state=1 AND scope <> 'folders'" : 'scope = ?'} "
          'ORDER BY revision DESC LIMIT 1',
          [id, if (!active) scope],
        );
        return rows.isEmpty
            ? 'none'
            : "${rows.single['revision']}:${rows.single['token']}";
      } on CloudError {
        return null;
      }
    }();
    if (_heads.length >= 150) _heads.remove(_heads.keys.first);
    _heads[scope] = (now, head);
    return head;
  }

  String _scopeHash(String value) =>
      sha256.convert(utf8.encode(value)).toString();
  File _pageFile(String scope, int page) =>
      File('${cache.path}/${_scopeHash(scope)}-$page.json');
  Future<Json?> _readPage(String scope, int page) async {
    try {
      return jsonDecode(await _pageFile(scope, page).readAsString()) as Json;
    } on Object {
      return null;
    }
  }

  Future<void> _writePage(String scope, int page, Json record) async {
    try {
      await cache.create(recursive: true);
      final file = _pageFile(scope, page);
      final temporary = File('${file.path}.${_uuid.v4()}.tmp');
      await temporary.writeAsString(jsonEncode(record));
      await temporary.rename(file.path);
    } on FileSystemException {
      /* A failed cache write must not fail a cloud read. */
    }
  }

  Future<Json> list(Json input) async {
    final query = ListingQuery(input, id);
    final page = (input['page'] as int? ?? 1).clamp(1, 1000000);
    final through = (input['throughPage'] as int? ?? page).clamp(
      page,
      page + 4,
    );
    final scope = query.cacheKey;
    final current = _revision;
    final cached = await Future.wait([
      for (var i = page; i <= through; i++) _readPage(scope, i),
    ]);
    Json result(List<Json> rows, bool more) {
      for (final file in rows) {
        remember(file);
      }
      return {'items': rows, 'page': through, 'hasMore': more};
    }

    final usable = cached.every((entry) => entry != null);
    final stored = usable
        ? [
            for (final entry in cached)
              ...(entry!['items'] as List).cast<Json>(),
          ]
        : <Json>[];
    final refresh = input['refresh'] == true;
    final head = await _head(query.feedScope, refresh: refresh);
    if (!refresh &&
        usable &&
        head != null &&
        cached.every((entry) => entry!['head'] == head)) {
      return result(stored, cached.last!['hasMore'] == true);
    }
    try {
      if (query.usesCaptureDate) await _ensureMediaDateIndex();
      final previous = page > 1 ? await _readPage(scope, page - 1) : null;
      final priorItems = previous?['items'] as List?;
      final after =
          priorItems == null ||
              priorItems.isEmpty ||
              (head != null && previous?['head'] != head)
          ? null
          : priorItems.last as Json;
      final limit = (through - page + 1) * mobilePageSize;
      final sql = query.select(
        limit + 1,
        after,
        after == null ? (page - 1) * mobilePageSize : 0,
      );
      final rows = (await cloud.query(
        sql.sql,
        sql.params,
      )).map(fileRow).toList();
      final more = rows.length > limit;
      final items = rows.take(limit).toList();
      if (current == _revision) {
        for (var index = page; index <= through; index++) {
          final start = (index - page) * mobilePageSize;
          await _writePage(scope, index, {
            'head': head,
            'items': items.skip(start).take(mobilePageSize).toList(),
            'hasMore': rows.length > start + mobilePageSize,
          });
        }
      }
      return result(items, more);
    } on Object {
      if (!usable || input['refresh'] == true) rethrow;
      return result(stored, cached.last!['hasMore'] == true);
    }
  }

  Future<Json> timelineBounds() async {
    await _ensureMediaDateIndex();
    final match =
        'FROM jr_files WHERE library_id = ? AND trashed_at IS NULL AND $mobileTimelineMedia';
    final rows = await cloud.query(
      'SELECT (SELECT $mediaDateColumn $match ORDER BY $mediaDateColumn ASC LIMIT 1) AS oldest, '
      '(SELECT $mediaDateColumn $match ORDER BY $mediaDateColumn DESC LIMIT 1) AS newest',
      [id, id],
    );
    return rows.single;
  }

  Future<Json> stats() async {
    final [summary] = await cloud.query(
      'SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes),0) AS bytes, COALESCE(SUM(trashed_at IS NOT NULL),0) AS trashed FROM jr_files WHERE library_id = ?',
      [id],
    );
    final tags = await cloud.query(
      'SELECT DISTINCT value AS tag FROM jr_files, json_each(jr_files.tags) WHERE library_id = ? AND trashed_at IS NULL ORDER BY value COLLATE NOCASE',
      [id],
    );
    return {...summary, 'tags': tags.map((tag) => tag['tag']).toList()};
  }

  Future<List<Json>> folders() => cloud.query(
    'SELECT id, name, parent_id, created_at FROM jr_folders WHERE library_id = ? ORDER BY name COLLATE NOCASE',
    [id],
  );
  Future<void> requireFolder(String? folder) async {
    if (folder == null) return;
    final rows = await cloud.query(
      'SELECT id FROM jr_folders WHERE id = ? AND library_id = ?',
      [folder, id],
    );
    if (rows.isEmpty) throw const CloudError('Папка не найдена.');
  }

  Future<Json> createFolder(String name, String? parent) async {
    await requireFolder(parent);
    final rows = await cloud.query(
      'INSERT INTO jr_folders (id,library_id,parent_id,name,created_at) VALUES (?,?,?,?,?) RETURNING id,name,parent_id,created_at',
      [_uuid.v4(), id, parent, cleanName(name), timestamp()],
    );
    return rows.single;
  }

  Future<Json> updateFolder(String folder, Json patch) async {
    final all = {for (final row in await folders()) row['id'] as String: row};
    final row = all[folder];
    if (row == null) throw const CloudError('Папка не найдена.');
    final parent = patch.containsKey('parentId')
        ? patch['parentId'] as String?
        : row['parent_id'] as String?;
    if (parent != null && !all.containsKey(parent)) {
      throw const CloudError('Папка не найдена.');
    }
    final seen = {folder};
    for (
      var next = parent;
      next != null;
      next = all[next]?['parent_id'] as String?
    ) {
      if (!seen.add(next)) {
        throw const CloudError('Нельзя переместить папку внутрь самой себя.');
      }
    }
    return (await cloud.query(
      'UPDATE jr_folders SET parent_id=?,name=? WHERE id=? AND library_id=? RETURNING id,name,parent_id,created_at',
      [parent, cleanName(patch['name'] ?? row['name']), folder, id],
    )).single;
  }

  Future<void> deleteFolder(String folder) async {
    await cloud
        .query(
          'DELETE FROM jr_folders WHERE id=? AND library_id=? AND NOT EXISTS (SELECT 1 FROM jr_files WHERE folder_id=?) AND NOT EXISTS (SELECT 1 FROM jr_folders WHERE parent_id=?) RETURNING id',
          [folder, id, folder, folder],
        )
        .then((rows) {
          if (rows.isEmpty) {
            throw const CloudError(
              'Удалить можно только пустую папку. Переместите файлы, включая файлы в корзине, и вложенные папки.',
            );
          }
        });
  }

  void validateIds(List<String> ids) {
    if (ids.isEmpty || ids.length > 1000) {
      throw const CloudError('Выберите от 1 до 1000 файлов.');
    }
  }

  Future<void> update(List<String> ids, Json patch) async {
    validateIds(ids);
    final sets = ['updated_at = ?'];
    final params = <Object?>[timestamp()];
    void set(String key, Object? value) {
      sets.add('$key = ?');
      params.add(value);
    }

    if (patch.containsKey('name')) {
      if (ids.length != 1) {
        throw const CloudError('Переименовывать можно по одному файлу.');
      }
      set('name', cleanName(patch['name']));
    }
    if (patch.containsKey('folderId')) {
      await requireFolder(patch['folderId'] as String?);
      set('folder_id', patch['folderId']);
    }
    if (patch.containsKey('favorite')) {
      set('favorite', patch['favorite'] == true ? 1 : 0);
    }
    if (patch.containsKey('trashed')) {
      set('trashed_at', patch['trashed'] == true ? timestamp() : null);
    }
    if (patch.containsKey('tags')) {
      final tags = (patch['tags'] as List).map(cleanName).toSet();
      if (tags.length > 50) throw const CloudError('Не более 50 тегов.');
      set('tags', jsonEncode(tags.toList()));
    }
    if (patch.containsKey('adjustments')) {
      set('adjustments', jsonEncode(patch['adjustments']));
    }
    final guard = patch['expectedObjectKey'] as String?;
    if (guard != null && ids.length != 1) {
      throw const CloudError('Некорректные параметры изображения.');
    }
    try {
      for (var offset = 0; offset < ids.length; offset += 50) {
        final batch = ids.skip(offset).take(50).toList();
        final rows = await cloud.query(
          'UPDATE jr_files SET ${sets.join(', ')} WHERE library_id = ? AND id IN (${batch.map((_) => '?').join(',')})'
          '${guard == null ? '' : ' AND object_key = ? AND trashed_at IS NULL'} RETURNING id',
          [...params, id, ...batch, ?guard],
        );
        if (guard != null && rows.length != 1) {
          throw const CloudError(
            'Изображение изменилось. Откройте его заново.',
          );
        }
      }
    } finally {
      await invalidate();
    }
  }

  Future<int> remove(List<String> ids) async {
    validateIds(ids);
    var done = 0;
    try {
      for (final fileId in ids.toSet()) {
        final file = await this.file(fileId, fresh: true);
        if (file['trashed_at'] == null) {
          throw const CloudError('Файл не найден в этом хранилище.');
        }
        await cloud.delete(file['object_key'] as String);
        final rows = await cloud.query(
          'DELETE FROM jr_files WHERE id = ? AND library_id = ? AND object_key = ? AND trashed_at IS NOT NULL RETURNING id',
          [fileId, id, file['object_key']],
        );
        done += rows.length;
      }
    } finally {
      await invalidate();
    }
    return done;
  }

  Future<List<Json>> named(String? folder, String name) => cloud
      .query(
        'SELECT * FROM jr_files WHERE library_id = ? AND folder_id IS ? AND name = ? AND trashed_at IS NULL ORDER BY created_at DESC,id DESC',
        [id, folder, name],
      )
      .then((rows) => rows.map(fileRow).toList());

  Future<Set<String>> existingNames(String? folder, Set<String> names) async {
    final entries = names.toList(growable: false);
    final result = <String>{};
    for (var i = 0; i < entries.length; i += 75) {
      final chunk = entries.skip(i).take(75).toList(growable: false);
      final rows = await cloud.query(
        'SELECT DISTINCT name FROM jr_files WHERE library_id=? AND folder_id IS ? AND trashed_at IS NULL AND name IN (${chunk.map((_) => '?').join(',')})',
        [id, folder, ...chunk],
      );
      result.addAll(rows.map((row) => row['name'] as String));
    }
    return result;
  }

  Future<String> availableName(
    String? folder,
    String name, {
    int start = 0,
  }) async {
    final dot = name.lastIndexOf('.');
    final extension = dot > 0 ? name.substring(dot) : '';
    final stem = dot > 0 ? name.substring(0, dot) : name;
    for (var i = start; ; i++) {
      final suffix = '${i == 0 ? '' : ' ($i)'}$extension';
      final safeSuffix = suffix.length < 255 ? suffix : ' ($i)';
      final value =
          stem.substring(0, stem.length.clamp(0, 255 - safeSuffix.length)) +
          safeSuffix;
      if ((await named(folder, value)).isEmpty) return value;
    }
  }

  String _objectKey(String? name) => [
    if (cloud.config['prefix'].isNotEmpty) cloud.config['prefix'],
    'objects',
    _uuid.v4(),
    ?name,
  ].join('/');

  Future<Json> _register(
    String fileId,
    String key,
    String name,
    String sql,
    List<Object?> input,
  ) async {
    try {
      final rows = await cloud.query(sql, input);
      if (rows.isEmpty) {
        throw const CloudError(
          'Файл изменился во время загрузки. Повторите операцию.',
        );
      }
      return fileRow(rows.single);
    } on Object {
      List<Json> saved;
      try {
        saved = await cloud.query(
          'SELECT * FROM jr_files WHERE id = ? AND library_id = ?',
          [fileId, id],
        );
      } on Object {
        throw CloudError(
          'Не удалось подтвердить запись D1 для {0}. Объект сохранён в R2; проверьте подключение. Ключ: {1}',
          {'0': name, '1': key},
        );
      }
      if (saved.isNotEmpty && saved.single['object_key'] == key) {
        return fileRow(saved.single);
      }
      await cloud.delete(key);
      rethrow;
    } finally {
      await invalidate();
    }
  }

  Future<({Json file, String? warning})> write(
    File bytes,
    String name,
    String? folder, {
    String? mimeType,
    Json? replace,
    bool preserveCaptureDate = false,
    void Function(int)? report,
  }) async {
    await _ensureCaptureSchema();
    await requireFolder(folder);
    name = cleanName(name);
    final original = replace == null
        ? null
        : await file(
            replace['id'] as String,
            expected: replace['object_key'] as String,
            fresh: true,
          );
    if (original != null &&
        (original['trashed_at'] != null ||
            original['folder_id'] != folder ||
            original['name'] != replace!['name'])) {
      throw const CloudError(
        'Файл изменился во время загрузки. Повторите операцию.',
      );
    }
    final size = await bytes.length();
    final key = _objectKey(null);
    final fileId = original?['id'] as String? ?? _uuid.v4();
    final type = mimeType ?? lookupMimeType(name) ?? 'application/octet-stream';
    final capturedAt = preserveCaptureDate
        ? (original?['captured_at'])
        : await readCaptureDate(bytes, type);
    await cloud.put(key, bytes, size, type, report ?? (_) {});
    final now = timestamp();
    final rename = original != null && original['name'] != name;
    final saved = await _register(
      fileId,
      key,
      name,
      original == null
          ? 'INSERT INTO jr_files (id,library_id,folder_id,object_key,name,mime_type,size_bytes,captured_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING *'
          : "UPDATE jr_files SET object_key=?,name=?,mime_type=?,size_bytes=?,adjustments='{}',captured_at=?,updated_at=? WHERE id=? AND library_id=? AND object_key=? AND trashed_at IS NULL AND name=? AND folder_id IS ?"
                "${rename ? ' AND NOT EXISTS (SELECT 1 FROM jr_files AS other WHERE other.library_id=? AND other.folder_id IS ? AND other.name=? AND other.trashed_at IS NULL)' : ''} RETURNING *",
      original == null
          ? [fileId, id, folder, key, name, type, size, capturedAt, now, now]
          : [
              key,
              name,
              type,
              size,
              capturedAt,
              now,
              fileId,
              id,
              original['object_key'],
              original['name'],
              folder,
              if (rename) ...[id, folder, name],
            ],
    );
    String? warning;
    if (original != null) {
      try {
        await cloud.delete(original['object_key'] as String);
      } on Object {
        warning = name;
      }
    }
    return (file: saved, warning: warning);
  }

  Future<Json> duplicate(String fileId, String expected) async {
    await _ensureCaptureSchema();
    final source = await file(fileId, expected: expected, fresh: true);
    if (!(mediaType(source).startsWith('image/') || isPxz(source)) ||
        source['trashed_at'] != null) {
      throw const CloudError('Выберите изображение.');
    }
    final folder = source['folder_id'] as String?;
    final name = await availableName(
      folder,
      source['name'] as String,
      start: 1,
    );
    final key = _objectKey(null);
    final newId = _uuid.v4();
    await cloud.xmlResponse(
      await cloud.object('PUT', key, const {}, {
        'x-amz-copy-source': s3Path([
          cloud.config['bucket'],
          ...expected.split('/'),
        ]),
      }),
    );
    final now = timestamp();
    return _register(
      newId,
      key,
      name,
      'INSERT INTO jr_files (id,library_id,folder_id,object_key,name,mime_type,size_bytes,favorite,tags,adjustments,captured_at,created_at,updated_at) '
      'SELECT ?,library_id,folder_id,?,?,mime_type,size_bytes,favorite,tags,adjustments,captured_at,?,? FROM jr_files '
      'WHERE library_id=? AND id=? AND object_key=? AND folder_id IS ? AND trashed_at IS NULL RETURNING *',
      [newId, key, name, now, now, id, fileId, expected, folder],
    );
  }

  Future<int> importBucket() async {
    var scanned = 0;
    String? token;
    final prefix = cloud.config['prefix'];
    try {
      do {
        final xml = await cloud.xmlResponse(
          await cloud.object('GET', null, {
            'list-type': '2',
            'max-keys': '500',
            if (prefix.isNotEmpty) 'prefix': '$prefix/',
            'continuation-token': ?token,
          }),
        );
        for (final row in xml.rootElement.findElements('Contents')) {
          final key = row.getElement('Key')!.innerText;
          if (key.isEmpty || key.endsWith('/')) continue;
          final name = key.split('/').last;
          final date = row.getElement('LastModified')?.innerText ?? timestamp();
          final size =
              int.tryParse(row.getElement('Size')?.innerText ?? '') ?? 0;
          await cloud.query(
            'INSERT OR IGNORE INTO jr_files (id,library_id,object_key,name,mime_type,size_bytes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
            [
              _uuid.v4(),
              id,
              key,
              name,
              lookupMimeType(name) ?? 'application/octet-stream',
              size,
              date,
              date,
            ],
          );
          scanned++;
        }
        token = xml.rootElement.getElement('NextContinuationToken')?.innerText;
      } while (token != null && token.isNotEmpty);
    } finally {
      await invalidate();
    }
    return scanned;
  }
}
