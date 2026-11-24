import 'dart:io';

import 'package:exif_reader/exif_reader.dart';
import 'package:random_access_source/random_access_source.dart';

final _datePattern = RegExp(r'^(\d{4}):(\d{2}):(\d{2}) (\d{2}:\d{2}:\d{2})$');
final _offsetPattern = RegExp(r'^[+-](?:[01]\d|2[0-3]):[0-5]\d$');
final _subsecondPattern = RegExp(r'^\d+$');

Future<String?> readCaptureDate(File file, String mimeType) async {
  if (!mimeType.startsWith('image/')) return null;
  try {
    final source = await FileRASource.openPath(file.path);
    try {
      final exif = await readExifFromSource(source, details: false);
      String tag(String name) =>
          exif.tags['EXIF $name']?.printable.trim() ?? '';
      final match = _datePattern.firstMatch(tag('DateTimeOriginal'));
      if (match == null || match[1] == '0000') return null;
      final original = '${match[1]}-${match[2]}-${match[3]}T${match[4]}';
      final calendarDate = DateTime.tryParse('${original}Z');
      if (calendarDate?.toIso8601String().substring(0, 19) != original) {
        return null;
      }
      final sub = tag('SubSecTimeOriginal');
      final millis = _subsecondPattern.hasMatch(sub)
          ? sub.padRight(3, '0').substring(0, 3)
          : '000';
      final offset = tag('OffsetTimeOriginal');
      final zone = _offsetPattern.hasMatch(offset) ? offset : '';
      return DateTime.parse('$original.$millis$zone').toUtc().toIso8601String();
    } finally {
      await source.close();
    }
  } on Object {
    // Unreadable metadata can still belong to a file worth uploading.
    return null;
  }
}
