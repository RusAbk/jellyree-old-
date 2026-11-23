import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  validateVideoFrame,
  videoFrameName,
} from "../electron/video-frames.mjs";
import {
  playbackSpeed,
  playbackSpeeds,
  framePosition,
} from "../src/video-player.ts";
import { ThumbnailMedia } from "../electron/thumbnail-media.mjs";
test("frame metadata validates PNG bytes, dimensions and time without accepting other formats", async () => {
  const png = new Uint8Array(
    await readFile(new URL("fixtures/editor.png", import.meta.url)),
  );
  assert.deepEqual(validateVideoFrame(png, 1.25), { width: 600, height: 400 });
  for (const time of [NaN, Infinity, -1])
    assert.throws(() => validateVideoFrame(png, time));
  assert.throws(() => validateVideoFrame(new Uint8Array([1, 2, 3]), 0));
  const invalid = png.slice();
  invalid[0] = 0;
  assert.throws(() => validateVideoFrame(invalid, 0));
  const large = Buffer.from(png);
  large.writeUInt32BE(20000, 16);
  large.writeUInt32BE(20000, 20);
  assert.throws(() => validateVideoFrame(large, 0));
});
test("frame filenames preserve time and extension, fit filename limits and allow unique copies", () => {
  assert.equal(
    videoFrameName("Holiday.mp4", 3661.25),
    "Holiday-frame-01-01-01.250.png",
  );
  assert.equal(
    videoFrameName("Holiday.mp4", 0, 1),
    "Holiday-frame-00-00-00.000 (1).png",
  );
  const name = videoFrameName("x".repeat(255) + ".mp4", 1, 20);
  assert.equal(name.length, 255);
  assert.ok(name.endsWith(" (20).png"));
  const unicode = videoFrameName("😀".repeat(150) + ".mp4", 1);
  assert.equal(Buffer.from(unicode).toString("utf8"), unicode);
  assert.ok(!/[<>:"/\\|?*]/.test(videoFrameName("bad:name?.mp4", 0)));
  assert.throws(() => videoFrameName("file.mp4", NaN));
  assert.equal(framePosition(3661.25), "1:01:01.250");
  for (const value of playbackSpeeds) assert.equal(playbackSpeed(value), value);
  assert.equal(playbackSpeed("1.75"), 1.75);
  for (const value of [NaN, "bad", 0, 100])
    assert.equal(playbackSpeed(value), 1);
});
test("long playback resolves fresh signed URLs for later range requests", async () => {
  let now = 100,
    signed = 0;
  const targets = [];
  const media = new ThumbnailMedia(
    async (url) => {
      targets.push(url);
      return new Response(new Uint8Array([1]));
    },
    { now: () => now },
  );
  const url = media.create(
    async () => `https://private.invalid/video?signature=${++signed}`,
  );
  await media.handle(new Request(url, { headers: { Range: "bytes=0-1" } }));
  now += 70 * 60 * 1000;
  assert.equal(
    (await media.handle(new Request(url, { headers: { Range: "bytes=100-" } })))
      .status,
    200,
  );
  assert.deepEqual(targets, [
    "https://private.invalid/video?signature=1",
    "https://private.invalid/video?signature=2",
  ]);
  media.clear();
  assert.equal((await media.handle(new Request(url))).status, 404);
});
