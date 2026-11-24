import test from "node:test";
import assert from "node:assert/strict";
import { appendGalleryRows, galleryGap } from "../src/gallery-layout.ts";

test("horizontal gallery retains file order and never resizes a committed row while paging", () => {
  const first = [
    { id: "portrait", ratio: 1 / 3 },
    { id: "panorama", ratio: 6 },
    { id: "landscape", ratio: 1.6 },
    { id: "square", ratio: 1 },
    { id: "partial", ratio: 1 },
  ];
  const extra = [
    { id: "tail", ratio: 1.1 },
    { id: "new-portrait", ratio: 0.7 },
    { id: "new-landscape", ratio: 1.8 },
  ];
  const width = 780;
  const rows = appendGalleryRows([], first, width, 150);
  const updated = appendGalleryRows(rows, extra, width, 150);
  assert.deepEqual(
    updated.flatMap(({ tiles }) => tiles.map(({ id }) => id)),
    [...first, ...extra].map(({ id }) => id),
  );
  for (const [index, row] of rows.entries()) {
    assert.equal(updated[index].height, row.height);
    assert.deepEqual(
      updated[index].tiles.slice(0, row.tiles.length),
      row.tiles,
    );
  }
  for (const { tiles, height } of updated) {
    assert.ok(height > 0);
    assert.ok(
      tiles.reduce((sum, tile) => sum + tile.width, 0) +
        (tiles.length - 1) * galleryGap <=
        width + 0.01,
    );
  }
  assert.ok(
    rows.flatMap(({ tiles }) => tiles).find(({ id }) => id === "panorama")
      .width > rows[0].tiles[0].width,
  );
});

test("appending into an open last row keeps its first card at the same width and height", () => {
  const before = appendGalleryRows([], [{ id: "one", ratio: 1 }], 500, 130);
  assert.equal(before[0].open, true);
  const after = appendGalleryRows(
    before,
    [{ id: "two", ratio: 1.5 }],
    500,
    130,
  );
  assert.equal(after.length, 1);
  assert.equal(after[0].height, 130);
  assert.deepEqual(
    after[0].tiles.map(({ width }) => width),
    [130, 195],
  );
  assert.equal(before[0].tiles.length, 1);
});
