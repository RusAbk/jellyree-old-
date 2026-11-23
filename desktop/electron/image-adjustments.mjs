// Desktop's edit document. Geometry is normalized so edits can be reused at any resolution.
export const adjustmentRanges = {
  brightness: [0, 200, 100],
  contrast: [0, 200, 100],
  saturation: [0, 200, 100],
  exposure: [-100, 100, 0],
  toneDepth: [-100, 100, 0],
  shadows: [-100, 100, 0],
  highlights: [-100, 100, 0],
  temperature: [-100, 100, 0],
  tint: [-100, 100, 0],
  vibrance: [-100, 100, 0],
  sharpness: [0, 100, 0],
  clarity: [-100, 100, 0],
  definition: [-100, 100, 0],
  glamour: [0, 100, 0],
  grain: [0, 100, 0],
  vignette: [0, 100, 0],
  grayscale: [0, 100, 0],
  sepia: [0, 100, 0],
  fade: [0, 100, 0],
  rotate: [-180, 180, 0],
  cropZoom: [0, 60, 0],
  cropX: [0, 1, 0],
  cropY: [0, 1, 0],
  cropWidth: [0.02, 1, 1],
  cropHeight: [0.02, 1, 1],
  stretchAmount: [-85, 85, 0],
  stretchStart: [0, 0.98, 0.3],
  stretchEnd: [0.02, 1, 0.7],
};
function numeric(value, min, max) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new Error("Invalid image adjustments");
  return value;
}
export function normalizeImageAdjustments(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid image adjustments");
  const result = Object.fromEntries(
    Object.entries(adjustmentRanges).map(([key, [min, max, fallback]]) => [
      key,
      numeric(input[key] ?? fallback, min, max),
    ]),
  );
  for (const key of ["flipX", "flipY"]) {
    if (input[key] !== undefined && typeof input[key] !== "boolean")
      throw new Error("Invalid image adjustments");
    result[key] = input[key] ?? false;
  }
  result.stretchAxis = input.stretchAxis ?? "y";
  if (
    !["x", "y"].includes(result.stretchAxis) ||
    result.stretchEnd - result.stretchStart < 0.02 - 1e-8 ||
    result.cropX + result.cropWidth > 1 + 1e-8 ||
    result.cropY + result.cropHeight > 1 + 1e-8
  )
    throw new Error("Invalid image adjustments");
  if (
    input.strokes !== undefined &&
    (!Array.isArray(input.strokes) || input.strokes.length > 128)
  )
    throw new Error("Invalid image adjustments");
  result.strokes = (input.strokes || []).map((stroke) => {
    if (!stroke || typeof stroke !== "object")
      throw new Error("Invalid image adjustments");
    return {
      x: numeric(stroke.x, 0, 1),
      y: numeric(stroke.y, 0, 1),
      dx: numeric(stroke.dx, -1, 1),
      dy: numeric(stroke.dy, -1, 1),
      radius: numeric(stroke.radius, 0.02, 0.6),
      strength: numeric(stroke.strength, 0, 1),
    };
  });
  return result;
}
export const defaultImageAdjustments = Object.freeze(
  normalizeImageAdjustments(),
);
export function needsImageProcessing(input = {}) {
  const a = normalizeImageAdjustments(input);
  return Object.keys(a).some(
    (key) =>
      !["brightness", "contrast", "saturation", "rotate"].includes(key) &&
      JSON.stringify(a[key]) !== JSON.stringify(defaultImageAdjustments[key]),
  );
}
export function imageBounds(width, height, input = {}, uncropped = false) {
  const a = normalizeImageAdjustments(input),
    angle = (a.rotate * Math.PI) / 180;
  const fullWidth = Math.max(
    1,
    Math.round(
      Math.abs(width * Math.cos(angle)) + Math.abs(height * Math.sin(angle)),
    ),
  );
  const fullHeight = Math.max(
    1,
    Math.round(
      Math.abs(height * Math.cos(angle)) + Math.abs(width * Math.sin(angle)),
    ),
  );
  const zoom = 1 + a.cropZoom / 100;
  return {
    fullWidth,
    fullHeight,
    width: uncropped
      ? fullWidth
      : Math.max(1, Math.round((fullWidth * a.cropWidth) / zoom)),
    height: uncropped
      ? fullHeight
      : Math.max(1, Math.round((fullHeight * a.cropHeight) / zoom)),
  };
}
