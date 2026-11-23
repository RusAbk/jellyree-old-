export type LiquifyStroke = {
  x: number;
  y: number;
  dx: number;
  dy: number;
  radius: number;
  strength: number;
};
export type ImageAdjustments = {
  brightness: number;
  contrast: number;
  saturation: number;
  exposure: number;
  toneDepth: number;
  shadows: number;
  highlights: number;
  temperature: number;
  tint: number;
  vibrance: number;
  sharpness: number;
  clarity: number;
  definition: number;
  glamour: number;
  grain: number;
  vignette: number;
  grayscale: number;
  sepia: number;
  fade: number;
  rotate: number;
  cropZoom: number;
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
  flipX: boolean;
  flipY: boolean;
  stretchAxis: "x" | "y";
  stretchAmount: number;
  stretchStart: number;
  stretchEnd: number;
  strokes: LiquifyStroke[];
};
export const adjustmentRanges: Record<
  Exclude<
    keyof ImageAdjustments,
    "flipX" | "flipY" | "stretchAxis" | "strokes"
  >,
  [number, number, number]
>;
export function normalizeImageAdjustments(
  input?: Partial<ImageAdjustments>,
): ImageAdjustments;
export const defaultImageAdjustments: Readonly<ImageAdjustments>;
export function needsImageProcessing(
  input?: Partial<ImageAdjustments>,
): boolean;
export function imageBounds(
  width: number,
  height: number,
  input?: Partial<ImageAdjustments>,
  uncropped?: boolean,
): { fullWidth: number; fullHeight: number; width: number; height: number };
