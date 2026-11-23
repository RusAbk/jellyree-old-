import path from "node:path";
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export function validateVideoFrame(data, timestamp) {
  if (
    !(data instanceof Uint8Array) ||
    data.length < 33 ||
    data.length > 128 * 1024 * 1024 ||
    !Number.isFinite(timestamp) ||
    timestamp < 0 ||
    timestamp > 1e9
  )
    throw new TypeError("Invalid video frame");
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (
    !buffer.subarray(0, 8).equals(pngSignature) ||
    buffer.readUInt32BE(8) !== 13 ||
    buffer.toString("ascii", 12, 16) !== "IHDR"
  )
    throw new TypeError("Invalid video frame");
  const width = buffer.readUInt32BE(16),
    height = buffer.readUInt32BE(20);
  if (!width || !height || width * height > 40_000_000)
    throw new TypeError("Invalid video frame dimensions");
  return { width, height };
}
export function videoFrameName(filename, timestamp, suffix = 0) {
  if (
    !Number.isFinite(timestamp) ||
    timestamp < 0 ||
    timestamp > 1e9 ||
    !Number.isInteger(suffix) ||
    suffix < 0
  )
    throw new TypeError("Invalid video frame timestamp");
  const ms = Math.floor(timestamp * 1000),
    seconds = Math.floor(ms / 1000);
  const time =
    [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
      .map((value) => String(value).padStart(2, "0"))
      .join("-") + `.${String(ms % 1000).padStart(3, "0")}`;
  const base =
    path
      .basename(String(filename), path.extname(String(filename)))
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .trim() || "video";
  const tail = `-frame-${time}${suffix ? ` (${suffix})` : ""}.png`;
  const stem = base.slice(0, 255 - tail.length).replace(/[\uD800-\uDBFF]$/, "");
  return `${stem}${tail}`;
}
