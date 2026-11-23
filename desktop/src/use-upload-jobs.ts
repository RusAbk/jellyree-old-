import { computed, reactive, ref } from "vue";
import type { Jellyree, Progress, UploadConflict, UploadResult } from "./types";

export type UploadJob = {
  id: string;
  wave: number;
  cleared?: boolean;
  files: {
    index: number;
    name: string;
    state: NonNullable<Progress["fileState"]>;
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
  bridge: Pick<Jellyree, "pickUpload" | "dropUpload">,
  refresh: () => void,
) {
  const jobs = ref<UploadJob[]>([]);
  const panelOpen = ref(false);
  const conflict = ref<UploadConflict | null>(null);
  const conflictOpen = ref(false);
  let wave = 0;
  const pending = computed(
    () => jobs.value.filter((job) => !finished(job)).length,
  );
  const hasFinished = computed(() =>
    jobs.value.some(
      (job) =>
        (!job.cleared && finished(job)) ||
        job.files.some((file) => file.state !== "uploading"),
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
  async function start(
    folders: boolean,
    files: File[] | undefined,
    folderId: string | null,
    destination: string,
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
      names: files?.map((file) => file.name) || [],
      destination,
      state: files ? "queued" : "selecting",
    });
    jobs.value.push(job);
    panelOpen.value = true;
    try {
      const result = await (files
        ? bridge.dropUpload(files, folderId, job.id)
        : bridge.pickUpload(folderId, folders, job.id));
      job.result = result;
      job.state = result.canceled
        ? "canceled"
        : result.failures.length || result.warnings?.length
          ? "issues"
          : "complete";
      for (const file of job.files.filter((file) => file.state === "uploading"))
        file.state = result.canceled
          ? "canceled"
          : result.failures.some((failure) => failure.name === file.name)
            ? "failed"
            : "uploaded";
    } catch (error) {
      job.error = (error as Error).message;
      job.state = "failed";
    } finally {
      if (conflict.value && findJob(conflict.value.jobId)?.id === job.id) {
        conflict.value = null;
        conflictOpen.value = false;
      }
      refresh();
    }
  }
  function onProgress(value: Progress) {
    const job = findJob(value.jobId);
    if (!job || finished(job)) return;
    job.progress = value;
    if (value.name) {
      const index = value.fileIndex ?? value.done;
      let file = job.files.find((entry) => entry.index === index);
      if (!file) {
        file = { index, name: value.name, state: "uploading" };
        job.files.push(file);
      }
      Object.assign(file, {
        name: value.name,
        state: value.fileState || "uploading",
        sizeBytes: value.sizeBytes,
        destination: value.targetPath,
        error: value.message,
      });
    }
    if (job.state !== "waiting") job.state = value.phase || "uploading";
  }
  function onConflict(value: UploadConflict) {
    const job = findJob(value.jobId);
    conflict.value = { ...value, jobId: job?.id || value.jobId };
    if (job) job.state = "waiting";
    panelOpen.value = true;
    conflictOpen.value = true;
  }
  function resolveConflict(id: string) {
    if (conflict.value?.id !== id) return;
    const job = findJob(conflict.value.jobId);
    if (job && !finished(job)) job.state = "uploading";
    conflict.value = null;
    conflictOpen.value = false;
  }
  function clearFinished() {
    if (!pending.value) jobs.value = jobs.value.filter((job) => !finished(job));
    else
      for (const job of jobs.value) {
        if (finished(job)) job.cleared = true;
        job.files = job.files.filter((file) => file.state === "uploading");
      }
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
    onProgress,
    onConflict,
    resolveConflict,
    clearFinished,
  };
}
