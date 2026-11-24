import 'package:flutter_test/flutter_test.dart';
import 'package:jellyree_mobile/cloudflare.dart';
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
    final cursor = {'id': 'previous-id', 'created_at': '2021-09-17'};
    final result = query.select(81, cursor, 0);
    expect(result.sql, contains('mime_type LIKE \'audio/%\''));
    expect(result.sql, contains('created_at > ?'));
    expect(result.sql, contains('ORDER BY created_at ASC, id ASC'));
    expect(result.params, [
      'be62739bdc2cae3180afc54636a3ca5358d9f737cbe582d444e0172bec2183e3',
      input['timelineSince'],
      r'%\%a\_b%',
      r'%\%a\_b%',
      'зима',
      '2021-09-17',
      '2021-09-17',
      'previous-id',
      81,
      0,
    ]);
  });
}
