import { computed, reactive, ref } from "vue";
import type { Jellyree, Progress, UploadConflict, UploadResult } from "./types";

export type UploadJob = {
  id: string;
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
const finished = (job: UploadJob) =>
  ["complete", "issues", "failed", "canceled"].includes(job.state);
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
  const pending = computed(
    () => jobs.value.filter((job) => !finished(job)).length,
  );
  const hasFinished = computed(() => jobs.value.some(finished));
  const issues = computed(
    () =>
      jobs.value.filter((job) => ["issues", "failed"].includes(job.state))
        .length,
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
    const job = reactive<UploadJob>({
      id: crypto.randomUUID(),
      folders,
      names: files?.map((file) => file.name) || [],
      destination,
      state: files ? "queued" : "selecting",
    });
    jobs.value.push(job);
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
    if (job.state !== "waiting") job.state = value.phase || "uploading";
  }
  function onConflict(value: UploadConflict) {
    const job = findJob(value.jobId);
    conflict.value = { ...value, jobId: job?.id || value.jobId };
    if (job) job.state = "waiting";
    // The upload waits; the file browser keeps its focus and remains usable.
  }
  function resolveConflict(id: string) {
    if (conflict.value?.id !== id) return;
    const job = findJob(conflict.value.jobId);
    if (job && !finished(job)) job.state = "uploading";
    conflict.value = null;
    conflictOpen.value = false;
  }
  function clearFinished() {
    jobs.value = jobs.value.filter((job) => !finished(job));
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
