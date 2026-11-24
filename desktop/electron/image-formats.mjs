/** @param {{name: string, mime_type: string} | null | undefined} file */
export function isHeicFile(file) {
  if (!file) return false;
  const mime = file.mime_type.split(";")[0].trim().toLowerCase();
  return (
    /^image\/hei[cf](?:-sequence)?$/.test(mime) ||
    /\.(heic|heif)$/i.test(file.name)
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
    (file.mime_type.toLowerCase().startsWith("image/") || isHeicFile(file))
  );
}
/** @param {{name: string, mime_type: string}} file */
export function imageMimeType(file) {
  return isHeicFile(file)
    ? "image/heic"
    : file.mime_type.split(";")[0].trim().toLowerCase();
}
