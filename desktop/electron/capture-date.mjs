import ExifReader from "exifreader";
import { containerDates } from "./media-container-dates.mjs";

const datePattern =
  /^(\d{4})[-:/]?(\d{2})[-:/]?(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:[.,](\d+))?\s*(Z|UTC|[+-]\d{2}(?::?\d{2})?)?)?$/i;
const offsetPattern = /^[+-](?:[01]\d|2[0-3]):?[0-5]\d$/;
const months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

function parseDate(value, offset, subsecond) {
  if (typeof value !== "string") return null;
  let text = value.trim();
  const ctime = /^\w{3} (\w{3}) +(\d{1,2}) (\d{2}:\d{2}:\d{2}) (\d{4})$/.exec(
    text,
  );
  const rfc1123 =
    /^(?:\w{3}, )?(\d{1,2}) (\w{3}) (\d{4}) (\d{2}:\d{2}:\d{2}) (GMT|UTC|[+-]\d{4})$/.exec(
      text,
    );
  if (ctime || rfc1123) {
    const [day, month, year, time, zone] = ctime
      ? [ctime[2], ctime[1], ctime[4], ctime[3], ""]
      : rfc1123.slice(1);
    const monthNumber = String(months.indexOf(month) + 1).padStart(2, "0");
    text = `${year}-${monthNumber}-${day.padStart(2, "0")}T${time}${zone === "GMT" ? "Z" : zone}`;
  }
  const match = datePattern.exec(text);
  if (!match || match[1] === "0000") return null;
  const [, year, month, day, hour, minute, second, fraction, timeZone] = match;
  const local = `${year}-${month}-${day}T${hour ?? "00"}:${minute ?? "00"}:${second ?? "00"}`;
  const check = new Date(local + "Z");
  if (!Number.isFinite(+check) || check.toISOString().slice(0, 19) !== local)
    return null;
  const subseconds = fraction ?? subsecond ?? "";
  const millis = /^\d+$/.test(subseconds)
    ? subseconds.slice(0, 3).padEnd(3, "0")
    : "000";
  const zone =
    timeZone?.toUpperCase() ?? (offsetPattern.test(offset ?? "") ? offset : "");
  let isoZone = zone === "UTC" ? "Z" : zone;
  if (/^[+-]\d\d$/.test(isoZone)) isoZone += ":00";
  if (/^[+-]\d{4}$/.test(isoZone))
    isoZone = isoZone.slice(0, 3) + ":" + isoZone.slice(3);
  const date = new Date(`${local}.${millis}${isoZone}`);
  return Number.isFinite(+date)
    ? { date, dayOnly: !hour, zoned: !!isoZone }
    : null;
}

function chooseDate(candidates) {
  const latest = Date.now() + 48 * 60 * 60 * 1000;
  let best;
  for (const [priority, value, offset, subsecond] of candidates) {
    const parsed =
      value instanceof Date
        ? Number.isFinite(+value) && value.getUTCFullYear() >= 1970
          ? { date: value, dayOnly: false, zoned: true }
          : null
        : parseDate(value, offset, subsecond);
    if (!parsed || +parsed.date === 0 || +parsed.date > latest) continue;
    const score =
      4 * priority + 2 * Number(parsed.dayOnly) + Number(!parsed.zoned);
    const earlierHeader =
      best &&
      score === best.score &&
      value instanceof Date &&
      parsed.date < best.date;
    if (!best || score < best.score || earlierHeader)
      best = { date: parsed.date, score };
  }
  return best?.date.toISOString() ?? null;
}

function iptcDate(date, time) {
  if (!date || !time) return date;
  const compact = /^(\d{2})(\d{2})(\d{2})(.*)$/.exec(time);
  return compact
    ? `${date}T${compact[1]}:${compact[2]}:${compact[3]}${compact[4]}`
    : `${date}T${time}`;
}

async function photoDates(source) {
  const options = {
    expanded: true,
    includeTags: {
      exif: [
        "DateTimeOriginal",
        "OffsetTimeOriginal",
        "SubSecTimeOriginal",
        "DateTimeDigitized",
        "OffsetTimeDigitized",
        "SubSecTimeDigitized",
        "DateTime",
        "OffsetTime",
        "SubSecTime",
      ],
      iptc: [
        "Date Created",
        "Time Created",
        "Digital Creation Date",
        "Digital Creation Time",
      ],
      xmp: [
        "DateTimeOriginal",
        "DateCreated",
        "shotDate",
        "CreateDate",
        "DateTimeDigitized",
        "ModifyDate",
      ],
      png: ["Creation Time"],
    },
  };
  let tags;
  try {
    tags = await ExifReader.load(source, {
      ...options,
      length: "auto",
      includeOffsets: true,
    });
  } catch {
    tags = await ExifReader.load(source, {
      ...options,
      length: 2 * 1024 * 1024,
    });
  }
  const { exif, iptc, xmp, pngText } = tags;
  const e = (key) => exif?.[key]?.description?.trim();
  const i = (key) => iptc?.[key]?.description;
  const x = (key) => xmp?.[key]?.value;
  return [
    [
      0,
      e("DateTimeOriginal"),
      e("OffsetTimeOriginal"),
      e("SubSecTimeOriginal"),
    ],
    [0, x("DateTimeOriginal")],
    [0, x("shotDate")],
    [1, x("DateCreated")],
    [1, iptcDate(i("Date Created"), i("Time Created"))],
    [1, i("Date Created")],
    [
      2,
      e("DateTimeDigitized"),
      e("OffsetTimeDigitized"),
      e("SubSecTimeDigitized"),
    ],
    [2, x("DateTimeDigitized")],
    [2, iptcDate(i("Digital Creation Date"), i("Digital Creation Time"))],
    [2, i("Digital Creation Date")],
    [2, x("CreateDate")],
    [2, pngText?.["Creation Time"]?.value],
    [5, e("DateTime"), e("OffsetTime"), e("SubSecTime")],
    [5, x("ModifyDate")],
  ];
}

export async function readCaptureDate(source, mimeType) {
  try {
    if (mimeType.startsWith("image/"))
      return chooseDate(await photoDates(source));
    if (
      mimeType.startsWith("video/") ||
      mimeType === "application/mp4" ||
      mimeType === "application/octet-stream"
    )
      return chooseDate(await containerDates(source));
  } catch {
    // Missing, unsupported or malformed metadata must not block uploads.
  }
  return null;
}
