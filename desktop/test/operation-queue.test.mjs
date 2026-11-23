import test from "node:test";
import assert from "node:assert/strict";
import { OperationQueue } from "../electron/operation-queue.mjs";

test("background batches serialize, retain their destinations and drain after a failure", async () => {
  const queue = new OperationQueue();
  const calls = [],
    release = [];
  const promises = ["album-a", "album-b", null].map((destination, index) =>
    queue.run(async () => {
      calls.push(destination);
      await new Promise((resolve) => {
        release[index] = resolve;
      });
      if (index === 1) throw new Error("upload failed");
      return destination;
    }),
  );
  const results = Promise.allSettled(promises);
  assert.equal(queue.pending, 3);
  await new Promise(setImmediate);
  assert.deepEqual(calls, ["album-a"]);
  for (let index = 0; index < 3; index++) {
    release[index]();
    await new Promise(setImmediate);
    assert.equal(queue.pending, 2 - index);
  }
  assert.deepEqual(calls, ["album-a", "album-b", null]);
  assert.deepEqual(
    (await results).map((result) => result.status),
    ["fulfilled", "rejected", "fulfilled"],
  );
  assert.equal(await queue.run(() => "another upload"), "another upload");
  assert.equal(queue.pending, 0);
});
