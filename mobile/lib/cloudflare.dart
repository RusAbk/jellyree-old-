import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:xml/xml.dart';

typedef Json = Map<String, dynamic>;

class CloudError implements Exception {
  const CloudError(this.message, [this.values = const {}]);
  final String message;
  final Map<String, Object?> values;
  @override
  String toString() => message;
}

class Connection {
  Connection(Json input)
    : values = {
        for (final key in fields) key: (input[key] as String? ?? '').trim(),
      } {
    for (final key in ['accountId', 'databaseId']) {
      values[key] = values[key]!.toLowerCase();
    }
    if (!RegExp(r'^[a-f0-9]{32}$').hasMatch(this['accountId'])) {
      throw const CloudError(
        'Account ID должен содержать 32 шестнадцатеричных символа.',
      );
    }
    if (!RegExp(r'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
        .hasMatch(this['databaseId'])) {
      throw const CloudError('Укажите UUID базы Cloudflare D1.');
    }
    if (!RegExp(r'^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$')
        .hasMatch(this['bucket'])) {
      throw const CloudError('Некорректное имя R2 bucket.');
    }
    values['prefix'] = this['prefix'].replaceAll(RegExp(r'^/+|/+$'), '');
    if (this['prefix'].split('/').any((part) => part == '..' || part == '.') ||
        this['prefix'].contains(RegExp(r'[\\\x00-\x1f]'))) {
      throw const CloudError('Некорректный префикс объектов.');
    }
    for (final key in secrets) {
      if (this[key].isEmpty) throw CloudError('Заполните {0}.', {'0': key});
    }
  }

  static const secrets = ['apiToken', 'accessKeyId', 'secretAccessKey'];
  static const fields = [
    'accountId',
    'databaseId',
    'bucket',
    'prefix',
    ...secrets,
  ];
  final Map<String, String> values;
  String operator [](String key) => values[key]!;
  String get libraryId => sha256
      .convert(
        utf8.encode(
          [this['accountId'], this['bucket'], this['prefix']].join('\u0000'),
        ),
      )
      .toString();
  String get namespace => sha256
      .convert(utf8.encode('$libraryId:${this['databaseId']}'))
      .toString();

  Json get public => {
    for (final key in fields)
      if (!secrets.contains(key)) key: this[key],
  };
}

String s3Encode(String text) => utf8.encode(text).map((byte) {
  final safe =
      (byte >= 65 && byte <= 90) ||
      (byte >= 97 && byte <= 122) ||
      (byte >= 48 && byte <= 57) ||
      [45, 46, 95, 126].contains(byte);
  return safe
      ? String.fromCharCode(byte)
      : '%${byte.toRadixString(16).toUpperCase().padLeft(2, '0')}';
}).join();

String s3Path(Iterable<String> parts) => '/${parts.map(s3Encode).join('/')}';

class Cloudflare {
  Cloudflare(this.config, {HttpClient? client, DateTime Function()? clock})
    : http =
          client ??
          (HttpClient()..connectionTimeout = const Duration(seconds: 15)),
      now = clock ?? DateTime.now;

  final Connection config;
  final HttpClient http;
  final DateTime Function() now;
  String get host => '${config['accountId']}.r2.cloudflarestorage.com';
  static const unsigned = 'UNSIGNED-PAYLOAD';

  Future<HttpClientRequest> _request(String method, Uri url) async {
    final request = await http
        .openUrl(method, url)
        .timeout(const Duration(seconds: 20));
    request.followRedirects = false;
    return request;
  }

  Future<List<Json>> query(
    String sql, [
    List<Object?> params = const [],
  ]) async {
    final request = await _request(
      'POST',
      Uri.https(
        'api.cloudflare.com',
        '/client/v4/accounts/${config['accountId']}/d1/database/${config['databaseId']}/query',
      ),
    );
    request.headers.set(
      HttpHeaders.authorizationHeader,
      'Bearer ${config['apiToken']}',
    );
    request.headers.contentType = ContentType.json;
    request.write(jsonEncode({'sql': sql, 'params': params}));
    final response = await request.close().timeout(const Duration(seconds: 60));
    final bytes = await boundedBytes(response, 32 << 20);
    Json? data;
    try {
      data = jsonDecode(utf8.decode(bytes)) as Json;
    } on FormatException {
      /* handled below */
    }
    final results = data?['result'];
    if (response.statusCode != 200 ||
        data?['success'] != true ||
        results is! List ||
        results.isEmpty ||
        (results.first as Json)['success'] != true) {
      // Errors can be returned to the renderer. Keep credentials in the native process.
      throw CloudError('Ошибка Cloudflare D1 (HTTP {0}).', {
        '0': response.statusCode,
      });
    }
    return ((results.first as Json)['results'] as List? ?? []).cast<Json>();
  }

  String _queryString(Map<String, String> query) {
    final entries =
        query.entries
            .map(
              (entry) => MapEntry(s3Encode(entry.key), s3Encode(entry.value)),
            )
            .toList()
          ..sort((a, b) => a.key.compareTo(b.key));
    return entries.map((entry) => '${entry.key}=${entry.value}').join('&');
  }

  ({String time, String scope, List<int> key}) _signingKey() {
    final time =
        "${now().toUtc().toIso8601String().split('.').first.replaceAll(RegExp(r'[:-]'), '')}Z";
    final day = time.substring(0, 8);
    final scope = '$day/auto/s3/aws4_request';
    List<int> key = utf8.encode('AWS4${config['secretAccessKey']}');
    for (final term in [day, 'auto', 's3', 'aws4_request']) {
      key = Hmac(sha256, key).convert(utf8.encode(term)).bytes;
    }
    return (time: time, scope: scope, key: key);
  }

  String _signature(
    String canonical,
    String time,
    String scope,
    List<int> key,
  ) {
    final hash = sha256.convert(utf8.encode(canonical));
    return Hmac(
      sha256,
      key,
    ).convert(utf8.encode('AWS4-HMAC-SHA256\n$time\n$scope\n$hash')).toString();
  }

  Uri presign(String objectKey, {int seconds = 3600}) {
    final path = s3Path([config['bucket'], ...objectKey.split('/')]);
    final auth = _signingKey();
    final params = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': "${config['accessKeyId']}/${auth.scope}",
      'X-Amz-Date': auth.time,
      'X-Amz-Expires': seconds.toString(),
      'X-Amz-SignedHeaders': 'host',
    };
    final query = _queryString(params);
    final canonical = 'GET\n$path\n$query\nhost:$host\n\nhost\n$unsigned';
    final signature = _signature(canonical, auth.time, auth.scope, auth.key);
    return Uri.parse('https://$host$path?$query&X-Amz-Signature=$signature');
  }

  Future<HttpClientResponse> object(
    String method, [
    String? key,
    Map<String, String> query = const {},
    Map<String, String> headers = const {},
    Stream<List<int>>? body,
    int length = 0,
  ]) async {
    final path = s3Path([config['bucket'], if (key != null) ...key.split('/')]);
    final queryString = _queryString(query);
    final auth = _signingKey();
    final fields = {
      'host': host,
      'x-amz-content-sha256': unsigned,
      'x-amz-date': auth.time,
      for (final entry in headers.entries)
        if (entry.key.startsWith('x-amz-')) entry.key: entry.value,
    };
    final names = fields.keys.toList()..sort();
    final normalized = names
        .map((name) => '$name:${fields[name]!.trim()}\n')
        .join();
    final signed = names.join(';');
    final canonical =
        '$method\n$path\n$queryString\n$normalized\n$signed\n$unsigned';
    final signature = _signature(canonical, auth.time, auth.scope, auth.key);
    final request = await _request(
      method,
      Uri.parse(
        'https://$host$path${queryString.isEmpty ? '' : '?$queryString'}',
      ),
    );
    request.headers.set(
      HttpHeaders.authorizationHeader,
      'AWS4-HMAC-SHA256 Credential=${config['accessKeyId']}/${auth.scope}, SignedHeaders=$signed, Signature=$signature',
    );
    fields.forEach(request.headers.set);
    headers.forEach(request.headers.set);
    if (body != null) {
      request.contentLength = length;
      try {
        await request.addStream(body.timeout(const Duration(seconds: 60)));
      } on Object {
        request.abort();
        rethrow;
      }
    } else if (method == 'PUT' || method == 'POST') {
      request.contentLength = 0;
    }
    final response = await request.close().timeout(const Duration(seconds: 60));
    if (response.statusCode < 200 || response.statusCode >= 300) {
      await response.drain<void>();
      throw CloudError('Ошибка Cloudflare R2 (HTTP {0}).', {
        '0': response.statusCode,
      });
    }
    return response;
  }

  Future<XmlDocument> xmlResponse(HttpClientResponse response) async {
    final bytes = await boundedBytes(response, 8 << 20);
    final xml = XmlDocument.parse(utf8.decode(bytes));
    if (xml.rootElement.name.local == 'Error') {
      throw const CloudError('Не удалось завершить операцию в R2.');
    }
    return xml;
  }

  Future<void> put(
    String key,
    File data,
    int length,
    String contentType,
    void Function(int) report,
  ) async {
    Stream<List<int>> chunks(int start, int end) async* {
      var sent = start;
      await for (final chunk in data.openRead(start, end)) {
        sent += chunk.length;
        report(sent);
        yield chunk;
      }
    }

    if (length <= 64 << 20) {
      final response = await object(
        'PUT',
        key,
        const {},
        {'content-type': contentType},
        chunks(0, length),
        length,
      );
      await response.drain<void>();
      return;
    }
    final init = await xmlResponse(
      await object('POST', key, {'uploads': ''}, {'content-type': contentType}),
    );
    final uploadId = init.rootElement.getElement('UploadId')!.innerText;
    final query = {'uploadId': uploadId};
    try {
      final size = ((length + 9999) ~/ 10000).clamp(16 << 20, 4 << 30);
      final parts = XmlBuilder()
        ..element('CompleteMultipartUpload', nest: () {});
      final document = parts.buildDocument();
      for (var start = 0, number = 1; start < length; start += size, number++) {
        final end = (start + size).clamp(0, length);
        final part = await object(
          'PUT',
          key,
          {...query, 'partNumber': '$number'},
          const {},
          chunks(start, end),
          end - start,
        );
        final tag = part.headers.value(HttpHeaders.etagHeader);
        await part.drain<void>();
        if (tag == null) {
          throw const CloudError('Не удалось завершить операцию в R2.');
        }
        document.rootElement.children.add(
          XmlElement(XmlName('Part'), [], [
            XmlElement(XmlName('PartNumber'), [], [XmlText('$number')]),
            XmlElement(XmlName('ETag'), [], [XmlText(tag)]),
          ]),
        );
      }
      final bytes = utf8.encode(document.toXmlString());
      await xmlResponse(
        await object(
          'POST',
          key,
          query,
          {'content-type': 'application/xml'},
          Stream.value(bytes),
          bytes.length,
        ),
      );
    } on Object {
      try {
        await (await object('DELETE', key, query)).drain<void>();
      } on Object {
        /* Keep original error. */
      }
      rethrow;
    }
  }

  Future<void> delete(String key) async =>
      (await object('DELETE', key)).drain<void>();
}

Future<Uint8List> boundedBytes(Stream<List<int>> stream, int limit) async {
  final builder = BytesBuilder(copy: false);
  await for (final chunk in stream.timeout(const Duration(seconds: 60))) {
    if (builder.length + chunk.length > limit) {
      throw const CloudError('Файл слишком большой.');
    }
    builder.add(chunk);
  }
  return builder.takeBytes();
}
