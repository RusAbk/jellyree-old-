import { computed, reactive, ref } from "vue";
import type { Jellyree, Progress, UploadConflict, UploadResult } from "./types";

export type UploadJob = {
  id: string;
  wave: number;
  cleared?: boolean;
  files: {
    index: number;
    name: string;
    state: NonNullable<Progress["fileState"]> | "waiting" | "canceling";
    loadedBytes?: number;
    sizeBytes?: number;
    destination?: string;
    error?: string;
  }[];
  folders: boolean;
  names: string[];
  destination: string;
  state:
    | "selecting"
    | "queued"
    | "preparing"
    | "uploading"
    | "waiting"
    | "complete"
    | "issues"
    | "failed"
    | "canceled";
  progress?: Progress;
  result?: UploadResult;
  error?: string;
};
export const uploadFinished = (job: UploadJob) =>
  ["complete", "issues", "failed", "canceled"].includes(job.state);
const finished = uploadFinished;
export const uploadFileFinished = (file: UploadJob["files"][number]) =>
  ["uploaded", "skipped", "failed", "canceled"].includes(file.state);
export function uploadSummary(jobs: UploadJob[]) {
  const wave = Math.max(0, ...jobs.map((job) => job.wave));
  const current = jobs.filter((job) => job.wave === wave);
  let total = 0,
    done = 0,
    loaded = 0,
    totalBytes = 0,
    indeterminate = false;
  for (const job of current) {
    const p = job.progress;
    total +=
      p?.total ??
      (job.names.length ||
        (job.result
          ? job.result.done +
            (job.result.skipped || 0) +
            job.result.failures.length
          : 0));
    done +=
      p?.done ??
      (job.result
        ? job.result.done +
          (job.result.skipped || 0) +
          job.result.failures.length
        : 0);
    loaded += p?.loaded || 0;
    totalBytes += p?.totalBytes || 0;
    if (!finished(job) && p?.total === undefined) indeterminate = true;
  }
  const percent = uploadPercent({
    kind: "upload",
    done,
    total,
    loaded,
    totalBytes,
  });
  return { total, done, loaded, totalBytes, percent, indeterminate };
}
export function uploadPercent(progress?: Progress) {
  if (!progress) return 0;
  const value = progress.totalBytes
    ? (progress.loaded || 0) / progress.totalBytes
    : progress.total
      ? progress.done / progress.total
      : 0;
  return Math.max(0, Math.min(100, Math.round(value * 100)));
}
export function useUploadJobs(
  bridge: Pick<
    Jellyree,
    "pickUpload" | "dropUpload" | "retryUpload" | "cancelUpload"
  >,
  refresh: () => void,
) {
  const jobs = ref<UploadJob[]>([]);
  const panelOpen = ref(false);
  const conflict = ref<UploadConflict | null>(null);
  const conflictOpen = ref(false);
  const retrying = ref(new Set<string>());
  let wave = 0;
  const pending = computed(
    () => jobs.value.filter((job) => !finished(job)).length,
  );
  const hasFinished = computed(() =>
    jobs.value.some(
      (job) =>
        (!job.cleared && finished(job)) || job.files.some(uploadFileFinished),
    ),
  );
  const issues = computed(
    () =>
      jobs.value.filter(
        (job) =>
          !job.cleared &&
          (["issues", "failed"].includes(job.state) ||
            job.files.some((file) => file.state === "failed")),
      ).length,
  );
  const running = computed(() =>
    jobs.value.find((job) => job.state === "uploading"),
  );
  const findJob = (id?: string) =>
    id
      ? jobs.value.find((job) => job.id === id)
      : jobs.value.find((job) => !finished(job));
  function start(
    folders: boolean,
    files: File[] | undefined,
    folderId: string | null,
    destination: string,
  ) {
    return run(
      folders,
      files?.map((file) => file.name) ?? [],
      destination,
      files ? "queued" : "selecting",
      (id) =>
        files
          ? bridge.dropUpload(files, folderId, id)
          : bridge.pickUpload(folderId, folders, id),
    );
  }
  async function run(
    folders: boolean,
    names: string[],
    destination: string,
    state: "selecting" | "queued",
    upload: (id: string) => Promise<UploadResult>,
  ) {
    if (!pending.value) {
      wave++;
      jobs.value = jobs.value.filter((job) => !job.cleared);
    }
    const job = reactive<UploadJob>({
      id: crypto.randomUUID(),
      wave,
      files: [],
      folders,
      names,
      destination,
      state,
    });
    jobs.value.push(job);
    panelOpen.value = true;
    try {
      const result = await upload(job.id);
      job.result = result;
      job.state = result.canceled
        ? "canceled"
        : result.failures.length || result.warnings?.length
          ? "issues"
          : "complete";
      const canceledFiles = new Set(result.canceledFiles);
      for (const file of job.files.filter((file) => !uploadFileFinished(file)))
        file.state =
          (result.canceled && !result.canceledFiles) ||
          canceledFiles.has(file.index)
            ? "canceled"
            : result.failures.some((failure) =>
                  failure.fileIndex === undefined
                    ? failure.name === file.name
                    : failure.fileIndex === file.index,
                )
              ? "failed"
              : "uploaded";
      const rows = new Map(job.files.map((file) => [file.index, file]));
      for (const failure of result.failures) {
        if (failure.fileIndex === undefined) continue;
        const failed = {
          index: failure.fileIndex,
          name: failure.name,
          state: "failed" as const,
          destination: failure.targetPath,
          sizeBytes: failure.sizeBytes,
          error: failure.message,
        };
        const existing = rows.get(failed.index);
        if (existing) Object.assign(existing, failed);
        else job.files.push(failed);
      }
      job.files.sort((a, b) => a.index - b.index);
      return result;
    } catch (error) {
      job.error = (error as Error).message;
      job.state = "failed";
      for (const file of job.files.filter((file) => !uploadFileFinished(file)))
        file.state = "failed";
    } finally {
      if (conflict.value && findJob(conflict.value.jobId)?.id === job.id) {
        conflict.value = null;
        conflictOpen.value = false;
      }
      if (jobs.value.includes(job)) refresh();
    }
  }
  async function retry(jobId: string, retryId?: string) {
    const job = findJob(jobId);
    if (!job?.result || !finished(job) || job.cleared) return;
    const failures = job.result.failures.filter(
      (failure) => !retryId || failure.retryId === retryId,
    );
    const ids = failures.flatMap((failure) => failure.retryId ?? []);
    if (!ids.length || ids.some((id) => retrying.value.has(id))) return;
    for (const id of ids) retrying.value.add(id);
    try {
      const result = await run(
        job.folders,
        failures.map((failure) => failure.name),
        job.destination,
        "queued",
        (id) => bridge.retryUpload(ids, id),
      );
      if (!result) return;
      const handled = new Set([
        ...(result.resolvedRetryIds ?? []),
        ...result.failures.flatMap((failure) => failure.retryId ?? []),
      ]);
      const indices = new Set(
        failures
          .filter((failure) => failure.retryId && handled.has(failure.retryId))
          .map((failure) => failure.fileIndex),
      );
      job.files = job.files.filter((file) => !indices.has(file.index));
      job.result.failures = job.result.failures.filter(
        (failure) => !failure.retryId || !handled.has(failure.retryId),
      );
      if (
        job.state === "issues" &&
        !job.result.failures.length &&
        !job.result.warnings?.length
      ) {
        if (job.files.length || job.result.done || job.result.skipped)
          job.state = "complete";
        else job.cleared = true;
      }
    } finally {
      for (const id of ids) retrying.value.delete(id);
    }
  }
  function onProgress(value: Progress) {
    const job = findJob(value.jobId);
    if (!job || finished(job)) return;
    const { queuedFiles, ...progress } = value;
    job.progress = { ...job.progress, ...progress };
    if (queuedFiles)
      job.files = queuedFiles.map(
        ({ fileIndex, name, sizeBytes, targetPath }) => ({
          index: fileIndex,
          name,
          sizeBytes,
          destination: targetPath,
          state: "queued",
        }),
      );
    if (value.name) {
      const index = value.fileIndex ?? value.done;
      let file =
        job.files[index]?.index === index
          ? job.files[index]
          : job.files.find((entry) => entry.index === index);
      if (!file) {
        file = { index, name: value.name, state: "uploading" };
        job.files.push(file);
      }
      const state = value.fileState || "uploading";
      if (!uploadFileFinished(file) || file.state === state)
        Object.assign(file, {
          name: value.name,
          state:
            file.state === "canceling" && state === "uploading"
              ? "canceling"
              : state,
          loadedBytes: value.fileLoaded ?? file.loadedBytes,
          sizeBytes: value.sizeBytes,
          destination: value.targetPath,
          error: value.message,
        });
    }
    if (
      value.fileState === "canceled" &&
      conflict.value?.jobId === job.id &&
      conflict.value.fileIndex === value.fileIndex
    )
      resolveConflict(conflict.value.id);
    if (job.state !== "waiting") job.state = value.phase || "uploading";
  }
  async function cancel(jobId: string, index: number) {
    const job = findJob(jobId);
    const file = job?.files.find((entry) => entry.index === index);
    if (
      !file ||
      (file.state !== "queued" &&
        file.state !== "uploading" &&
        file.state !== "waiting")
    )
      return;
    const previous = file.state;
    file.state = "canceling";
    try {
      const accepted = await bridge.cancelUpload(jobId, index);
      if (file.state === "canceling") {
        file.state = accepted ? "canceled" : previous;
      }
      if (
        accepted &&
        conflict.value?.jobId === jobId &&
        conflict.value.fileIndex === index
      )
        resolveConflict(conflict.value.id);
    } catch (error) {
      if (file.state === "canceling") file.state = previous;
      file.error = (error as Error).message;
    }
  }
  function onConflict(value: UploadConflict) {
    const job = findJob(value.jobId);
    const file = job?.files.find((entry) => entry.index === value.fileIndex);
    if ((job && finished(job)) || (file && uploadFileFinished(file))) return;
    conflict.value = { ...value, jobId: job?.id || value.jobId };
    if (job) job.state = "waiting";
    if (file?.state === "queued") file.state = "waiting";
    panelOpen.value = true;
    conflictOpen.value = true;
  }
  function resolveConflict(id: string) {
    if (conflict.value?.id !== id) return;
    const job = findJob(conflict.value.jobId);
    if (job && !finished(job)) job.state = "uploading";
    const file = job?.files.find(
      (entry) => entry.index === conflict.value?.fileIndex,
    );
    if (file?.state === "waiting") file.state = "queued";
    conflict.value = null;
    conflictOpen.value = false;
  }
  function clearFinished() {
    if (!pending.value) jobs.value = jobs.value.filter((job) => !finished(job));
    else
      for (const job of jobs.value) {
        if (finished(job)) job.cleared = true;
        job.files = job.files.filter(
          (file) => !uploadFileFinished(file) || file.state === "failed",
        );
      }
  }
  function reset() {
    jobs.value = [];
    retrying.value.clear();
    panelOpen.value = false;
    conflict.value = null;
    conflictOpen.value = false;
  }
  return {
    jobs,
    panelOpen,
    pending,
    hasFinished,
    issues,
    running,
    conflict,
    conflictOpen,
    start,
    retry,
    retrying,
    reset,
    onProgress,
    onConflict,
    resolveConflict,
    clearFinished,
    cancel,
  };
}
