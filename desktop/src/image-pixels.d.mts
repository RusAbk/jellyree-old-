import type { ImageAdjustments } from "../electron/image-adjustments.mjs";
export function adjustPixels(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  adjustments: ImageAdjustments,
): Uint8ClampedArray;
export function warpPixels(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  adjustments: ImageAdjustments,
): Uint8ClampedArray;
export function stretchCoordinate(
  value: number,
  start: number,
  end: number,
  amount: number,
): number;
export function stretchMapping(
  start: number,
  end: number,
  amount: number,
): {
  toSource(value: number): number;
  toDisplay(value: number): number;
};
export type Histogram = { bins: number[]; shadows: number; highlights: number };
export function imageHistogram(data: Uint8ClampedArray): Histogram;
