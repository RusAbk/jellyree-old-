import ExifReader from "exifreader";

export async function readCaptureDate(source, mimeType) {
  if (!mimeType.startsWith("image/")) return null;
  try {
    const { exif } = await ExifReader.load(source, {
      length: "auto",
      expanded: true,
      includeOffsets: true,
      includeTags: {
        exif: ["DateTimeOriginal", "OffsetTimeOriginal", "SubSecTimeOriginal"],
      },
    });
    const match = exif?.DateTimeOriginal?.description
      .trim()
      .match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}:\d{2}:\d{2})$/);
    if (!match || match[1] === "0000") return null;
    const [, year, month, day, time] = match;
    const original = `${year}-${month}-${day}T${time}`;
    const calendarDate = new Date(original + "Z");
    if (
      !Number.isFinite(calendarDate.getTime()) ||
      calendarDate.toISOString().slice(0, 19) !== original
    )
      return null;
    const subs = exif.SubSecTimeOriginal?.description.trim();
    const millis = /^\d+$/.test(subs ?? "")
      ? subs.slice(0, 3).padEnd(3, "0")
      : "000";
    const offset = exif.OffsetTimeOriginal?.description.trim();
    const zone = /^[+-](?:[01]\d|2[0-3]):[0-5]\d$/.test(offset ?? "")
      ? offset
      : "";
    return new Date(`${original}.${millis}${zone}`).toISOString();
  } catch {
    // Unreadable metadata can still belong to a file worth uploading.
    return null;
  }
}
