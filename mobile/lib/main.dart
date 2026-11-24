import 'dart:async';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
// Keep the platform UI imports compatible with stable Flutter releases.
// ignore: deprecated_member_use
import 'package:flutter/cupertino.dart';
// ignore: deprecated_member_use
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_wkwebview/webview_flutter_wkwebview.dart';

import 'host.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const JellyreeMobile());
}

class JellyreeMobile extends StatelessWidget {
  const JellyreeMobile({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Jellyree',
    debugShowCheckedModeBanner: false,
    theme: ThemeData(
      colorSchemeSeed: const Color(0xFF7362DF),
      brightness: Brightness.light,
    ),
    home: const _DriveScreen(),
  );
}

class _DriveScreen extends StatefulWidget {
  const _DriveScreen();
  @override
  State<_DriveScreen> createState() => _DriveScreenState();
}

class _DriveScreenState extends State<_DriveScreen> {
  static const _systemFolders = MethodChannel('app.jellyree.mobile/folders');
  MobileHost? _host;
  WebViewController? _view;
  String? _error;
  String _language = 'en';
  bool _loaded = false;

  String _text(String en, String ru, String es) => switch (_language) {
    'ru' => ru,
    'es' => es,
    _ => en,
  };

  @override
  void initState() {
    super.initState();
    unawaited(_start());
  }

  Future<void> _start() async {
    if (mounted) {
      setState(() {
        _error = null;
        _loaded = false;
      });
    }
    try {
      final documents = await getApplicationSupportDirectory();
      final temp = await getTemporaryDirectory();
      final host = MobileHost(
        storageDirectory: Directory('${documents.path}/jellyree'),
        tempDirectory: Directory('${temp.path}/jellyree'),
        pick: _pick,
        shareFiles: _shareFiles,
        shareLink: _shareLink,
        onLocale: (language) => _language = language,
      );
      await host.start();
      if (!mounted) {
        await host.close();
        return;
      }
      _host = host;
      final params = WebViewPlatform.instance is WebKitWebViewPlatform
          ? WebKitWebViewControllerCreationParams(
              allowsInlineMediaPlayback: true,
              mediaTypesRequiringUserAction: const {},
            )
          : const PlatformWebViewControllerCreationParams();
      final controller = WebViewController.fromPlatformCreationParams(params);
      await controller.setJavaScriptMode(JavaScriptMode.unrestricted);
      await controller.setBackgroundColor(const Color(0xFFF8F8FC));
      await controller.setNavigationDelegate(
        NavigationDelegate(
          onNavigationRequest: (request) => host.allows(Uri.parse(request.url))
              ? NavigationDecision.navigate
              : NavigationDecision.prevent,
          onPageFinished: (_) {
            if (mounted) setState(() => _loaded = true);
          },
          onWebResourceError: (error) {
            if (error.isForMainFrame == true && mounted) {
              setState(
                () => _error = _text(
                  'Could not open Jellyree.',
                  'Не удалось открыть Jellyree.',
                  'No se pudo abrir Jellyree.',
                ),
              );
            }
          },
        ),
      );
      await controller.loadRequest(host.uri);
      if (mounted) setState(() => _view = controller);
    } on Object {
      await _host?.close();
      _host = null;
      if (mounted) {
        setState(
          () => _error = _text(
            'Could not start Jellyree.',
            'Не удалось запустить Jellyree.',
            'No se pudo iniciar Jellyree.',
          ),
        );
      }
    }
  }

  Future<List<Picked>> _pick(bool folders) async {
    if (!mounted) return [];
    if (folders) {
      String? selected;
      if (Platform.isIOS) {
        selected = await _systemFolders.invokeMethod<String>('pick');
      } else {
        final directory = await FilePicker.pickDirectory();
        if (directory != null) {
          selected = directory.scheme == 'content'
              ? await _systemFolders.invokeMethod<String>(
                  'stage',
                  directory.toString(),
                )
              : directory.toFilePath();
        }
      }
      if (selected == null) return [];
      final root = Directory(selected);
      final name = root.uri.pathSegments
          .where((segment) => segment.isNotEmpty)
          .last;
      final result = <Picked>[];
      await for (final entry in root.list(
        recursive: true,
        followLinks: false,
      )) {
        if (entry is! File) continue;
        final relative = entry.path
            .substring(root.path.length + 1)
            .split(Platform.pathSeparator);
        result.add((
          file: entry,
          name: relative.last,
          folders: [name, ...relative.take(relative.length - 1)],
        ));
      }
      return result;
    }
    final source = await showCupertinoModalPopup<String>(
      context: context,
      builder: (sheet) => CupertinoActionSheet(
        actions: [
          CupertinoActionSheetAction(
            onPressed: () => Navigator.pop(sheet, 'media'),
            child: Text(
              _text('Photos and videos', 'Фото и видео', 'Fotos y vídeos'),
            ),
          ),
          CupertinoActionSheetAction(
            onPressed: () => Navigator.pop(sheet, 'files'),
            child: Text(_text('Files', 'Файлы', 'Archivos')),
          ),
        ],
        cancelButton: CupertinoActionSheetAction(
          isDefaultAction: true,
          onPressed: () => Navigator.pop(sheet),
          child: Text(_text('Cancel', 'Отмена', 'Cancelar')),
        ),
      ),
    );
    if (source == 'media') {
      final items = await ImagePicker().pickMultipleMedia(
        requestFullMetadata: false,
      );
      return [
        for (final file in items)
          (file: File(file.path), name: file.name, folders: <String>[]),
      ];
    }
    if (source != 'files') return [];
    final items = await FilePicker.pickFiles();
    return [
      for (final file in items)
        if (file.path != null)
          (file: File(file.path!), name: file.name, folders: <String>[]),
    ];
  }

  Rect? _shareOrigin() {
    final box = context.findRenderObject();
    if (box is! RenderBox || !box.hasSize) return null;
    return box.localToGlobal(box.size.center(Offset.zero)) & const Size(1, 1);
  }

  Future<void> _shareFiles(List<String> paths) async {
    if (!mounted || paths.isEmpty) return;
    await SharePlus.instance.share(
      ShareParams(
        files: paths.map((path) => XFile(path)).toList(),
        sharePositionOrigin: _shareOrigin(),
      ),
    );
  }

  Future<void> _shareLink(String link) async {
    if (!mounted) return;
    await SharePlus.instance.share(
      ShareParams(text: link, sharePositionOrigin: _shareOrigin()),
    );
  }

  @override
  void dispose() {
    final host = _host;
    if (host != null) unawaited(host.close());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final view = _view;
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop || view == null) return;
        final handled = await view.runJavaScriptReturningResult(
          'window.jellyreeMobileBack?.() ?? false',
        );
        if (handled != true && handled != 'true' && Platform.isAndroid) {
          await SystemNavigator.pop();
        }
      },
      child: Scaffold(
        backgroundColor: const Color(0xFFF8F8FC),
        body: SafeArea(
          child: _error != null
              ? Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(_error!),
                      TextButton(
                        onPressed: () async {
                          await _host?.close();
                          await _start();
                        },
                        child: Text(_text('Retry', 'Повторить', 'Reintentar')),
                      ),
                    ],
                  ),
                )
              : Stack(
                  fit: StackFit.expand,
                  children: [
                    if (view != null) WebViewWidget(controller: view),
                    if (!_loaded)
                      const Center(child: CircularProgressIndicator()),
                  ],
                ),
        ),
      ),
    );
  }
}
