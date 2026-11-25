import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

typedef MediaDateCandidate = (int, Object?, String?, String?);
typedef _Read = Future<Uint8List> Function(int position, int length);
typedef _Add = void Function(int? priority, Object? value);
typedef _Box = ({int id, int start, int end});

const _isoContainers = {'moov', 'trak', 'mdia', 'udta'};
// Prefer recording and content dates (0–1), then digitization or encoding (2).
// Container/media headers (3) and track headers (4) are fallbacks.
const _dateAtoms = {'mvhd': 3, 'mdhd': 3, 'tkhd': 4};
const _xmpFields = [
  (0, 'exif:DateTimeOriginal'),
  (0, 'xmpDM:shotDate'),
  (1, 'photoshop:DateCreated'),
  (2, 'xmp:CreateDate'),
  (2, 'exif:DateTimeDigitized'),
  (5, 'xmp:ModifyDate'),
];

void _addXmp(Uint8List bytes, _Add add) {
  final text = _text(bytes);
  for (final (priority, tag) in _xmpFields) {
    final pattern = RegExp(
      r'''(?:\s|<)''' + tag + r'''(?:\s*=\s*['"]([^'"]+)['"]|\s*>([^<]+)<)''',
    );
    final match = pattern.firstMatch(text);
    if (match != null) add(priority, match[1] ?? match[2]);
  }
}

int? _datePriority(String key) => switch (key.toLowerCase().replaceAll(
  ' ',
  '_',
)) {
  'com.apple.quicktime.creationdate' ||
  'datetimeoriginal' ||
  'date_recorded' ||
  'recording_date' ||
  'recording_time' => 0,
  '©day' || 'date_created' || 'date' => 1,
  'creation_time' || 'creation_date' || 'date_digitized' || 'date_encoded' => 2,
  _ => null,
};

final _nulSuffix = RegExp(r'\x00+$');
String _text(List<int> bytes) => utf8
    .decode(bytes, allowMalformed: true)
    .replaceFirst(_nulSuffix, '')
    .trim();
String _type(Uint8List bytes, int offset) =>
    latin1.decode(Uint8List.sublistView(bytes, offset, offset + 4));
String _boxType(_Box box) => String.fromCharCodes([
  box.id >> 24,
  (box.id >> 16) & 255,
  (box.id >> 8) & 255,
  box.id & 255,
]);

DateTime? _isoCreation(Uint8List bytes) {
  final data = ByteData.sublistView(bytes);
  final seconds = switch (bytes.firstOrNull) {
    0 when bytes.length >= 8 => data.getUint32(4),
    1 when bytes.length >= 12 => data.getUint64(4),
    _ => 0,
  };
  if (seconds <= 0 || seconds == 0xffffffff || seconds > 315569520000) {
    return null;
  }
  return DateTime.fromMillisecondsSinceEpoch(
    (seconds - 2082844800) * 1000,
    isUtc: true,
  );
}

Stream<_Box> _isoBoxes(_Read read, int start, int end) async* {
  for (var offset = start; offset + 8 <= end;) {
    final head = await read(offset, min(16, end - offset));
    if (head.length < 8) return;
    final data = ByteData.sublistView(head);
    var size = data.getUint32(0);
    final header = size == 1 ? 16 : 8;
    if (size == 1) {
      if (head.length < header) return;
      size = data.getUint64(8);
    } else if (size == 0) {
      size = end - offset;
    }
    if (size < header || size > end - offset) return;
    yield (id: data.getUint32(4), start: offset + header, end: offset + size);
    offset += size;
  }
}

Future<List<String>> _isoKeys(_Read read, _Box box) async {
  final bytes = await read(box.start, min(box.end - box.start, 256 * 1024));
  final keys = <String>[];
  if (bytes.length < 8) return keys;
  final data = ByteData.sublistView(bytes);
  final count = data.getUint32(4);
  var offset = 8;
  for (var i = 0; i < count && offset + 8 <= bytes.length; i++) {
    final size = data.getUint32(offset);
    if (size < 8 || size > bytes.length - offset) break;
    keys.add(_text(Uint8List.sublistView(bytes, offset + 8, offset + size)));
    offset += size;
  }
  return keys;
}

Future<void> _isoItems(
  _Read read,
  _Box box,
  List<String> keys,
  _Add add,
) async {
  await for (final item in _isoBoxes(read, box.start, box.end)) {
    final type = _boxType(item);
    var key = item.id > 0 && item.id <= keys.length ? keys[item.id - 1] : type;
    if (key != '----' && _datePriority(key) == null) continue;
    String? value;
    await for (final part in _isoBoxes(read, item.start, item.end)) {
      final size = part.end - part.start;
      if (size < 8 || size > 4096) continue;
      final partType = _boxType(part);
      if (partType != 'data' && !(partType == 'name' && type == '----')) {
        continue;
      }
      final bytes = await read(part.start, size);
      if (bytes.length != size) continue;
      if (partType == 'name') {
        key = _text(Uint8List.sublistView(bytes, 4));
      } else {
        final data = ByteData.sublistView(bytes);
        value = (data.getUint32(0) & 0xffffff) == 2 && size.isEven
            ? String.fromCharCodes([
                for (var offset = 8; offset < size; offset += 2)
                  data.getUint16(offset),
              ]).replaceFirst(_nulSuffix, '').trim()
            : _text(Uint8List.sublistView(bytes, 8));
      }
    }
    add(_datePriority(key), value);
  }
}

Future<void> _isoMeta(_Read read, _Box box, _Add add) async {
  final head = await read(box.start, 8);
  if (head.length < 8) return;
  // ISO meta is a full box. Legacy QuickTime meta can omit version/flags.
  final leadingType = _type(head, 4);
  final start =
      box.start + ({'hdlr', 'keys', 'ilst'}.contains(leadingType) ? 0 : 4);
  var keys = <String>[];
  _Box? items;
  await for (final child in _isoBoxes(read, start, box.end)) {
    final type = _boxType(child);
    if (type == 'keys') keys = await _isoKeys(read, child);
    if (type == 'ilst') items = child;
  }
  if (items != null) await _isoItems(read, items, keys, add);
}

const _adobeXmpUuid = [
  0xbe,
  0x7a,
  0xcf,
  0xcb,
  0x97,
  0xa9,
  0x42,
  0xe8,
  0x9c,
  0x71,
  0x99,
  0x94,
  0x91,
  0xe3,
  0xaf,
  0xac,
];

Future<void> _isoDates(
  _Read read,
  int start,
  int end,
  _Add add, [
  int depth = 0,
]) async {
  if (depth > 6) return;
  await for (final box in _isoBoxes(read, start, end)) {
    final type = _boxType(box);
    final size = box.end - box.start;
    if (_isoContainers.contains(type)) {
      await _isoDates(read, box.start, box.end, add, depth + 1);
    } else if (_dateAtoms[type] case final priority?) {
      add(priority, _isoCreation(await read(box.start, min(size, 12))));
    } else if (type == 'meta') {
      await _isoMeta(read, box, add);
    } else if (type == '©day' && size <= 4096) {
      final bytes = await read(box.start, size);
      add(1, _text(bytes));
      if (bytes.length >= 4) {
        final length = ByteData.sublistView(bytes).getUint16(0);
        if (length <= bytes.length - 4) {
          add(1, _text(Uint8List.sublistView(bytes, 4, 4 + length)));
        }
      }
    } else if (type == 'XMP_' || type == 'uuid') {
      var offset = box.start;
      if (type == 'uuid') {
        if (size < 16) continue;
        final uuid = await read(offset, 16);
        if (uuid.length != 16 ||
            Iterable<int>.generate(16)
                .any((i) => uuid[i] != _adobeXmpUuid[i])) {
          continue;
        }
        offset += 16;
      }
      if (box.end - offset <= 256 * 1024) {
        _addXmp(await read(offset, box.end - offset), add);
      }
    }
  }
}

({int value, int width, bool unknown})? _ebmlNumber(
  Uint8List bytes,
  int offset,
  bool id,
) {
  if (offset >= bytes.length) return null;
  final first = bytes[offset];
  var marker = 128;
  var width = 1;
  while (marker != 0 && (first & marker) == 0) {
    marker >>= 1;
    width++;
  }
  if (marker == 0 || width + offset > bytes.length || (id && width > 4)) {
    return null;
  }
  var value = id ? first : first & (marker - 1);
  for (var i = offset + 1; i < offset + width; i++) {
    value = (value << 8) | bytes[i];
  }
  return (
    value: value,
    width: width,
    unknown: !id && value == (1 << (width * 7)) - 1,
  );
}

Stream<_Box> _ebmlElements(_Read read, int start, int end) async* {
  for (var offset = start; offset + 2 <= end;) {
    final head = await read(offset, min(12, end - offset));
    final id = _ebmlNumber(head, 0, true);
    if (id == null) return;
    final size = _ebmlNumber(head, id.width, false);
    if (size == null) return;
    final payload = offset + id.width + size.width;
    final finish = size.unknown ? end : payload + size.value;
    if (finish > end || payload > finish) return;
    yield (id: id.value, start: payload, end: finish);
    offset = finish;
  }
}

final _ebmlEpochMillis = DateTime.utc(2001).millisecondsSinceEpoch;
Future<void> _ebmlDates(
  _Read read,
  int start,
  int end,
  _Add add, [
  int depth = 0,
]) async {
  if (depth > 6) return;
  String? key, value;
  await for (final element in _ebmlElements(read, start, end)) {
    final size = element.end - element.start;
    switch (element.id) {
      case 0x18538067: // Segment
      case 0x1549a966: // Info
      case 0x1254c367: // Tags
      case 0x7373: // Tag
      case 0x67c8: // SimpleTag
        await _ebmlDates(read, element.start, element.end, add, depth + 1);
      case 0x4461: // DateUTC, signed nanoseconds since 2001-01-01.
        if (size == 8) {
          final bytes = await read(element.start, 8);
          if (bytes.length == 8) {
            final nanos = ByteData.sublistView(bytes).getInt64(0);
            if (nanos != 0) {
              add(
                3,
                DateTime.fromMillisecondsSinceEpoch(
                  _ebmlEpochMillis + nanos ~/ 1000000,
                  isUtc: true,
                ),
              );
            }
          }
        }
      case 0x45a3:
        if (size <= 256) key = _text(await read(element.start, size));
      case 0x4487:
        if (size <= 4096) value = _text(await read(element.start, size));
    }
  }
  if (key != null) add(_datePriority(key), value);
}

Future<void> _riffDates(
  _Read read,
  int start,
  int end,
  _Add add, [
  int depth = 0,
]) async {
  if (depth > 4) return;
  for (var offset = start; offset + 8 <= end;) {
    final head = await read(offset, min(12, end - offset));
    if (head.length < 8) return;
    final type = _type(head, 0);
    final size = ByteData.sublistView(head).getUint32(4, Endian.little);
    final payload = offset + 8;
    final finish = payload + size;
    if (finish > end) return;
    if (type == 'LIST' &&
        size >= 4 &&
        {'hdrl', 'INFO', 'odml'}.contains(_type(head, 8))) {
      await _riffDates(read, payload + 4, finish, add, depth + 1);
    }
    if ((type == 'IDIT' || type == 'ICRD') && size <= 4096) {
      add(type == 'IDIT' ? 0 : 1, _text(await read(payload, size)));
    }
    if (type == 'XMP ' && size <= 256 * 1024) {
      _addXmp(await read(payload, size), add);
    }
    offset = finish + size % 2;
  }
}

void _iptcDates(Uint8List bytes, _Add add) {
  final data = ByteData.sublistView(bytes);
  var offset = 'Photoshop 3.0\x00'.length;
  final tags = <int, String>{};
  while (offset + 12 <= bytes.length && _type(bytes, offset) == '8BIM') {
    final resource = data.getUint16(offset + 4);
    final nameLength = bytes[offset + 6] + 1;
    offset += 6 + nameLength + nameLength % 2;
    if (offset + 4 > bytes.length) return;
    final size = data.getUint32(offset);
    offset += 4;
    if (size > bytes.length - offset) return;
    if (resource == 0x0404) {
      final end = offset + size;
      for (var pos = offset; pos + 5 <= end && bytes[pos] == 0x1c;) {
        final kind = bytes[pos + 1] == 2 ? bytes[pos + 2] : 0;
        final length = data.getUint16(pos + 3);
        pos += 5;
        if (length > end - pos) break;
        if (kind >= 55 && kind <= 63 && length <= 32) {
          tags[kind] = _text(Uint8List.sublistView(bytes, pos, pos + length));
        }
        pos += length;
      }
    }
    offset += size + size % 2;
  }
  for (final (dateTag, timeTag, priority) in [(55, 60, 1), (62, 63, 2)]) {
    final date = tags[dateTag];
    if (date == null) continue;
    final time = RegExp(r'^(\d{2})(\d{2})(\d{2})(.*)$')
        .firstMatch(tags[timeTag] ?? '');
    if (time != null) {
      add(priority, '${date}T${time[1]}:${time[2]}:${time[3]}${time[4]}');
    }
    add(priority, date);
  }
}

Future<void> _jpegDates(_Read read, int size, _Add add) async {
  const xmp = 'http://ns.adobe.com/xap/1.0/\x00';
  const iptc = 'Photoshop 3.0\x00';
  for (var offset = 2; offset + 4 <= size;) {
    final head = await read(offset, 4);
    if (head.length < 4 ||
        head[0] != 0xff ||
        head[1] == 0xda ||
        head[1] == 0xd9) {
      return;
    }
    if (head[1] == 0xff) {
      offset++;
      continue;
    }
    final length = ByteData.sublistView(head).getUint16(2);
    if (length < 2 || offset + 2 + length > size) return;
    final prefix = switch (head[1]) {
      0xe1 => xmp,
      0xed => iptc,
      _ => '',
    };
    if (prefix.isNotEmpty && length >= 2 + prefix.length) {
      final header = await read(offset + 4, prefix.length);
      if (latin1.decode(header) == prefix) {
        final bytes = await read(offset + 4, length - 2);
        if (bytes.length == length - 2) {
          if (prefix == xmp) {
            _addXmp(Uint8List.sublistView(bytes, xmp.length), add);
          } else {
            _iptcDates(bytes, add);
          }
        }
      }
    }
    offset += 2 + length;
  }
}

Future<void> _pngDates(_Read read, int end, _Add add) async {
  for (var offset = 8; offset + 12 <= end;) {
    final head = await read(offset, 8);
    if (head.length != 8 || _type(head, 4) == 'IEND') return;
    final size = ByteData.sublistView(head).getUint32(0);
    if (size > end - offset - 12) return;
    final type = _type(head, 4);
    if ((type == 'iTXt' || type == 'tEXt') && size <= 256 * 1024) {
      final bytes = await read(offset + 8, size);
      final separator = bytes.indexOf(0);
      if (separator > 0) {
        final key = latin1.decode(Uint8List.sublistView(bytes, 0, separator));
        if (type == 'tEXt' && key == 'Creation Time') {
          add(2, _text(Uint8List.sublistView(bytes, separator + 1)));
        } else if (type == 'iTXt' &&
            separator + 3 < bytes.length &&
            bytes[separator + 1] == 0) {
          final language = bytes.indexOf(0, separator + 3);
          final translated = language < 0 ? -1 : bytes.indexOf(0, language + 1);
          if (translated >= 0) {
            final text = Uint8List.sublistView(bytes, translated + 1);
            if (key == 'XML:com.adobe.xmp') _addXmp(text, add);
            if (key == 'Creation Time') add(2, _text(text));
          }
        }
      }
    }
    offset += 12 + size;
  }
}

Future<List<MediaDateCandidate>> containerDates(File source) async {
  final file = await source.open();
  final dates = <MediaDateCandidate>[];
  void add(int? priority, Object? value) {
    if (priority != null && value != null) {
      dates.add((priority, value, null, null));
    }
  }

  var reads = 4096;
  var budget = 2 * 1024 * 1024;
  Future<Uint8List> read(int position, int length) async {
    if (--reads < 0 || length > budget) return Uint8List(0);
    budget -= length;
    await file.setPosition(position);
    return file.read(length);
  }

  try {
    final size = await file.length();
    final head = await read(0, 12);
    if (head.length < 12) return dates;
    final type = _type(head, 4);
    final data = ByteData.sublistView(head);
    if ({'ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'}.contains(type)) {
      await _isoDates(read, 0, size, add);
    } else if (data.getUint32(0) == 0x1a45dfa3) {
      await _ebmlDates(read, 0, size, add);
    } else if (_type(head, 0) == 'RIFF' &&
        {'AVI ', 'WEBP'}.contains(_type(head, 8))) {
      await _riffDates(
        read,
        12,
        min(size, data.getUint32(4, Endian.little) + 8),
        add,
      );
    } else if (data.getUint16(0) == 0xffd8) {
      await _jpegDates(read, size, add);
    } else if (data.getUint32(0) == 0x89504e47 &&
        data.getUint32(4) == 0x0d0a1a0a) {
      await _pngDates(read, size, add);
    }
  } finally {
    await file.close();
  }
  return dates;
}
