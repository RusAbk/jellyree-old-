import test from "node:test";
import assert from "node:assert/strict";
import { createPreviewQueue, videoDuration } from "../src/video-preview.ts";

test("video preview queue limits decoders, preserves order and releases failures", async () => {
  const run = createPreviewQueue(2);
  const started = [],
    release = [];
  let active = 0,
    peak = 0;
  const jobs = Array.from({ length: 6 }, (_, index) =>
    run(async () => {
      started.push(index);
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => {
        release[index] = resolve;
      });
      active--;
      if (index === 1) throw new Error("unsupported codec");
      return index;
    }),
  );
  const results = Promise.allSettled(jobs);
  await new Promise(setImmediate);
  assert.deepEqual(started, [0, 1]);
  for (let index = 0; index < jobs.length; index++) {
    release[index]();
    await new Promise(setImmediate);
    assert.ok(active <= 2);
  }
  assert.equal(peak, 2);
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(
    (await results).map((r) => r.status),
    [
      "fulfilled",
      "rejected",
      "fulfilled",
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ],
  );
  assert.equal(await run(async () => "still works"), "still works");
});

test("duration labels handle short videos, hours and unknown metadata", () => {
  for (const [seconds, label] of [
    [0, "0:00"],
    [2.9, "0:02"],
    [65, "1:05"],
    [3661, "1:01:01"],
    [Infinity, ""],
    [NaN, ""],
    [-1, ""],
  ]) {
    assert.equal(videoDuration(seconds), label);
  }
});
