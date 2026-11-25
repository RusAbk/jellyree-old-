import { open } from "node:fs/promises";

const boxContainers = new Set(["moov", "trak", "mdia", "udta"]);
// Prefer recording and content dates (0–1), then digitization or encoding (2).
// Container/media headers (3) and track headers (4) are fallbacks.
const dateAtoms = new Map([
  ["mvhd", 3],
  ["mdhd", 3],
  ["tkhd", 4],
]);
const xmpFields = [
  [0, "exif:DateTimeOriginal"],
  [0, "xmpDM:shotDate"],
  [1, "photoshop:DateCreated"],
  [2, "xmp:CreateDate"],
  [2, "exif:DateTimeDigitized"],
  [5, "xmp:ModifyDate"],
];

function xmpDates(text) {
  return xmpFields.flatMap(([priority, tag]) => {
    const match = new RegExp(
      "(?:\\s|<)" + tag + "(?:\\s*=\\s*['\"]([^'\"]+)['\"]|\\s*>([^<]+)<)",
    ).exec(text);
    return match ? [[priority, match[1] ?? match[2]]] : [];
  });
}

function datePriority(key) {
  switch (key.toLowerCase().replaceAll(" ", "_")) {
    case "com.apple.quicktime.creationdate":
    case "datetimeoriginal":
    case "date_recorded":
    case "recording_date":
    case "recording_time":
      return 0;
    case "©day":
    case "date_created":
    case "date":
      return 1;
    case "creation_time":
    case "creation_date":
    case "date_digitized":
    case "date_encoded":
      return 2;
    default:
      return null;
  }
}

const readText = (bytes) => bytes.toString("utf8").replace(/\0+$/g, "").trim();
const appleEpochSeconds = 2082844800n;
const ebmlEpochMillis = Date.UTC(2001, 0, 1);

function isoCreation(bytes) {
  const seconds =
    bytes[0] === 1 && bytes.length >= 12
      ? bytes.readBigUInt64BE(4)
      : bytes[0] === 0 && bytes.length >= 8
        ? BigInt(bytes.readUInt32BE(4))
        : 0n;
  if (seconds === 0n || seconds === 0xffffffffn) return null;
  return new Date(Number(seconds - appleEpochSeconds) * 1000);
}

async function* isoBoxes(read, start, end) {
  for (let offset = start; offset + 8 <= end;) {
    const head = await read(offset, Math.min(16, end - offset));
    if (head.length < 8) return;
    const kind = head.readUInt32BE(4);
    const type = head.toString("latin1", 4, 8);
    let size = head.readUInt32BE(0);
    const header = size === 1 ? 16 : 8;
    if (size === 1) {
      if (head.length < header) return;
      size = Number(head.readBigUInt64BE(8));
    } else if (size === 0) size = end - offset;
    if (!Number.isSafeInteger(size) || size < header || size > end - offset)
      return;
    yield { type, kind, start: offset + header, end: offset + size };
    offset += size;
  }
}

async function isoKeys(read, box) {
  const bytes = await read(
    box.start,
    Math.min(box.end - box.start, 256 * 1024),
  );
  const keys = [];
  if (bytes.length < 8) return keys;
  const count = bytes.readUInt32BE(4);
  for (let i = 0, offset = 8; i < count && offset + 8 <= bytes.length; i++) {
    const size = bytes.readUInt32BE(offset);
    if (size < 8 || size > bytes.length - offset) break;
    keys.push(bytes.toString("utf8", offset + 8, offset + size));
    offset += size;
  }
  return keys;
}

async function isoItems(read, box, keys, add) {
  for await (const item of isoBoxes(read, box.start, box.end)) {
    let key = keys[item.kind - 1] ?? item.type;
    if (key !== "----" && datePriority(key) === null) continue;
    let value;
    for await (const part of isoBoxes(read, item.start, item.end)) {
      const size = part.end - part.start;
      if (size < 8 || size > 4096) continue;
      if (
        part.type !== "data" &&
        !(part.type === "name" && item.type === "----")
      )
        continue;
      const bytes = await read(part.start, size);
      if (bytes.length !== size) continue;
      if (part.type === "name") key = readText(bytes.subarray(4));
      else {
        const data = bytes.subarray(8);
        value =
          (bytes.readUInt32BE(0) & 0xffffff) === 2 && data.length % 2 === 0
            ? data.swap16().toString("utf16le").replace(/\0+$/g, "").trim()
            : readText(data);
      }
    }
    add(datePriority(key), value);
  }
}

async function isoMeta(read, box, add) {
  const head = await read(box.start, 8);
  if (head.length < 8) return;
  // ISO meta is a full box, while legacy QuickTime meta can omit version/flags.
  const leadingType = head.toString("latin1", 4, 8);
  const start =
    box.start + (["hdlr", "keys", "ilst"].includes(leadingType) ? 0 : 4);
  let keys = [];
  let items;
  for await (const child of isoBoxes(read, start, box.end)) {
    if (child.type === "keys") keys = await isoKeys(read, child);
    if (child.type === "ilst") items = child;
  }
  if (items) await isoItems(read, items, keys, add);
}

async function isoDates(read, start, end, add, depth = 0) {
  if (depth > 6) return;
  for await (const box of isoBoxes(read, start, end)) {
    const size = box.end - box.start;
    if (boxContainers.has(box.type)) {
      await isoDates(read, box.start, box.end, add, depth + 1);
    } else if (dateAtoms.has(box.type)) {
      add(
        dateAtoms.get(box.type),
        isoCreation(await read(box.start, Math.min(size, 12))),
      );
    } else if (box.type === "meta") {
      await isoMeta(read, box, add);
    } else if (box.type === "©day" && size <= 4096) {
      const bytes = await read(box.start, size);
      add(1, readText(bytes));
      if (bytes.length >= 4 && bytes.readUInt16BE(0) <= bytes.length - 4)
        add(1, readText(bytes.subarray(4, 4 + bytes.readUInt16BE(0))));
    } else if (box.type === "XMP_" || box.type === "uuid") {
      let offset = box.start;
      if (box.type === "uuid") {
        if (size < 16) continue;
        const uuid = await read(offset, 16);
        if (uuid.toString("hex") !== "be7acfcb97a942e89c71999491e3afacb")
          continue;
        offset += 16;
      }
      if (box.end - offset <= 256 * 1024)
        for (const [priority, value] of xmpDates(
          readText(await read(offset, box.end - offset)),
        ))
          add(priority, value);
    }
  }
}

function ebmlNumber(bytes, offset, id) {
  const first = bytes[offset];
  let marker = 128,
    width = 1;
  while (marker && !(first & marker)) {
    marker >>= 1;
    width++;
  }
  if (!marker || width + offset > bytes.length || (id && width > 4)) return;
  let value = BigInt(id ? first : first & (marker - 1));
  for (let i = offset + 1; i < offset + width; i++)
    value = (value << 8n) | BigInt(bytes[i]);
  const unknown = !id && value === (1n << BigInt(width * 7)) - 1n;
  return { value: Number(value), width, unknown };
}

async function* ebmlElements(read, start, end) {
  for (let offset = start; offset + 2 <= end;) {
    const head = await read(offset, Math.min(12, end - offset));
    const id = ebmlNumber(head, 0, true);
    const size = id && ebmlNumber(head, id.width, false);
    if (!size) return;
    const payload = offset + id.width + size.width;
    const finish = size.unknown ? end : payload + size.value;
    if (!Number.isSafeInteger(finish) || finish > end || payload > finish)
      return;
    yield { id: id.value, start: payload, end: finish };
    offset = finish;
  }
}

async function ebmlDates(read, start, end, add, depth = 0) {
  if (depth > 6) return;
  let key, value;
  for await (const element of ebmlElements(read, start, end)) {
    const size = element.end - element.start;
    switch (element.id) {
      case 0x18538067: // Segment
      case 0x1549a966: // Info
      case 0x1254c367: // Tags
      case 0x7373: // Tag
      case 0x67c8: // SimpleTag
        await ebmlDates(read, element.start, element.end, add, depth + 1);
        break;
      case 0x4461: // DateUTC, signed nanoseconds since 2001-01-01.
        if (size === 8) {
          const bytes = await read(element.start, 8);
          if (bytes.length === 8) {
            const nanos = bytes.readBigInt64BE();
            if (nanos !== 0n)
              add(3, new Date(ebmlEpochMillis + Number(nanos / 1000000n)));
          }
        }
        break;
      case 0x45a3:
        if (size <= 256) key = readText(await read(element.start, size));
        break;
      case 0x4487:
        if (size <= 4096) value = readText(await read(element.start, size));
        break;
    }
  }
  if (key) add(datePriority(key), value);
}

async function riffDates(read, start, end, add, depth = 0) {
  if (depth > 4) return;
  for (let offset = start; offset + 8 <= end;) {
    const head = await read(offset, Math.min(12, end - offset));
    if (head.length < 8) return;
    const type = head.toString("latin1", 0, 4);
    const size = head.readUInt32LE(4);
    const payload = offset + 8;
    const finish = payload + size;
    if (finish > end) return;
    if (
      type === "LIST" &&
      size >= 4 &&
      ["hdrl", "INFO", "odml"].includes(head.toString("latin1", 8, 12))
    )
      await riffDates(read, payload + 4, finish, add, depth + 1);
    if ((type === "IDIT" || type === "ICRD") && size <= 4096)
      add(type === "IDIT" ? 0 : 1, readText(await read(payload, size)));
    offset = finish + (size % 2);
  }
}

export async function containerDates(source) {
  const file = await open(source, "r");
  const dates = [];
  const add = (priority, value) => {
    if (priority !== null && value) dates.push([priority, value]);
  };
  let reads = 4096,
    budget = 2 * 1024 * 1024;
  const read = async (position, length) => {
    if (--reads < 0 || length > budget) return Buffer.alloc(0);
    budget -= length;
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await file.read(bytes, 0, length, position);
    return bytes.subarray(0, bytesRead);
  };
  try {
    const { size } = await file.stat();
    const head = await read(0, 12);
    if (head.length < 12) return dates;
    const type = head.toString("latin1", 4, 8);
    if (["ftyp", "moov", "mdat", "wide", "free", "skip"].includes(type))
      await isoDates(read, 0, size, add);
    else if (head.readUInt32BE(0) === 0x1a45dfa3)
      await ebmlDates(read, 0, size, add);
    else if (
      head.toString("latin1", 0, 4) === "RIFF" &&
      head.toString("latin1", 8, 12) === "AVI "
    )
      await riffDates(read, 12, Math.min(size, head.readUInt32LE(4) + 8), add);
  } finally {
    await file.close();
  }
  return dates;
}
