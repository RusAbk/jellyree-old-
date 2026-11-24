import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jellyree_mobile/host.dart';

class _AssetFixture extends CachingAssetBundle {
  @override
  Future<ByteData> load(String key) async {
    if (key != 'assets/ui/mobile.html') throw ArgumentError(key);
    return ByteData.sublistView(
      Uint8List.fromList(utf8.encode('<!doctype html><title>Jellyree</title>')),
    );
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('serves a private app origin and saves UI preferences without exposing credentials', () async {
    FlutterSecureStorage.setMockInitialValues({
      'jellyree-connections-v1': jsonEncode({
        'active': 'profile',
        'profiles': [
          {
            'id': 'profile',
            'name': 'Photos',
            'config': {
              'accountId': '11111111111111111111111111111111',
              'databaseId': '22222222-2222-2222-2222-222222222222',
              'bucket': 'photos',
              'prefix': 'jellyree',
              'apiToken': 'test-d1-secret',
              'accessKeyId': 'test-r2-id',
              'secretAccessKey': 'test-r2-secret',
            },
          },
        ],
      }),
    });
    final directory = await Directory.systemTemp.createTemp('jellyree-host-');
    addTearDown(() => directory.delete(recursive: true));
    final host = MobileHost(
      storageDirectory: directory,
      tempDirectory: directory,
      pick: (_) async => [],
      shareFiles: (_) async {},
      shareLink: (_) async {},
      assets: _AssetFixture(),
    );
    await host.start();
    addTearDown(host.close);
    expect(host.allows(host.uri), isTrue);
    expect(host.allows(Uri.https('example.com')), isFalse);

    await HttpOverrides.runWithHttpOverrides(() async {
      final client = HttpClient();
      addTearDown(() => client.close(force: true));
      Future<(int, String)> http(
        Uri uri, {
        List<Object?>? args,
        String? origin,
      }) async {
        final request = await client.openUrl(
          args == null ? 'GET' : 'POST',
          uri,
        );
        if (origin != null) request.headers.set('Origin', origin);
        if (args != null) request.write(jsonEncode(args));
        final response = await request.close();
        return (
          response.statusCode,
          await response.transform(utf8.decoder).join(),
        );
      }

      expect(await http(host.uri), (
        200,
        '<!doctype html><title>Jellyree</title>',
      ));
      expect((await http(host.uri.resolve('/'))).$1, 404);
      expect(
        (await http(
          host.uri.resolve('_rpc/settings.get'),
          args: [],
          origin: 'https://example.com',
        )).$1,
        403,
      );
      final settings = await http(
        host.uri.resolve('_rpc/settings.get'),
        args: [],
      );
      expect(settings.$2, contains('"name":"Photos"'));
      expect(settings.$2, isNot(contains('test-d1-secret')));
      expect(settings.$2, isNot(contains('test-r2-secret')));
      final prefs = host.uri.resolve('_rpc/setPreferences');
      expect(
        (await http(
          prefs,
          args: [
            {'jellyree-desktop-language': 'es', 'secretAccessKey': 'abc'},
          ],
        )).$1,
        200,
      );
      final saved = await http(host.uri.resolve('_rpc/preferences'), args: []);
      expect(jsonDecode(saved.$2)['value'], {
        'jellyree-desktop-language': 'es',
      });
    }, _RealHttp());
  });
}

class _RealHttp extends HttpOverrides {}
