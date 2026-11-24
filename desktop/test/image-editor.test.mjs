import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeImageAdjustments as normalize,
  needsImageProcessing,
  imageBounds,
} from "../electron/image-adjustments.mjs";
import {
  adjustPixels,
  warpPixels,
  stretchCoordinate,
  stretchMapping,
  imageHistogram,
} from "../src/image-pixels.mjs";
import {
  fitCrop,
  smartAuto,
  resetColorAndTone,
} from "../src/image-editor-model.ts";
import { dragCrop, dragStretch } from "../src/image-geometry.ts";

test("desktop edit documents preserve old defaults and validate geometry, brush and scalar bounds", () => {
  const old = normalize({ brightness: 120, rotate: 90 });
  assert.equal(old.brightness, 120);
  assert.equal(old.exposure, 0);
  assert.equal(old.flipX, false);
  assert.equal(needsImageProcessing(old), false);
  assert.equal(needsImageProcessing({ tint: 4 }), true);
  for (const value of [
    { brightness: NaN },
    { exposure: Infinity },
    { cropX: 0.7, cropWidth: 0.4 },
    { cropHeight: 0 },
    { flipX: 1 },
    { stretchStart: 0.8, stretchEnd: 0.7 },
    { strokes: new Array(129).fill({}) },
    { strokes: [{ x: 0.5, y: 0.5, dx: NaN, dy: 0, radius: 0.1, strength: 1 }] },
  ])
    assert.throws(() => normalize(value));
  assert.deepEqual(imageBounds(600, 400, { rotate: 90, cropWidth: 0.5 }), {
    fullWidth: 400,
    fullHeight: 600,
    width: 200,
    height: 600,
  });
});

test("color pipeline is identity at defaults, preserves alpha and produces real color/tone changes", () => {
  const source = new Uint8ClampedArray([
    30, 90, 160, 255, 240, 200, 90, 80, 0, 0, 0, 0,
  ]);
  assert.deepEqual(adjustPixels(source, 3, 1, normalize()), source);
  const warm = adjustPixels(source, 3, 1, normalize({ temperature: 80 }));
  assert.ok(warm[0] > source[0]);
  assert.ok(warm[2] < source[2]);
  const mono = adjustPixels(source, 3, 1, normalize({ grayscale: 100 }));
  assert.equal(mono[0], mono[1]);
  assert.equal(mono[1], mono[2]);
  assert.equal(mono[7], 80);
  assert.equal(mono[11], 0);
  assert.ok(
    adjustPixels(source, 3, 1, normalize({ exposure: 50 }))[0] > source[0],
  );
  for (const values of [
    { sharpness: 70 },
    { clarity: -50 },
    { definition: 40 },
    { glamour: 60 },
    { grain: 30 },
    { vignette: 80 },
    { sepia: 70 },
    { shadows: 80 },
    { highlights: -60 },
    { toneDepth: 40 },
    { tint: 50 },
    { vibrance: 90 },
    { fade: 70 },
  ]) {
    const result = adjustPixels(source, 3, 1, normalize(values));
    assert.notDeepEqual(result, source, JSON.stringify(values));
    assert.equal(result[7], source[7]);
  }
});

test("crop grips reach the canvas boundary without moving the opposite corner", () => {
  const image = { width: 400, height: 600 };
  const rect = { x: 0.15, y: 0.1, width: 0.6, height: 0.4 };
  const start = { x: 0.762, y: 0.513 };
  const free = dragCrop("se", rect, start, { x: 1, y: 1 }, image);
  assert.ok(Math.abs(free.y - rect.y) < 1e-10);
  assert.equal(free.x, rect.x);
  assert.equal(free.x + free.width, 1);
  assert.equal(free.y + free.height, 1);
  const locked = dragCrop("se", rect, start, { x: 1, y: 0.53 }, image, 1);
  assert.deepEqual(locked, { ...rect, width: 0.85, height: 0.85 / 1.5 });
  const otherCorner = dragCrop(
    "nw",
    rect,
    { x: 0.14, y: 0.09 },
    { x: 0, y: 0 },
    image,
    1,
  );
  assert.equal(otherCorner.x + otherCorner.width, 0.75);
  assert.ok(Math.abs(otherCorner.y + otherCorner.height - 0.5) < 1e-10);
  assert.equal(
    otherCorner.width * image.width,
    otherCorner.height * image.height,
  );
});

test("stretch maps a picked band through the current deformation on either axis", () => {
  for (const [start, end, amount] of [
    [0.16, 0.41, 70],
    [0.82, 1, -60],
    [0, 0.3, 85],
  ]) {
    const map = stretchMapping(start, end, amount);
    for (const coordinate of [0, 0.08, start, (start + end) / 2, end, 0.92, 1])
      assert.ok(
        Math.abs(map.toSource(map.toDisplay(coordinate)) - coordinate) < 1e-10,
      );
  }
  const map = stretchMapping(0.2, 0.5, 60);
  const picked = dragStretch(
    "stretch-new",
    { start: 0.2, end: 0.5 },
    map.toSource(0.8),
    map.toSource(0.66),
  );
  assert.ok(Math.abs(map.toDisplay(picked.start) - 0.66) < 1e-10);
  assert.ok(Math.abs(map.toDisplay(picked.end) - 0.8) < 1e-10);
  assert.deepEqual(
    dragStretch("stretch-move", { start: 0.2, end: 0.45 }, 0.3, 1),
    { start: 0.75, end: 1 },
  );
});

test("liquify and stretch move pixels while retaining dimensions and fixed image edges", () => {
  const pixels = new Uint8ClampedArray(20 * 20 * 4);
  for (let y = 0; y < 20; y++)
    for (let x = 0; x < 20; x++)
      pixels.set([x * 12, y * 12, 120, 255], (y * 20 + x) * 4);
  assert.equal(warpPixels(pixels, 20, 20, normalize()), pixels);
  const moved = warpPixels(
    pixels,
    20,
    20,
    normalize({
      strokes: [{ x: 0.5, y: 0.5, dx: 0.15, dy: 0, radius: 0.3, strength: 1 }],
    }),
  );
  assert.ok(moved[(10 * 20 + 10) * 4] < pixels[(10 * 20 + 10) * 4]);
  assert.deepEqual(moved.slice(0, 4), pixels.slice(0, 4));
  for (const amount of [-85, 85]) {
    assert.equal(stretchCoordinate(0, 0.3, 0.7, amount), 0);
    assert.equal(stretchCoordinate(1, 0.3, 0.7, amount), 1);
    let previous = 0;
    for (let n = 0; n <= 100; n++) {
      const value = stretchCoordinate(n / 100, 0.3, 0.7, amount);
      assert.ok(value >= previous);
      previous = value;
    }
    assert.notDeepEqual(
      warpPixels(pixels, 20, 20, normalize({ stretchAmount: amount })),
      pixels,
    );
  }
  assert.equal(stretchCoordinate(0.5, 0, 1, 80), 0.5);
});

test("histograms ignore transparent pixels and smart auto responds to dark images", () => {
  const histogram = imageHistogram(
    new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0]),
  );
  assert.equal(histogram.shadows, 50);
  assert.equal(histogram.highlights, 50);
  assert.equal(histogram.bins.length, 64);
  const dark = imageHistogram(new Uint8ClampedArray([10, 10, 10, 255]));
  assert.ok(smartAuto(dark, normalize()).exposure > 0);
  const fitted = fitCrop(normalize({ rotate: 90 }), 1, 400, 600);
  assert.equal(fitted.cropWidth * 400, fitted.cropHeight * 600);
  const reset = resetColorAndTone(
    normalize({ temperature: 70, cropX: 0.2, cropWidth: 0.5 }),
    { contrast: 110 },
  );
  assert.equal(reset.temperature, 0);
  assert.equal(reset.contrast, 110);
  assert.equal(reset.cropX, 0.2);
});
