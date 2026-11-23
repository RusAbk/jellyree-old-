import test from "node:test";
import assert from "node:assert/strict";
import { useUploadJobs, uploadPercent } from "../src/use-upload-jobs.ts";

test("background uploads keep independent progress/results, capture destinations and defer conflict dialogs", async () => {
  const calls = [],
    resolve = [];
  let refreshed = 0;
  const bridge = {
    pickUpload(...args) {
      calls.push(args);
      return new Promise((done) => resolve.push(done));
    },
    dropUpload(...args) {
      calls.push(args);
      return new Promise((done) => resolve.push(done));
    },
  };
  const state = useUploadJobs(bridge, () => refreshed++);
  const first = state.start(false, undefined, "album-a", "Album A");
  assert.equal(
    state.panelOpen.value,
    false,
    "adding an upload keeps the browser unobstructed",
  );
  state.panelOpen.value = true;
  const files = [new File(["test"], "test.jpg")];
  const second = state.start(false, files, "album-b", "Album B");
  assert.equal(
    state.panelOpen.value,
    true,
    "adding another batch preserves the user's open panel",
  );
  state.panelOpen.value = false;
  const [a, b] = state.jobs.value;
  assert.equal(
    state.panelOpen.value,
    false,
    "adding uploads does not cover the file browser",
  );
  assert.equal(state.pending.value, 2);
  assert.equal(calls[0][0], "album-a");
  assert.equal(calls[0][2], a.id);
  assert.equal(calls[1][0], files);
  assert.equal(calls[1][1], "album-b");
  assert.equal(calls[1][2], b.id);
  state.onProgress({
    kind: "upload",
    jobId: a.id,
    phase: "uploading",
    done: 0,
    total: 2,
    loaded: 30,
    totalBytes: 100,
  });
  state.onProgress({ kind: "upload", jobId: b.id, phase: "queued", done: 0 });
  assert.equal(uploadPercent(a.progress), 30);
  assert.equal(a.state, "uploading");
  assert.equal(state.running.value.id, a.id);
  assert.equal(b.state, "queued");
  state.onConflict({ id: "question", jobId: a.id, name: "duplicate.jpg" });
  assert.equal(a.state, "waiting");
  assert.equal(state.conflictOpen.value, false);
  assert.equal(state.panelOpen.value, false);
  state.resolveConflict("stale");
  assert.equal(state.conflict.value.id, "question");
  state.resolveConflict("question");
  assert.equal(a.state, "uploading");
  resolve[0]({
    done: 1,
    skipped: 0,
    failures: [{ name: "bad.jpg", message: "network error" }],
    warnings: ["cleanup needed"],
  });
  await first;
  assert.equal(a.state, "issues");
  assert.equal(state.issues.value, 1);
  assert.equal(a.result.failures[0].name, "bad.jpg");
  assert.equal(state.pending.value, 1);
  state.clearFinished();
  assert.equal(state.issues.value, 0);
  assert.deepEqual(
    state.jobs.value.map((job) => job.id),
    [b.id],
  );
  resolve[1]({ done: 1, failures: [] });
  await second;
  assert.equal(b.state, "complete");
  assert.equal(state.pending.value, 0);
  assert.equal(state.running.value, undefined);
  assert.equal(
    state.panelOpen.value,
    false,
    "completion never opens the panel",
  );
  assert.equal(refreshed, 2);
  state.onProgress({ kind: "upload", jobId: b.id, done: 0 });
  assert.equal(
    b.state,
    "complete",
    "late progress cannot resurrect completed jobs",
  );
});

test("failed/canceled requests finish independently without throwing into UI actions", async () => {
  const state = useUploadJobs(
    {
      async pickUpload() {
        throw new Error("picker error");
      },
      async dropUpload() {
        return { done: 0, failures: [], canceled: true };
      },
    },
    () => {},
  );
  await state.start(false, undefined, null, "");
  await state.start(false, [], null, "");
  assert.deepEqual(
    state.jobs.value.map((job) => job.state),
    ["failed", "canceled"],
  );
  assert.equal(state.jobs.value[0].error, "picker error");
  assert.equal(state.issues.value, 1);
  assert.equal(state.panelOpen.value, false);
  assert.equal(state.pending.value, 0);
  state.clearFinished();
  assert.equal(state.jobs.value.length, 0);
});

test("upload progress is bounded and supports file counts without byte totals", () => {
  assert.equal(uploadPercent(), 0);
  assert.equal(uploadPercent({ done: 1, total: 4 }), 25);
  assert.equal(uploadPercent({ done: 0, loaded: 130, totalBytes: 100 }), 100);
  assert.equal(uploadPercent({ done: 0, loaded: -10, totalBytes: 100 }), 0);
});
