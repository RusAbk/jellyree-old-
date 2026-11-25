import 'dart:io';

import 'package:exif_reader/exif_reader.dart';
import 'package:random_access_source/random_access_source.dart';

import 'media_container_dates.dart';

final _datePattern = RegExp(
  r'^(\d{4})[-:/]?(\d{2})[-:/]?(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:[.,](\d+))?\s*(Z|UTC|[+-]\d{2}(?::?\d{2})?)?)?$',
  caseSensitive: false,
);
final _offsetPattern = RegExp(r'^[+-](?:[01]\d|2[0-3]):?[0-5]\d$');
final _subsecondPattern = RegExp(r'^\d+$');
final _ctimePattern = RegExp(
  r'^\w{3} (\w{3}) +(\d{1,2}) (\d{2}:\d{2}:\d{2}) (\d{4})$',
);
final _rfc1123Pattern = RegExp(
  r'^(?:\w{3}, )?(\d{1,2}) (\w{3}) (\d{4}) (\d{2}:\d{2}:\d{2}) (GMT|UTC|[+-]\d{4})$',
);
const _months = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

({DateTime date, bool dayOnly, bool zoned})? _parseDate(
  Object? value,
  String? offset,
  String? subsecond,
) {
  if (value is DateTime && value.year >= 1970) {
    return (date: value, dayOnly: false, zoned: true);
  }
  if (value is! String) return null;
  var text = value.trim();
  final ctime = _ctimePattern.firstMatch(text);
  final rfc1123 = _rfc1123Pattern.firstMatch(text);
  if (ctime != null || rfc1123 != null) {
    final (day, month, year, time, zone) = ctime != null
        ? (ctime[2]!, ctime[1]!, ctime[4]!, ctime[3]!, '')
        : (rfc1123![1]!, rfc1123[2]!, rfc1123[3]!, rfc1123[4]!, rfc1123[5]!);
    final monthNumber = (_months.indexOf(month) + 1).toString().padLeft(2, '0');
    text =
        '$year-$monthNumber-${day.padLeft(2, '0')}T$time${zone == 'GMT' ? 'Z' : zone}';
  }
  final match = _datePattern.firstMatch(text);
  if (match == null || match[1] == '0000') return null;
  final local =
      '${match[1]}-${match[2]}-${match[3]}T'
      '${match[4] ?? '00'}:${match[5] ?? '00'}:${match[6] ?? '00'}';
  final check = DateTime.tryParse('${local}Z');
  if (check?.toIso8601String().substring(0, 19) != local) return null;
  final sub = match[7] ?? subsecond ?? '';
  final millis = _subsecondPattern.hasMatch(sub)
      ? sub.padRight(3, '0').substring(0, 3)
      : '000';
  final zone =
      match[8]?.toUpperCase() ??
      (_offsetPattern.hasMatch(offset ?? '') ? offset! : '');
  if (zone.startsWith('+') || zone.startsWith('-')) {
    final normalized = zone.length == 3 ? '$zone:00' : zone;
    if (!_offsetPattern.hasMatch(normalized)) return null;
  }
  final date = DateTime.tryParse('$local.$millis${zone == 'UTC' ? 'Z' : zone}');
  return date == null
      ? null
      : (date: date, dayOnly: match[4] == null, zoned: zone.isNotEmpty);
}

String? _chooseDate(Iterable<MediaDateCandidate> candidates) {
  final latest = DateTime.now().add(const Duration(days: 2));
  DateTime? best;
  var bestScore = 100;
  for (final (priority, value, offset, subsecond) in candidates) {
    final parsed = _parseDate(value, offset, subsecond);
    if (parsed == null ||
        parsed.date.millisecondsSinceEpoch == 0 ||
        parsed.date.isAfter(latest)) {
      continue;
    }
    final score =
        4 * priority + (parsed.dayOnly ? 2 : 0) + (parsed.zoned ? 0 : 1);
    final earlierHeader =
        best != null &&
        score == bestScore &&
        value is DateTime &&
        parsed.date.isBefore(best);
    if (score > bestScore || (score == bestScore && !earlierHeader)) continue;
    best = parsed.date;
    bestScore = score;
  }
  return best?.toUtc().toIso8601String();
}

Future<List<MediaDateCandidate>> _exifDates(File file) async {
  try {
    final source = await FileRASource.openPath(file.path);
    try {
      final exif = await readExifFromSource(source, details: false);
      String? tag(String key) => exif.tags[key]?.printable.trim();
      return [
        (
          0,
          tag('EXIF DateTimeOriginal'),
          tag('EXIF OffsetTimeOriginal'),
          tag('EXIF SubSecTimeOriginal'),
        ),
        (
          2,
          tag('EXIF DateTimeDigitized'),
          tag('EXIF OffsetTimeDigitized'),
          tag('EXIF SubSecTimeDigitized'),
        ),
        (
          5,
          tag('Image DateTime'),
          tag('EXIF OffsetTime'),
          tag('EXIF SubSecTime'),
        ),
      ];
    } finally {
      await source.close();
    }
  } on Object {
    return [];
  }
}

Future<String?> readCaptureDate(File file, String mimeType) async {
  if (!(mimeType.startsWith('image/') ||
      mimeType.startsWith('video/') ||
      mimeType == 'application/mp4' ||
      mimeType == 'application/octet-stream')) {
    return null;
  }
  final exif = mimeType.startsWith('image/')
      ? await _exifDates(file)
      : <MediaDateCandidate>[];
  try {
    return _chooseDate([...exif, ...await containerDates(file)]);
  } on Object {
    // Missing, unsupported or malformed metadata must not block uploads.
    return _chooseDate(exif);
  }
}
