/** @param {{name: string, mime_type: string} | null | undefined} file */
export function isHeicFile(file) {
  if (!file) return false;
  const mime = file.mime_type.split(";")[0].trim().toLowerCase();
  return (
    /^image\/hei[cf](?:-sequence)?$/.test(mime) ||
    /\.(heic|heif)$/i.test(file.name)
  );
}
export const PXZ_MIME = "application/pxz";
/** @param {{name: string, mime_type: string} | null | undefined} file */
export function isPxzFile(file) {
  return (
    !!file &&
    (/\.pxz$/i.test(file.name) ||
      /^(application|image)\/pxz(?:\s*;|$)/i.test(file.mime_type.trim()))
  );
}
// A camera's "48 MP" HEIC can be 8064×6048 (48,771,072 pixels).
export const HEIC_MAX_PIXELS = 50_000_000;
export function validateHeicDimensions(width, height) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  )
    throw new Error("heic-decode-failed");
  if (width * height > HEIC_MAX_PIXELS || Math.max(width, height) > 20000)
    throw new Error("heic-too-large");
}
/** @param {{name: string, mime_type: string} | null | undefined} file */
export function isImageFile(file) {
  return (
    !!file &&
    !isPxzFile(file) &&
    (file.mime_type.toLowerCase().startsWith("image/") || isHeicFile(file))
  );
}
/** @param {{name: string, mime_type: string}} file */
export function imageMimeType(file) {
  if (isPxzFile(file)) return PXZ_MIME;
  return isHeicFile(file)
    ? "image/heic"
    : file.mime_type.split(";")[0].trim().toLowerCase();
}

/** @param {{name: string, mime_type: string}} file */
export function imageSaveFormat(file) {
  const mime = imageMimeType(file);
  if (mime === "image/jpeg" || mime === "image/jpg")
    return { format: "jpeg", convertsToPng: false };
  if (mime === "image/webp") return { format: "webp", convertsToPng: false };
  return { format: "png", convertsToPng: mime !== "image/png" };
}

export const IMAGE_EDIT_MAX_BYTES = 64 * 1024 * 1024;
export const IMAGE_EXPORT_MAX_PIXELS = 24_000_000;

/** @param {Uint8Array} data @param {"png"|"jpeg"|"webp"} format */
export function matchesEncodedImage(data, format) {
  if (format === "jpeg")
    return (
      data.length > 4 &&
      data[0] === 255 &&
      data[1] === 216 &&
      data.at(-2) === 255 &&
      data.at(-1) === 217
    );
  const header = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (format === "png")
    return (
      data.length >= 33 &&
      header.getUint32(0) === 0x89504e47 &&
      header.getUint32(4) === 0x0d0a1a0a &&
      header.getUint32(12) === 0x49484452
    );
  return (
    data.length > 16 &&
    header.getUint32(0) === 0x52494646 &&
    header.getUint32(4, true) + 8 === data.length &&
    header.getUint32(8) === 0x57454250
  );
}
