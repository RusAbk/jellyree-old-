import test from "node:test";
import assert from "node:assert/strict";
import {
  useUploadJobs,
  uploadPercent,
  uploadSummary,
} from "../src/use-upload-jobs.ts";

test("background uploads keep independent progress/results, capture destinations and show requested upload/conflict panels", async () => {
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
    true,
    "adding an upload opens the nonblocking panel",
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
    "the user can hide the panel during a transfer",
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
  assert.equal(state.conflictOpen.value, true);
  assert.equal(state.panelOpen.value, true);
  state.resolveConflict("stale");
  assert.equal(state.conflict.value.id, "question");
  state.resolveConflict("question");
  state.panelOpen.value = false;
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
    state.jobs.value.filter((job) => !job.cleared).map((job) => job.id),
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
  assert.equal(state.panelOpen.value, true);
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

test("confirmed cancellation moves an active file to history and ignores late upload progress", async () => {
  const batch = Promise.withResolvers();
  const state = useUploadJobs(
    { pickUpload: () => batch.promise, cancelUpload: async () => true },
    () => {},
  );
  const upload = state.start(false, undefined, null, "");
  const [job] = state.jobs.value;
  const progress = {
    kind: "upload",
    jobId: job.id,
    fileIndex: 0,
    fileState: "uploading",
    name: "large.mp4",
    done: 0,
    total: 2,
    loaded: 30,
  };
  state.onProgress(progress);
  await state.cancel(job.id, 0);
  assert.equal(job.files[0].state, "canceled");
  state.onProgress(progress);
  assert.equal(job.files[0].state, "canceled");
  assert.equal(state.pending.value, 1);
  batch.resolve({ done: 1, failures: [], canceledFiles: [0] });
  await upload;
  assert.equal(job.files[0].state, "canceled");
});

test("finished file rows appear before their batch ends; overall progress survives history cleanup", async () => {
  const resolve = [];
  const state = useUploadJobs(
    { pickUpload: () => new Promise((done) => resolve.push(done)) },
    () => {},
  );
  const first = state.start(false, undefined, null, "");
  const second = state.start(false, undefined, "album", "Album");
  const [a, b] = state.jobs.value;
  state.onProgress({
    kind: "upload",
    jobId: a.id,
    fileIndex: 0,
    fileState: "uploaded",
    name: "first.jpg",
    done: 1,
    total: 2,
    loaded: 50,
    totalBytes: 100,
  });
  state.onProgress({
    kind: "upload",
    jobId: b.id,
    phase: "preparing",
    done: 0,
    total: 1,
    loaded: 0,
    totalBytes: 100,
  });
  assert.equal(a.files[0].name, "first.jpg");
  assert.equal(a.files[0].state, "uploaded");
  assert.equal(state.hasFinished.value, true);
  assert.equal(uploadSummary(state.jobs.value).percent, 25);
  state.onProgress({
    kind: "upload",
    jobId: a.id,
    fileIndex: 1,
    fileState: "uploaded",
    name: "second.jpg",
    done: 2,
    total: 2,
    loaded: 100,
    totalBytes: 100,
  });
  resolve[0]({ done: 2, failures: [] });
  await first;
  assert.equal(uploadSummary(state.jobs.value).percent, 50);
  state.clearFinished();
  assert.equal(
    uploadSummary(state.jobs.value).percent,
    50,
    "clearing history cannot reset an active wave's progress",
  );
  state.onProgress({
    kind: "upload",
    jobId: b.id,
    name: "third.jpg",
    fileIndex: 0,
    fileState: "uploaded",
    done: 1,
    total: 1,
    loaded: 100,
    totalBytes: 100,
  });
  resolve[1]({ done: 1, failures: [] });
  await second;
  assert.equal(uploadSummary(state.jobs.value).percent, 100);
  const third = state.start(false, undefined, null, "");
  assert.equal(
    uploadSummary(state.jobs.value).percent,
    0,
    "a new wave starts its own overall progress",
  );
  resolve[2]({ done: 0, canceled: true, failures: [] });
  await third;
});
