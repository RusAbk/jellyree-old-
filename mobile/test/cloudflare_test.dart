import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jellyree_mobile/capture_date.dart';
import 'package:jellyree_mobile/cloudflare.dart';
import 'package:jellyree_mobile/file_notes.dart';
import 'package:jellyree_mobile/library.dart';

Connection profile() => Connection({
  'accountId': '11111111111111111111111111111111',
  'databaseId': '22222222-2222-2222-2222-222222222222',
  'bucket': 'photos',
  'prefix': 'jellyree',
  'apiToken': 'fake-d1-token',
  'accessKeyId': 'fake-r2-id',
  'secretAccessKey': 'fake-r2-key',
});

void main() {
  test(
    'Note length counts visible Unicode characters independently of marks',
    () {
      Json formatted(String value) => {
        'type': 'doc',
        'content': [
          {
            'type': 'paragraph',
            'content': [
              {
                'type': 'text',
                'text': value,
                'marks': [
                  {'type': 'bold'},
                  {'type': 'underline'},
                ],
              },
            ],
          },
        ],
      };
      expect(normalizeNote(formatted('🌅' * 500)), formatted('🌅' * 500));
      expect(
        () => normalizeNote(formatted('🌅' * 501)),
        throwsA(isA<CloudError>()),
      );
      expect(() => normalizeNote(formatted('   ')), throwsA(isA<CloudError>()));
    },
  );

  test('individual cancellation stops an active request but cannot interrupt commit', () {
    final active = UploadCancellation();
    final next = UploadCancellation();
    var aborted = 0;
    final detach = active.onCancel(() => aborted++);
    expect(active.cancel(), isTrue);
    expect(active.cancel(), isFalse);
    expect(aborted, 1);
    expect(active.check, throwsA(isA<UploadCanceled>()));
    detach();
    next.commit();
    expect(next.cancel(), isFalse);
    expect(next.canceled, isFalse);
  });

  test(
    'R2 batch deletion checksums XML and distinguishes rejected keys',
    () async {
      final cloud = _BatchR2();
      addTearDown(() => cloud.http.close(force: true));
      final result = await cloud.deleteBatch(['folder/a & b', 'denied']);
      expect(result.removed, {'folder/a & b'});
      expect(result.rejected, {'denied'});
    },
  );

  test('compatible with the desktop library hash and R2 canonical paths', () {
    final connection = profile();
    expect(
      connection.libraryId,
      'be62739bdc2cae3180afc54636a3ca5358d9f737cbe582d444e0172bec2183e3',
    );
    expect(
      s3Path(['photos', 'a +!#.jpg', 'море.jpg']),
      '/photos/a%20%2B%21%23.jpg/%D0%BC%D0%BE%D1%80%D0%B5.jpg',
    );
    expect(connection.public.keys, isNot(contains('apiToken')));
    final cloud = Cloudflare(
      connection,
      clock: () => DateTime.utc(2026, 11, 25, 12, 0),
    );
    addTearDown(() => cloud.http.close(force: true));
    final url = cloud.presign('a +!#.jpg');
    expect(
      url.host,
      '11111111111111111111111111111111.r2.cloudflarestorage.com',
    );
    expect(
      url.queryParameters['X-Amz-Credential'],
      'fake-r2-id/20261125/auto/s3/aws4_request',
    );
    expect(url.queryParameters['X-Amz-Date'], '20261125T120000Z');
    expect(
      url.queryParameters['X-Amz-Signature'],
      '6bcd3e78915ed46156106edbc9da494cd182ceb92bc9ed49aa12a3bcfda86199',
    );
  });

  test('timeline windows and literal names use bound parameters; pages resume from a cursor', () {
    final input = {
      'section': 'timeline',
      'timelineSince': '2021-09-01T00:00:00.000Z',
      'search': '%a_b',
      'tag': 'зима',
    };
    final query = ListingQuery(input, profile().libraryId);
    final cursor = {
      'id': 'previous-id',
      'captured_at': '2021-09-17',
      'created_at': '2026-11-25',
    };
    final result = query.select(81, cursor, 0);
    expect(result.sql, contains('mime_type LIKE \'audio/%\''));
    expect(result.sql, contains('$mediaDateColumn >= ?'));
    expect(result.sql, contains('($mediaDateColumn, id) > (?, ?)'));
    expect(result.sql, contains('ORDER BY $mediaDateColumn ASC, id ASC'));
    expect(result.params, [
      'be62739bdc2cae3180afc54636a3ca5358d9f737cbe582d444e0172bec2183e3',
      input['timelineSince'],
      r'%\%a\_b%',
      r'%\%a\_b%',
      'зима',
      '2021-09-17',
      'previous-id',
      81,
      0,
    ]);
    expect(
      query.select(81, {...cursor, 'captured_at': null}, 0).params[5],
      '2026-11-25',
    );
    expect(ListingQuery({'section': 'drive'}, 'library').column, 'created_at');
    expect(
      ListingQuery({'section': 'photos'}, 'library').column,
      mediaDateColumn,
    );
  });

  test('media filters use distinct cached queries and keep the timeline date window', () {
    for (final section in ['timeline', 'photos']) {
      final base = {
        'section': section,
        'timelineSince': '2021-09-01T00:00:00.000Z',
      };
      final all = ListingQuery(base, 'library');
      final photos = ListingQuery({...base, 'mediaKind': 'photo'}, 'library');
      final videos = ListingQuery({...base, 'mediaKind': 'video'}, 'library');
      expect({all.cacheKey, photos.cacheKey, videos.cacheKey}, hasLength(3));
      expect(photos.base, contains("mime_type LIKE 'image/%'"));
      expect(photos.base, contains("%.heic"));
      expect(photos.base, isNot(contains("video/%")));
      expect(videos.base, contains("mime_type LIKE 'video/%'"));
      expect(videos.base, isNot(contains("image/%")));
      if (section == 'timeline') {
        expect(all.base, contains("audio/%"));
        expect(videos.base, contains('$mediaDateColumn >= ?'));
      } else {
        expect(all.base, contains("image/%"));
      }
    }
    final drive = ListingQuery({
      'section': 'drive',
      'mediaKind': 'video',
    }, 'library');
    expect(drive.mediaKind, 'all');
    expect(drive.base, isNot(contains("video/%")));
  });

  test(
    'photo and video metadata use the most reliable recording date',
    () async {
      const fixtures = '../desktop/test/fixtures';
      final examples = jsonDecode(
        await File('$fixtures/media-dates.json').readAsString(),
      ) as List<dynamic>;
      for (final example in examples.cast<List<Object?>>()) {
        final name = example[0] as String;
        final type = example[1] as String;
        expect(
          await readCaptureDate(File('$fixtures/$name'), type),
          example[2],
          reason: name,
        );
      }
    },
  );
}

class _BatchR2 extends Cloudflare {
  _BatchR2() : super(profile());

  @override
  Future<HttpClientResponse> object(
    String method, [
    String? key,
    Map<String, String> query = const {},
    Map<String, String> headers = const {},
    Stream<List<int>>? body,
    int length = 0,
    UploadCancellation? cancellation,
  ]) async {
    expect(method, 'POST');
    expect(key, isNull);
    expect(query, {'delete': ''});
    final bytes = (await body!.toList()).expand((chunk) => chunk).toList();
    expect(bytes.length, length);
    expect(utf8.decode(bytes), contains('<Key>folder/a &amp; b</Key>'));
    expect(headers['content-md5'], base64.encode(md5.convert(bytes).bytes));
    return _R2Response(
      '<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
      '<Deleted><Key>folder/a &amp; b</Key></Deleted>'
      '<Error><Key>denied</Key><Code>AccessDenied</Code></Error>'
      '</DeleteResult>',
    );
  }
}

class _R2Response extends Stream<List<int>> implements HttpClientResponse {
  _R2Response(String xml) : _body = Stream.value(utf8.encode(xml));
  final Stream<List<int>> _body;

  @override
  StreamSubscription<List<int>> listen(
    void Function(List<int>)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) => _body.listen(
    onData,
    onError: onError,
    onDone: onDone,
    cancelOnError: cancelOnError,
  );

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
