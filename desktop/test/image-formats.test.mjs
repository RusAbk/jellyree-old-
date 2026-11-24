import test from "node:test";
import assert from "node:assert/strict";
import {
  isHeicFile,
  isImageFile,
  imageMimeType,
  validateHeicDimensions,
} from "../electron/image-formats.mjs";
test("HEIC dimensions accept camera 48 MP photos while bounding decoded memory", () => {
  assert.doesNotThrow(() => validateHeicDimensions(8064, 6048));
  assert.doesNotThrow(() => validateHeicDimensions(6048, 8064));
  assert.throws(() => validateHeicDimensions(10000, 10000), /heic-too-large/);
  assert.throws(() => validateHeicDimensions(25000, 1), /heic-too-large/);
  for (const width of [0, -1, NaN, Infinity, 10.5])
    assert.throws(
      () => validateHeicDimensions(width, 640),
      /heic-decode-failed/,
    );
});
import { thumbnailRevision } from "../src/thumbnail.ts";
test("HEIC and HEIF are recognized by MIME or extension, including imported generic objects", () => {
  for (const [name, mime_type] of [
    ["photo.HEIC", "application/octet-stream"],
    ["photo.HeIf", "application/octet-stream"],
    ["object", "IMAGE/HEIC; charset=binary"],
    ["object", "image/heif-sequence"],
  ]) {
    const file = { name, mime_type };
    assert.equal(isHeicFile(file), true);
    assert.equal(isImageFile(file), true);
    assert.equal(imageMimeType(file), "image/heic");
  }
  for (const [name, mime_type] of [
    ["photo.avif", "image/avif"],
    ["photo.jpg", "image/jpeg"],
    ["photo.heic.txt", "text/plain"],
    ["movie.mp4", "video/mp4"],
  ])
    assert.equal(isHeicFile({ name, mime_type }), false);
  assert.equal(isImageFile(null), false);
  assert.equal(isHeicFile(undefined), false);
});
test("generic HEIC thumbnail revisions retain edits and use a consistent image cache key", () => {
  const file = {
    id: "legacy",
    name: "IMG.HEIC",
    object_key: "private/heic",
    mime_type: "application/octet-stream",
    size_bytes: 100,
    adjustments: { rotate: 90 },
  };
  const revision = thumbnailRevision(file);
  assert.equal(revision.mimeType, "image/heic");
  assert.equal(revision.adjustments.rotate, 90);
  assert.deepEqual(
    thumbnailRevision({ ...file, mime_type: "image/heic" }),
    revision,
  );
});
