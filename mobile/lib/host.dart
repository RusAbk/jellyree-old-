import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data' show BytesBuilder;

import 'package:crypto/crypto.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:mime/mime.dart';
import 'package:uuid/uuid.dart';

import 'cloudflare.dart';
import 'library.dart';

typedef Picked = ({File file, String name, List<String> folders});
typedef Picker = Future<List<Picked>> Function(bool folders);
typedef ShareFiles = Future<void> Function(List<String> files);
typedef ShareLink = Future<void> Function(String uri);
final _uuid = Uuid();
const _uploadConcurrency = 3;

class _Profile {
  _Profile(this.id, this.name, this.config);
  final String id, name;
  final Connection config;
  Json toJson() => {'id': id, 'name': name, 'config': config.values};
  Json get summary => {
    'id': id,
    'name': name,
    ...config.public,
    'persisted': true,
  };
}

class _Binary {
  _Binary(this.bytes, this.type, {this.kind});
  final Uint8List bytes;
  final String type;
  final String? kind;
}

class MobileHost {
  MobileHost({
    required this.storageDirectory,
    required this.tempDirectory,
    required this.pick,
    required this.shareFiles,
    required this.shareLink,
    this.onLocale,
    AssetBundle? assets,
    FlutterSecureStorage? storage,
  }) : assets = assets ?? rootBundle,
       storage = storage ?? const FlutterSecureStorage();

  final Directory storageDirectory, tempDirectory;
  final AssetBundle assets;
  final FlutterSecureStorage storage;
  final Picker pick;
  final ShareFiles shareFiles;
  final ShareLink shareLink;
  final void Function(String)? onLocale;
  final _profiles = <String, _Profile>{};
  final _media = <String, (MobileLibrary, Json)>{};
  final _previewReads = <String, Completer<void>>{};
  final _events = <HttpResponse>{};
  final _conflicts = <String, Completer<Json>>{};
  final _failed = <String, (MobileLibrary, Picked, String?)>{};
  final _thumbWrites = <Future<void>>{};
  Future<void> _profileWrites = Future.value();
  String? _active;
  String? _startupError;
  MobileLibrary? _library;
  late HttpServer _server;
  final _session = _uuid.v4();
  var _thumbnailEpoch = 0;
  var _mutations = 0;
  Future<void> _uploadQueue = Future.value();
  final _uploadFiles = <String, List<UploadCancellation>>{};
  bool _closing = false;
  bool _pruningThumbnails = false;
  final _prefs = <String, dynamic>{};
  static const maxThumbnails = 96 << 20;
  static const _assetRoot = 'assets/ui/';

  String get origin => 'http://127.0.0.1:${_server.port}';
  Uri get uri => Uri.parse('$origin/$_session/');
  Directory get _thumbs => Directory('${storageDirectory.path}/thumbnails');
  bool allows(Uri uri) =>
      uri.scheme == 'http' &&
      uri.host == '127.0.0.1' &&
      uri.port == _server.port &&
      uri.path == '/$_session/';

  Future<void> start() async {
    try {
      final payload = await storage.read(key: 'jellyree-connections-v1');
      if (payload != null) {
        final data = jsonDecode(payload) as Json;
        for (final entry in (data['profiles'] as List).cast<Json>()) {
          final profile = _Profile(
            entry['id'] as String,
            entry['name'] as String,
            Connection(entry['config'] as Json),
          );
          _profiles[profile.id] = profile;
        }
        _activate(data['active'] as String?);
      }
    } on Object {
      _startupError = 'Не удалось прочитать сохранённые подключения.';
    }
    try {
      _prefs.addAll(jsonDecode(await _prefFile.readAsString()) as Json);
    } on Object {
      /* Defaults. */
    }
    onLocale?.call(_prefs['jellyree-desktop-language'] as String? ?? 'en');
    _server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    _server.serverHeader = null;
    _server.listen((request) => unawaited(_serve(request)));
  }

  Future<void> close() async {
    if (_closing) return;
    _closing = true;
    for (final request in _previewReads.keys.toList()) {
      _cancelPreview(request);
    }
    for (final conflict in _conflicts.values) {
      if (!conflict.isCompleted) conflict.complete({'action': 'cancel'});
    }
    for (final sink in _events) {
      unawaited(sink.close());
    }
    await _server.close(force: true);
    _library?.cloud.http.close(force: true);
  }

  File get _prefFile => File('${storageDirectory.path}/ui-settings.json');
  Future<void> _writePreferences(Json updates) async {
    // The renderer sends a small allowlisted set of display preferences.
    for (final entry in updates.entries) {
      if (entry.key.startsWith('jellyree-desktop-') && entry.key.length < 80) {
        if (entry.value == null) {
          _prefs.remove(entry.key);
        }
        if (entry.value is String && (entry.value as String).length <= 120) {
          _prefs[entry.key] = entry.value;
        }
      }
    }
    await storageDirectory.create(recursive: true);
    await _prefFile.writeAsString(jsonEncode(_prefs), flush: true);
  }

  MobileLibrary get _current =>
      _library ??
      (throw const CloudError('Подключите хранилище в настройках.'));
  MobileLibrary _make(Connection connection) => MobileLibrary(
    Cloudflare(connection),
    Directory('${storageDirectory.path}/catalog/${connection.namespace}'),
  );
  void _activate(String? id) {
    final profile = _profiles[id];
    if (_active == profile?.id && _library != null) return;
    _active = profile?.id;
    _library?.cloud.http.close(force: true);
    _library = profile == null ? null : _make(profile.config);
    _media.clear();
    _failed.clear();
    _thumbnailEpoch++;
  }

  Json _settings() {
    final active = _profiles[_active];
    return {
      'configured': active != null,
      'persisted': active != null,
      if (active != null) ...{
        ...active.summary,
        'activeProfileId': active.id,
        'hasSecrets': true,
      },
      if (_startupError != null) 'startupError': _startupError,
      'profiles': _profiles.values.map((profile) => profile.summary).toList(),
    };
  }

  Future<void> _persist(Map<String, _Profile> profiles, String? active) async {
    await storage.write(
      key: 'jellyree-connections-v1',
      value: jsonEncode({
        'active': active,
        'profiles': profiles.values.map((profile) => profile.toJson()).toList(),
      }),
    );
    _profiles
      ..clear()
      ..addAll(profiles);
    _startupError = null;
  }

  Future<Json> _changingSettings(Future<Json> Function() operation) {
    final result = _profileWrites.then((_) {
      if (_mutations != 0) {
        throw const CloudError('Дождитесь окончания текущей операции.');
      }
      return operation();
    });
    _profileWrites = result.then((_) {}, onError: (Object _) {});
    return result;
  }

  Future<Json> _save(Json input, {bool test = false}) =>
      _changingSettings(() async {
        final old = _profiles[input['profileId']];
        final values = <String, dynamic>{...input};
        if (old != null) {
          for (final key in Connection.secrets) {
            if ((values[key] as String? ?? '').trim().isEmpty) {
              values[key] = old.config[key];
            }
          }
        }
        final connection = Connection(values);
        final candidate = _make(connection);
        try {
          await candidate.check();
          if (test) return {'ok': true};
          await candidate.initialize(
            await assets.loadString('${_assetRoot}jr-schema.sql'),
            (jsonDecode(
              await assets.loadString('${_assetRoot}jr-journal.json'),
            ) as List).cast<String>(),
          );
        } finally {
          candidate.cloud.http.close(force: true);
        }
        final name = cleanName(
          (input['name'] as String? ?? '').trim().isEmpty
              ? connection['bucket']
              : input['name'],
        );
        final id = old?.id ?? _uuid.v4();
        await _persist({..._profiles, id: _Profile(id, name, connection)}, id);
        // Saving an existing profile can change the credentials or storage endpoint.
        if (_active == id) _active = null;
        _activate(id);
        return _settings();
      });

  void _emit(String name, Json json) {
    final event = 'event: $name\ndata: ${jsonEncode(json)}\n\n';
    for (final sink in _events.toList()) {
      try {
        sink.write(event);
        unawaited(
          sink.flush().catchError((Object _) {
            _events.remove(sink);
          }),
        );
      } on Object {
        _events.remove(sink);
      }
    }
  }

  Future<void> _serve(HttpRequest request) async {
    final response = request.response;
    final segments = request.uri.pathSegments;
    try {
      response.headers.set('X-Content-Type-Options', 'nosniff');
      response.headers.set('Referrer-Policy', 'no-referrer');
      if (request.headers.value(HttpHeaders.hostHeader) !=
              '127.0.0.1:${_server.port}' ||
          segments.isEmpty ||
          segments.first != _session) {
        response.statusCode = 404;
        return;
      }
      final path = segments.skip(1).where((part) => part.isNotEmpty).toList();
      if (path.any(
        (part) =>
            part == '.' ||
            part == '..' ||
            part.contains('/') ||
            part.contains('\\'),
      )) {
        response.statusCode = 404;
        return;
      }
      if (path.length == 1 &&
          path.first == '_events' &&
          request.method == 'GET') {
        response.headers.contentType = ContentType(
          'text',
          'event-stream',
          charset: 'utf-8',
        );
        response.headers.set('Cache-Control', 'no-store');
        response.bufferOutput = false;
        _events.add(response);
        final ticker = Timer.periodic(const Duration(seconds: 15), (_) {
          try {
            response.write(': keep-alive\n\n');
          } on Object {
            _events.remove(response);
          }
        });
        try {
          response.write(': connected\n\n');
          await response.flush();
          await response.done;
        } finally {
          ticker.cancel();
          _events.remove(response);
        }
        return;
      }
      if (path.length == 2 &&
          path.first == '_rpc' &&
          request.method == 'POST') {
        response.headers.set('Cache-Control', 'no-store');
        final source = request.headers.value('Origin');
        if (source != null && source != origin) {
          response.statusCode = 403;
          return;
        }
        final metadata = request.headers.value('X-Jellyree-Args');
        late final List<dynamic> args;
        Uint8List? data;
        if (metadata == null) {
          args = jsonDecode(
            utf8.decode(await boundedBytes(request, 2 << 20)),
          ) as List;
        } else {
          args = jsonDecode(
            utf8.decode(base64Url.decode(base64Url.normalize(metadata))),
          ) as List;
          data = await boundedBytes(request, 64 << 20);
        }
        final result = await _dispatch(path.last, args, data);
        if (result is _Binary) {
          response.headers.set(HttpHeaders.contentTypeHeader, result.type);
          if (result.kind != null) {
            response.headers.set('X-Jellyree-Kind', result.kind!);
          }
          response.add(result.bytes);
        } else {
          response.headers.contentType = ContentType.json;
          response.write(jsonEncode({'ok': true, 'value': result}));
        }
        return;
      }
      if (path.length == 2 &&
          path.first == '_media' &&
          ['HEAD', 'GET'].contains(request.method)) {
        await _streamMedia(request, path.last);
        return;
      }
      if (request.method != 'GET' ||
          (path.isNotEmpty &&
              !['assets', 'pdfjs', 'licenses'].contains(path.first))) {
        response.statusCode = 404;
        return;
      }
      final name = path.isEmpty ? 'mobile.html' : path.join('/');
      final data = await assets.load('$_assetRoot$name');
      final mime = name.endsWith('.mjs')
          ? 'text/javascript'
          : lookupMimeType(name);
      response.headers.set(
        HttpHeaders.contentTypeHeader,
        mime ?? 'application/octet-stream',
      );
      response.add(
        data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
      );
    } on Object catch (error) {
      try {
        if (segments.length > 1 && segments[1] == '_rpc') {
          response.headers.contentType = ContentType.json;
          response.write(
            jsonEncode({
              'ok': false,
              'error': error is CloudError
                  ? error.message
                  : 'Не удалось выполнить операцию.',
              if (error is CloudError) 'values': error.values,
            }),
          );
        } else {
          response.statusCode = 404;
        }
      } on StateError {
        /* A disconnected media client no longer needs a response. */
      }
    } finally {
      try {
        await response.close();
      } on Object {
        /* Disconnection. */
      }
    }
  }

  String _mediaUrl(MobileLibrary library, Json file) {
    if (_media.length >= 1024) _media.remove(_media.keys.first);
    final key = _uuid.v4();
    _media[key] = (library, file);
    return uri.resolve('_media/$key').toString();
  }

  Future<void> _streamMedia(HttpRequest request, String id) async {
    final entry = _media[id];
    final response = request.response;
    if (entry == null) {
      response.statusCode = 404;
      return;
    }
    final (library, file) = entry;
    final range = request.headers.value(HttpHeaders.rangeHeader);
    final cloud = await library.cloud.object(
      request.method,
      file['object_key'] as String,
      const {},
      {
        if (range != null && RegExp(r'^bytes=\d*-\d*$').hasMatch(range))
          'range': range,
      },
    );
    response.statusCode = cloud.statusCode;
    // A user's uploaded object may be HTML/XML. Never let it execute as the app origin.
    response.headers.set(
      'Content-Security-Policy',
      "sandbox; default-src 'none'",
    );
    final type = mediaType(file);
    response.headers.set(
      HttpHeaders.contentTypeHeader,
      type.startsWith('image/') ||
              type.startsWith('video/') ||
              type.startsWith('audio/')
          ? type
          : 'application/octet-stream',
    );
    for (final header in [
      'accept-ranges',
      'content-length',
      'content-range',
      'etag',
      'last-modified',
    ]) {
      final value = cloud.headers.value(header);
      if (value != null) response.headers.set(header, value);
    }
    response.headers.set('Cache-Control', 'private, max-age=1800');
    if (request.method == 'HEAD') {
      await cloud.drain<void>();
    } else {
      await response.addStream(cloud.timeout(const Duration(seconds: 60)));
    }
  }

  Future<_Binary> _read(
    MobileLibrary lib,
    Json file,
    String type,
    int limit, {
    String? kind,
    String? requestId,
  }) async {
    if ((file['size_bytes'] as int) > limit) {
      throw const CloudError('Файл слишком большой.');
    }
    final cancelled = Completer<void>();
    if (requestId != null) {
      _cancelPreview(requestId);
      _previewReads[requestId] = cancelled;
    }
    try {
      final response = await lib.cloud.object(
        'GET',
        file['object_key'] as String,
      );
      if (requestId == null) {
        return _Binary(await boundedBytes(response, limit), type, kind: kind);
      }
      if (cancelled.isCompleted) {
        await response.listen((_) {}).cancel();
        throw const CloudError('Загрузка отменена.');
      }
      final input = StreamIterator(
        response.timeout(const Duration(seconds: 60)),
      );
      final bytes = BytesBuilder(copy: false);
      unawaited(
        cancelled.future.then((_) => input.cancel()).catchError((Object _) {}),
      );
      try {
        while (!cancelled.isCompleted && await input.moveNext()) {
          if (bytes.length + input.current.length > limit) {
            throw const CloudError('Файл слишком большой.');
          }
          bytes.add(input.current);
        }
        if (cancelled.isCompleted) {
          throw const CloudError('Загрузка отменена.');
        }
        return _Binary(bytes.takeBytes(), type, kind: kind);
      } finally {
        await input.cancel();
      }
    } finally {
      if (_previewReads[requestId] == cancelled) {
        _previewReads.remove(requestId);
      }
    }
  }

  void _cancelPreview(String id) {
    final pending = _previewReads.remove(id);
    if (pending != null && !pending.isCompleted) pending.complete();
  }

  String _thumbKey(Json revision) => sha256
      .convert(
        utf8.encode(jsonEncode([_current.cloud.config.namespace, revision])),
      )
      .toString();
  File _thumb(Json revision) =>
      File('${_thumbs.path}/${_thumbKey(revision)}.json');
  Future<Json?> _readThumb(Json revision, {bool touch = false}) async {
    try {
      final file = _thumb(revision);
      final json = jsonDecode(await file.readAsString()) as Json;
      if (touch) {
        unawaited(
          file.setLastModified(DateTime.now()).catchError((Object _) => file),
        );
      }
      return json;
    } on Object {
      return null;
    }
  }

  Future<Json> _thumbStats({bool prune = false}) async {
    if (!await _thumbs.exists()) {
      return {'count': 0, 'bytes': 0, 'maxBytes': maxThumbnails};
    }
    final entries = <(File, FileStat)>[];
    await for (final entry in _thumbs.list()) {
      if (entry is File && entry.path.endsWith('.json')) {
        entries.add((entry, await entry.stat()));
      }
    }
    var bytes = entries.fold(0, (total, entry) => total + entry.$2.size);
    var count = entries.length;
    if (prune && bytes > maxThumbnails) {
      entries.sort((a, b) => a.$2.modified.compareTo(b.$2.modified));
      for (final (file, stat) in entries) {
        if (bytes <= maxThumbnails) break;
        try {
          await file.delete();
          bytes -= stat.size;
          count--;
        } on FileSystemException {
          /* Already evicted. */
        }
      }
    }
    return {'count': count, 'bytes': bytes, 'maxBytes': maxThumbnails};
  }

  void _pruneSoon() {
    if (_pruningThumbnails) return;
    _pruningThumbnails = true;
    unawaited(
      _thumbStats(prune: true)
          .then((_) {}, onError: (Object _) {})
          .whenComplete(() {
            _pruningThumbnails = false;
          }),
    );
  }

  Future<bool> _putThumb(
    Json rev,
    Json entry,
    int epoch,
    Uint8List data,
  ) async {
    if (epoch != _thumbnailEpoch || data.length > 2 << 20) return false;
    final file = _thumb(rev);
    final temporary = File('${file.path}.${_uuid.v4()}.tmp');
    final write = () async {
      await _thumbs.create(recursive: true);
      try {
        await temporary.writeAsString(
          jsonEncode({...entry, 'bytes': base64Encode(data)}),
        );
        if (epoch == _thumbnailEpoch) await temporary.rename(file.path);
      } finally {
        if (await temporary.exists()) await temporary.delete();
      }
    }();
    _thumbWrites.add(write);
    try {
      await write;
    } finally {
      _thumbWrites.remove(write);
    }
    _pruneSoon();
    return epoch == _thumbnailEpoch;
  }

  Future<Json> _edited(
    MobileLibrary library,
    String id,
    String expected,
    Uint8List bytes,
    bool text,
  ) async {
    final file = await library.file(id, expected: expected, fresh: true);
    var name = file['name'] as String;
    final folder = file['folder_id'] as String?;
    final kind = documentKind(file);
    final original = mediaType(file);
    final String type;
    if (text) {
      if (!['text', 'markdown'].contains(kind) || bytes.length > 4 << 20) {
        throw const CloudError(
          'Для редактирования доступны текстовые файлы до 4 МБ.',
        );
      }
      try {
        utf8.decode(bytes);
      } on FormatException {
        throw const CloudError('Документ должен быть в кодировке UTF-8.');
      }
      type = kind == 'markdown' ? 'text/markdown' : 'text/plain';
    } else {
      if (!original.startsWith('image/') || isPxz(file) || bytes.isEmpty) {
        throw const CloudError('Выберите изображение.');
      }
      type = switch (original) {
        'image/jpeg' || 'image/jpg' => 'image/jpeg',
        'image/webp' => 'image/webp',
        _ => 'image/png',
      };
      if (!_validImage(bytes, type)) {
        throw const CloudError(
          'Не удалось закодировать изображение для сохранения.',
        );
      }
      if (type == 'image/png' && original != type) {
        final dot = name.lastIndexOf('.');
        name = await library.availableName(
          folder,
          '${dot > 0 ? name.substring(0, dot) : name}.png',
        );
      }
    }
    final local = await _tempFile('save', name);
    try {
      await local.writeAsBytes(bytes);
      final result = await library.write(
        local,
        name,
        folder,
        mimeType: type,
        replace: file,
        preserveCaptureDate: !text,
      );
      return {
        'file': result.file,
        if (result.warning != null)
          'warning': {
            'key': 'Файл {0} заменён, но предыдущий объект не удалось удалить из R2.',
            'values': {'0': result.warning},
          },
      };
    } finally {
      await local.parent.delete(recursive: true);
    }
  }

  bool _validImage(Uint8List bytes, String type) {
    if (bytes.length < 16) return false;
    final view = ByteData.sublistView(bytes);
    return switch (type) {
      'image/jpeg' =>
        view.getUint16(0) == 0xffd8 &&
            view.getUint16(bytes.length - 2) == 0xffd9,
      'image/webp' =>
        view.getUint32(0) == 0x52494646 && view.getUint32(8) == 0x57454250,
      'image/png' =>
        view.getUint32(0) == 0x89504e47 && view.getUint32(4) == 0x0d0a1a0a,
      _ => false,
    };
  }

  Future<File> _tempFile(String prefix, String name) async {
    await tempDirectory.create(recursive: true);
    final dir = await tempDirectory.createTemp('jellyree-$prefix-');
    return File('${dir.path}/${cleanName(name)}');
  }

  Future<Json> _queueUpload(
    MobileLibrary library,
    List<Picked> picked,
    String? root,
    String job, {
    List<String?>? roots,
  }) {
    if (_uploadFiles.containsKey(job)) {
      throw const CloudError('Дождитесь завершения текущих операций.');
    }
    final controls = [for (final _ in picked) UploadCancellation()];
    _uploadFiles[job] = controls;
    final prepared = () async {
      final sizes = <int>[];
      for (final item in picked) {
        sizes.add(await item.file.length().catchError((Object _) => 0));
      }
      _emit('progress', {
        'kind': 'upload',
        'jobId': job,
        'phase': 'queued',
        'done': 0,
        'total': picked.length,
        'totalBytes': sizes.fold<int>(0, (sum, size) => sum + size),
        'queuedFiles': [
          for (final (index, item) in picked.indexed)
            {
              'fileIndex': index,
              'name': item.name,
              'sizeBytes': sizes[index],
              if (item.folders.isNotEmpty) 'targetPath': item.folders.join('/'),
            },
        ],
      });
      return sizes;
    }();
    final result = _uploadQueue
        .then(
          (_) async => _upload(
            library,
            picked,
            root,
            job,
            controls,
            await prepared,
            roots: roots,
          ),
        )
        .whenComplete(() => _uploadFiles.remove(job));
    _uploadQueue = result.then((_) {}, onError: (Object _) {});
    return result;
  }

  Future<Json> _upload(
    MobileLibrary library,
    List<Picked> picked,
    String? root,
    String job,
    List<UploadCancellation> controls,
    List<int> sizes, {
    List<String?>? roots,
  }) async {
    final paths = <(String?, String), String>{};
    final active = <(String?, String), Future<void>>{};
    String? target(int index) => roots == null ? root : roots[index];
    List<Json>? folders;
    Future<String?> resolveFolder(int index) async {
      final item = picked[index];
      final root = target(index);
      var folder = root;
      var partial = '';
      for (final segment in item.folders) {
        final next = '$partial/${cleanName(segment)}';
        final key = (root, next);
        final cached = paths[key];
        if (cached != null) {
          folder = cached;
        } else {
          folders ??= await library.folders();
          final existing = folders!
              .where(
                (entry) =>
                    entry['parent_id'] == folder && entry['name'] == segment,
              )
              .firstOrNull;
          final entry = existing ?? await library.createFolder(segment, folder);
          if (existing == null) folders!.add(entry);
          paths[key] = folder = entry['id'] as String;
        }
        partial = next;
      }
      return folder;
    }

    Future<int> remainingConflicts(int index) async {
      final unique = <String?, Set<String>>{};
      final candidates = <(String?, String)>[];
      for (var i = index; i < picked.length; i++) {
        if (controls[i].canceled) continue;
        try {
          final folder = await resolveFolder(i);
          final name = cleanName(picked[i].name);
          (unique[folder] ??= {}).add(name);
          candidates.add((folder, name));
        } on CloudError {
          /* This entry will be reported separately. */
        }
      }
      final known = {
        for (final entry in unique.entries)
          entry.key: await library.existingNames(entry.key, entry.value),
      };
      for (final (folder, name) in active.keys) {
        known[folder]?.add(name);
      }
      return candidates
          .where((entry) => !known[entry.$1]!.add(entry.$2))
          .length
          .clamp(1, candidates.length.clamp(1, 1000000));
    }

    final failures = <Json>[];
    final warnings = <Json>[];
    final canceledFiles = <int>[];
    var done = 0, skipped = 0, processed = 0;
    var bytesCompleted = 0;
    final fileProgress = <int, int>{};
    final totalBytes = sizes.fold<int>(0, (sum, size) => sum + size);
    var canceled = false;
    String? applyToAll;
    for (final (index, item) in picked.indexed) {
      if (active.length >= _uploadConcurrency) {
        await Future.any(active.values);
      }
      final control = controls[index];
      var size = sizes[index];
      var name = item.name;
      final targetPath = [...item.folders, name].join('/');
      void progress(String state, int? loaded) {
        _emit('progress', {
          'kind': 'upload',
          'jobId': job,
          'phase': 'uploading',
          'fileIndex': index,
          'fileState': state,
          'name': name,
          'done': processed,
          'total': picked.length,
          'loaded': fileProgress.values.fold<int>(
            bytesCompleted,
            (sum, bytes) => sum + bytes,
          ),
          'fileLoaded': ?loaded,
          'sizeBytes': size,
          'totalBytes': totalBytes,
          'targetPath': targetPath,
        });
      }

      void finish(String state) {
        control.finish();
        fileProgress.remove(index);
        bytesCompleted += sizes[index];
        processed++;
        progress(state, null);
      }

      void fail(Object error) {
        if (control.canceled) {
          canceledFiles.add(index);
          if (error is! UploadCanceled) {
            warnings.add({'key': 'Не удалось завершить операцию в R2.'});
          }
          finish('canceled');
          return;
        }
        final id = _uuid.v4();
        _failed[id] = (library, item, target(index));
        failures.add({
          'name': name,
          'retryId': id,
          'fileIndex': index,
          'sizeBytes': size,
          'targetPath': targetPath,
          'message': error is CloudError
              ? {'key': error.message, 'values': error.values}
              : {'key': 'Не удалось выполнить операцию.'},
        });
        finish('failed');
      }

      try {
        control.check();
        size = await item.file.length();
        final folder = await resolveFolder(index);
        // A preceding transfer may still be creating this destination.
        final preceding = active[(folder, name)];
        if (preceding != null) await preceding;
        control.check();
        final matches = await library.named(folder, name);
        control.check();
        Json? replace;
        if (matches.isNotEmpty) {
          Set<String> reserved() => {
            for (final (parent, name) in active.keys)
              if (parent == folder) name,
          };
          final suggested = await library.availableName(
            folder,
            name,
            start: 1,
            reserved: reserved(),
          );
          final Json answer;
          if (applyToAll == null) {
            final id = _uuid.v4();
            final count = await remainingConflicts(index);
            control.check();
            final pending = Completer<Json>();
            _conflicts[id] = pending;
            final detach = control.onCancel(() {
              if (!pending.isCompleted) pending.complete({'action': 'cancel'});
            });
            _emit('conflict', {
              'id': id,
              'jobId': job,
              'fileIndex': index,
              'name': name,
              'targetPath': targetPath,
              'suggestedName': suggested,
              'remaining': count,
              'total': picked.length,
              'incomingBytes': size,
              'existingCount': matches.length,
              'existing': {
                'name': matches.first['name'],
                'sizeBytes': matches.first['size_bytes'],
                'updatedAt': matches.first['updated_at'],
              },
            });
            try {
              answer = await pending.future;
              control.check();
            } finally {
              detach();
              _conflicts.remove(id);
            }
          } else {
            answer = {'action': applyToAll};
          }
          final action = answer['action'] as String;
          if (answer['applyToAll'] == true) applyToAll = action;
          if (action == 'cancel') {
            canceled = true;
            finish('canceled');
            break;
          }
          if (action == 'skip') {
            skipped++;
            finish('skipped');
            continue;
          }
          if (action == 'replace') {
            replace = matches.first;
          }
          if (action == 'rename') {
            name = cleanName(answer['name'] ?? suggested);
            final names = reserved();
            if (names.contains(name) ||
                (await library.named(folder, name)).isNotEmpty) {
              name = await library.availableName(
                folder,
                name,
                start: 1,
                reserved: names,
              );
            }
          }
        }
        control.check();
        final destination = (folder, name);
        void reportFile(String state, int loaded) {
          fileProgress[index] = loaded.clamp(
            fileProgress[index] ?? 0,
            sizes[index],
          );
          progress(state, loaded);
        }

        Future<void> transfer() async {
          try {
            reportFile('uploading', 0);
            var lastReport = 0;
            final result = await library.write(
              item.file,
              name,
              folder,
              mimeType: lookupMimeType(item.name),
              replace: replace,
              cancellation: control,
              onCommit: () => reportFile('committing', size),
              report: (loaded) {
                final now = DateTime.now().millisecondsSinceEpoch;
                if (now - lastReport > 120 || loaded == size) {
                  lastReport = now;
                  reportFile('uploading', loaded);
                }
              },
            );
            if (result.warning != null) {
              warnings.add({
                'key': 'Файл {0} заменён, но предыдущий объект не удалось удалить из R2.',
                'values': {'0': result.warning},
              });
            }
            done++;
            finish('uploaded');
          } on Object catch (error) {
            fail(error);
          } finally {
            active.remove(destination);
          }
        }

        active[destination] = transfer();
      } on Object catch (error) {
        fail(error);
      }
    }
    await Future.wait(active.values);
    failures.sort(
      (a, b) => (a['fileIndex'] as int).compareTo(b['fileIndex'] as int),
    );
    canceledFiles.sort();
    return {
      'done': done,
      'skipped': skipped,
      'canceled': canceled,
      if (canceledFiles.isNotEmpty) 'canceledFiles': canceledFiles,
      'failures': failures,
      'warnings': warnings,
    };
  }

  Future<T> _mutation<T>(Future<T> Function() task) async {
    await _profileWrites;
    _mutations++;
    try {
      return await task();
    } finally {
      _mutations--;
    }
  }

  Future<Object?> _dispatch(
    String action,
    List<dynamic> a,
    Uint8List? data,
  ) async {
    switch (action) {
      case 'preferences':
        return _prefs;
      case 'setPreferences':
        await _writePreferences(a[0] as Json);
        return null;
      case 'setLocale':
        if (['en', 'ru', 'es'].contains(a.firstOrNull)) {
          onLocale?.call(a[0] as String);
        }
        return null;
      case 'setDocumentDraft':
        return null;
      case 'cancelPreview':
        _cancelPreview(a[0] as String);
        return null;
      case 'cancelUpload':
        final files = _uploadFiles[a[0] as String];
        final index = a[1] as int;
        return files != null &&
            index >= 0 &&
            index < files.length &&
            files[index].cancel();
      case 'settings.get':
        return _settings();
      case 'settings.test':
        return _save(a[0] as Json, test: true);
      case 'settings.save':
        return _save(a[0] as Json);
      case 'settings.select':
        return _changingSettings(() async {
          final id = a[0] as String;
          if (!_profiles.containsKey(id)) {
            throw const CloudError('Подключение не найдено.');
          }
          await _persist({..._profiles}, id);
          _activate(id);
          return _settings();
        });
      case 'settings.clear':
        return _changingSettings(() async {
          final id = a.firstOrNull as String? ?? _active;
          final remaining = {..._profiles};
          final removed = remaining.remove(id);
          final next = _active == id ? remaining.keys.firstOrNull : _active;
          await _persist(remaining, next);
          _activate(next);
          if (removed != null &&
              !_profiles.values.any(
                (p) => p.config.namespace == removed.config.namespace,
              )) {
            final removedLibrary = _make(removed.config);
            await removedLibrary.purgeCache();
            removedLibrary.cloud.http.close(force: true);
          }
          return _settings();
        });
      case 'thumb.stats':
        return _thumbStats();
      case 'thumb.clear':
        _thumbnailEpoch++;
        await Future.wait(
          _thumbWrites.toList().map((write) => write.catchError((Object _) {})),
        );
        if (await _thumbs.exists()) await _thumbs.delete(recursive: true);
        return _thumbStats();
      case 'releaseMedia':
        final key = Uri.tryParse(a[0] as String)?.pathSegments.lastOrNull;
        return key != null && _media.remove(key) != null;
      case 'answerUploadConflict':
        final answer = a[0] as Json;
        final pending = _conflicts[answer['id']];
        if (pending == null || pending.isCompleted) return false;
        if (answer['action'] == 'rename' && answer['name'] != null) {
          cleanName(answer['name']);
        }
        pending.complete(answer);
        return true;
    }
    final library = _current;
    switch (action) {
      case 'list':
        return library.list(a[0] as Json);
      case 'timelineBounds':
        return library.timelineBounds(a.firstOrNull);
      case 'listFileNotes':
        return library.notes.list(a[0] as String);
      case 'folders':
        return library.folders();
      case 'stats':
        return library.stats();
      case 'url':
        return _mediaUrl(library, await library.file(a[0] as String));
      case 'videoSource' || 'thumb.source':
        final rev = a[0] as Json;
        return _mediaUrl(
          library,
          await library.file(
            rev['id'] as String,
            expected: rev['objectKey'] as String,
          ),
        );
      case 'thumb.get':
        return {
          'epoch': _thumbnailEpoch,
          'entry': await _readThumb(a[0] as Json, touch: true),
        };
      case 'thumb.dimensions':
        return Future.wait(
          (a[0] as List).cast<Json>().map((rev) async {
            final found = await _readThumb(rev);
            return found == null
                ? null
                : {'width': found['width'], 'height': found['height']};
          }),
        );
      case 'thumb.put':
        return _putThumb(a[0] as Json, a[1] as Json, a[2] as int, data!);
      case 'imageSource':
        final expected = (a[2] as Json?)?['objectKey'] as String?;
        final file = await library.file(a[0] as String, expected: expected);
        return _read(
          library,
          file,
          mediaType(file),
          isPxz(file) ? 128 << 20 : 64 << 20,
          requestId: a[1] as String?,
        );
      case 'documentSource':
        final file = await library.file(
          a[0] as String,
          expected: a[1] as String,
        );
        final kind = documentKind(file);
        if (kind == null) {
          throw const CloudError(
            'Встроенный просмотр доступен для PDF, TXT и Markdown.',
          );
        }
        return _read(
          library,
          file,
          'application/octet-stream',
          kind == 'pdf' ? 64 << 20 : 4 << 20,
          kind: kind,
        );
      case 'share':
        final file = await library.file(a[0] as String);
        final url = library.cloud
            .presign(file['object_key'] as String)
            .toString();
        await Clipboard.setData(ClipboardData(text: url));
        await shareLink(url);
        return {'expiresIn': 3600};
      case 'download':
        final ids = (a[0] as List).cast<String>();
        library.validateIds(ids);
        final files = <String>[];
        for (final id in ids) {
          final file = await library.file(id);
          final local = await _tempFile('share', file['name'] as String);
          final response = await library.cloud.object(
            'GET',
            file['object_key'] as String,
          );
          await response
              .timeout(const Duration(seconds: 60))
              .pipe(local.openWrite());
          files.add(local.path);
        }
        await shareFiles(files);
        return {'done': files.length};
      case 'exportImage' || 'downloadVideoFrame':
        final file = await library.file(
          a[0] as String,
          expected: action == 'downloadVideoFrame' ? a[1] as String : null,
        );
        final name = file['name'] as String;
        final dot = name.lastIndexOf('.');
        final suffix = action == 'exportImage' ? a[1] as String : 'png';
        if (!['png', 'jpeg', 'webp'].contains(suffix) ||
            !_validImage(data!, 'image/$suffix')) {
          throw const CloudError('Некорректное изображение для экспорта.');
        }
        final local = await _tempFile(
          'share',
          '${dot > 0 ? name.substring(0, dot) : name}-edited.$suffix',
        );
        await local.writeAsBytes(data);
        await shareFiles([local.path]);
        return {'saved': true};
    }
    return _mutation<Object?>(() async {
      switch (action) {
        case 'update':
          await library.update((a[0] as List).cast<String>(), a[1] as Json);
          return null;
        case 'setCaptureDates':
          await library.setCaptureDates((a[0] as List).cast<Json>());
          return null;
        case 'saveFileNote':
          return library.notes.save(a[0] as String, a[1] as Json);
        case 'deleteFileNote':
          await library.notes.remove(
            a[0] as String,
            a[1] as String,
            a[2] as int,
          );
          return null;
        case 'remove':
          return library.remove((a[0] as List).cast<String>());
        case 'emptyTrash':
          return library.emptyTrash();
        case 'createFolder':
          return library.createFolder(a[0] as String, a[1] as String?);
        case 'updateFolder':
          return library.updateFolder(a[0] as String, a[1] as Json);
        case 'deleteFolder':
          await library.deleteFolder(a[0] as String);
          return null;
        case 'duplicatePhoto':
          return library.duplicate(a[0] as String, a[1] as String);
        case 'importBucket':
          return {'scanned': await library.importBucket()};
        case 'saveTextDocument' || 'saveEditedImage':
          return _edited(
            library,
            a[0] as String,
            a[1] as String,
            data!,
            action == 'saveTextDocument',
          );
        case 'saveVideoFrame':
          final file = await library.file(
            a[0] as String,
            expected: a[1] as String,
          );
          if (!mediaType(file).startsWith('video/') ||
              !_validImage(data!, 'image/png')) {
            throw const CloudError('Некорректный стопкадр видео.');
          }
          final name = file['name'] as String;
          final dot = name.lastIndexOf('.');
          final folder = file['folder_id'] as String?;
          final frame = await library.availableName(
            folder,
            '${dot > 0 ? name.substring(0, dot) : name}-frame-${(a[2] as num).toStringAsFixed(2)}.png',
          );
          final local = await _tempFile('frame', frame);
          try {
            await local.writeAsBytes(data);
            return (await library.write(
              local,
              frame,
              folder,
              mimeType: 'image/png',
            )).file;
          } finally {
            await local.parent.delete(recursive: true);
          }
        case 'pickUpload':
          final picked = await pick(a[1] == true);
          return _queueUpload(library, picked, a[0] as String?, a[2] as String);
        case 'retryUpload':
          final ids = (a[0] as List).cast<String>();
          final entries = [
            for (final id in ids)
              if (_failed[id] case final entry?) (id, entry),
          ];
          final items = entries
              .where((entry) => identical(entry.$2.$1, library))
              .toList();
          if (items.isEmpty) return {'done': 0, 'failures': []};
          final result = await _queueUpload(
            library,
            items.map((entry) => entry.$2.$2).toList(),
            null,
            a[1] as String,
            roots: items.map((entry) => entry.$2.$3).toList(),
          );
          final canceled =
              result.remove('canceledFiles') as List<int>? ?? const [];
          if (result['canceled'] != true) {
            final resolved = [
              for (final (index, entry) in items.indexed)
                if (!canceled.contains(index)) entry,
            ];
            for (final entry in resolved) {
              _failed.remove(entry.$1);
            }
            result['resolvedRetryIds'] = resolved
                .map((entry) => entry.$1)
                .toList();
          }
          return result;
        default:
          throw const CloudError('Не удалось выполнить операцию.');
      }
    });
  }
}
