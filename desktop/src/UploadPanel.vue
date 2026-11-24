<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { t } from "./i18n";
import type { UploadJob } from "./use-upload-jobs";
import {
  uploadPercent,
  uploadFinished,
  uploadSummary,
} from "./use-upload-jobs";
import { bytes } from "./format";
const props = defineProps<{
  jobs: UploadJob[];
  pending: number;
  hasFinished: boolean;
  retrying: Set<string>;
}>();
defineEmits<{
  close: [];
  clear: [];
  conflict: [];
  retry: [jobId: string, retryId?: string];
}>();
const tab = ref(props.pending ? "active" : "completed"),
  limit = ref(150);
const summary = computed(() => uploadSummary(props.jobs));
const active = computed(() => props.jobs.filter((job) => !uploadFinished(job)));
const completed = computed(() =>
  props.jobs
    .flatMap((job) => {
      if (job.cleared) return [];
      const retryIds = new Map(
        uploadFinished(job)
          ? job.result?.failures.map((failure) => [
              failure.fileIndex,
              failure.retryId,
            ])
          : [],
      );
      const files = job.files
        .filter((file) => file.state !== "uploading")
        .map((file) => ({
          key: `${job.id}:${file.index}`,
          job,
          file,
          retryId: retryIds.get(file.index),
          retryIds: [],
        }));
      return [
        ...files,
        ...(uploadFinished(job) &&
        (!files.length ||
          job.result?.failures.length ||
          job.result?.warnings?.length ||
          job.error)
          ? [
              {
                key: job.id,
                job,
                file: undefined,
                retryId: undefined,
                retryIds: [...retryIds.values()].filter(
                  (id): id is string => !!id,
                ),
              },
            ]
          : []),
      ];
    })
    .reverse(),
);
watch(
  () => props.jobs[props.jobs.length - 1]?.id,
  (id) => {
    if (!id) return;
    tab.value = "active";
    limit.value = 150;
  },
);
watch(
  () => props.jobs.find((job) => job.state === "waiting")?.id,
  (id) => {
    if (id) tab.value = "active";
  },
);
watch(
  () => props.pending,
  (value, previous) => {
    if (!value && previous) tab.value = "completed";
  },
);
function label(state: UploadJob["state"] | "uploaded" | "skipped") {
  return {
    selecting: t("Выбор файлов…"),
    queued: t("В очереди"),
    preparing: t("Подготовка загрузки…"),
    uploading: t("Загрузка"),
    waiting: t("Нужно решить совпадение имён"),
    complete: t("Загрузка завершена"),
    uploaded: t("Загружен"),
    skipped: t("Пропущен"),
    issues: t("Завершено с замечаниями"),
    failed: t("Ошибка загрузки"),
    canceled: t("Загрузка отменена"),
  }[state];
}
function title(job: UploadJob) {
  return (
    job.progress?.name ||
    (job.names.length === 1
      ? job.names[0]
      : job.folders
        ? t("Загрузить папку")
        : t("Загрузить файлы"))
  );
}
</script>
<template>
  <section
    id="upload-panel"
    class="upload-panel"
    role="region"
    :aria-label="t('Загрузки')"
  >
    <header>
      <div>
        <strong>{{ t("Загрузки") }}</strong><small>{{
          pending
            ? t("Активных задач: {0}", { "0": pending })
            : t("Все загрузки завершены")
        }}</small>
      </div>
      <button
        class="icon-button small"
        :aria-label="t('Скрыть загрузки')"
        @click="$emit('close')"
      >
        <i aria-hidden="true" class="ri-subtract-line"></i>
      </button>
    </header>
    <div
      v-if="pending"
      class="upload-overall"
      role="status"
      :title="
        summary.totalBytes
          ? `${bytes(summary.loaded)} / ${bytes(summary.totalBytes)}`
          : undefined
      "
    >
      <div>
        <span
          >{{ t("Общий прогресс")
          }}<template v-if="summary.total">
            · {{ summary.done }} / {{ summary.total }}</template
          ></span
        ><strong>{{
          summary.indeterminate ? t("Подготовка…") : `${summary.percent}%`
        }}</strong>
      </div>
      <progress
        :value="summary.indeterminate ? undefined : summary.percent"
        max="100"
        :aria-label="t('Общий прогресс загрузки')"
      ></progress>
    </div>
    <div
      class="upload-tabs"
      role="tablist"
      :aria-label="t('Категории загрузок')"
    >
      <button
        id="uploads-active-tab"
        role="tab"
        :aria-selected="tab === 'active'"
        aria-controls="uploads-active"
        @click="
          tab = 'active';
          limit = 150;
        "
      >
        {{ t("В работе") }} <span>{{ active.length }}</span></button
      ><button
        id="uploads-completed-tab"
        role="tab"
        :aria-selected="tab === 'completed'"
        aria-controls="uploads-completed"
        @click="
          tab = 'completed';
          limit = 150;
        "
      >
        {{ t("Загруженные") }} <span>{{ completed.length }}</span>
      </button>
    </div>
    <div
      v-if="tab === 'active'"
      id="uploads-active"
      class="upload-jobs"
      role="tabpanel"
      aria-labelledby="uploads-active-tab"
      tabindex="0"
    >
      <p v-if="!active.length" class="upload-empty">
        {{ t("Нет активных загрузок") }}
      </p>
      <article
        v-for="job in active"
        :key="job.id"
        class="upload-job compact-upload"
        :data-state="job.state"
      >
        <i
          aria-hidden="true"
          :class="
            job.state === 'waiting'
              ? 'ri-error-warning-line'
              : job.state === 'uploading'
                ? 'ri-loader-4-line spinning'
                : 'ri-time-line'
          "
        ></i>
        <div class="upload-job-content">
          <div class="upload-job-heading">
            <strong :title="title(job)">{{ title(job) }}</strong><span>{{
              job.progress && job.state === "uploading"
                ? `${uploadPercent(job.progress)}%`
                : label(job.state)
            }}</span>
          </div>
          <small :title="job.destination || t('Мой диск')"
            >{{ job.destination || t("Мой диск")
            }}<template v-if="job.progress?.total">
              · {{ job.progress.done }} / {{ job.progress.total }}</template
            ></small
          ><progress
            v-if="job.state === 'uploading' && job.progress"
            :value="uploadPercent(job.progress)"
            max="100"
            :aria-label="t('Прогресс загрузки')"
          ></progress
          ><button
            v-if="job.state === 'waiting'"
            class="text-button"
            @click="$emit('conflict')"
          >
            {{ t("Разобрать совпадение") }}
          </button>
        </div>
      </article>
    </div>
    <div
      v-else
      id="uploads-completed"
      class="upload-jobs"
      role="tabpanel"
      aria-labelledby="uploads-completed-tab"
      tabindex="0"
    >
      <p v-if="!completed.length" class="upload-empty">
        {{ t("Завершённых загрузок пока нет") }}
      </p>
      <article
        v-for="row in completed.slice(0, limit)"
        :key="row.key"
        class="upload-job compact-upload"
        :data-state="
          row.file
            ? row.file.state === 'uploaded'
              ? 'complete'
              : row.file.state === 'failed'
                ? 'issues'
                : row.file.state
            : row.job.state
        "
      >
        <i
          aria-hidden="true"
          :class="
            row.file?.state === 'failed' ||
            (!row.file && ['issues', 'failed'].includes(row.job.state))
              ? 'ri-error-warning-line'
              : row.file?.state === 'skipped' || row.job.state === 'canceled'
                ? 'ri-forbid-line'
                : 'ri-checkbox-circle-line'
          "
        ></i>
        <div class="upload-job-content">
          <div class="upload-job-heading">
            <strong
              :title="
                row.file?.name ||
                (row.job.files.length ? t('Итоги загрузки') : title(row.job))
              "
              >{{
                row.file?.name ||
                (row.job.files.length ? t("Итоги загрузки") : title(row.job))
              }}</strong><span>{{
              label(row.file?.state || row.job.state)
            }}</span>
          </div>
          <small
            :title="
              row.file?.destination || row.job.destination || t('Мой диск')
            "
            >{{ row.file?.destination || row.job.destination || t("Мой диск")
            }}<template v-if="row.file?.sizeBytes">
              · {{ bytes(row.file.sizeBytes) }}</template
            ><template v-else-if="row.job.result">
              ·
              {{
                t("Загружено: {0}, пропущено: {1}", {
                  "0": row.job.result.done,
                  "1": row.job.result.skipped || 0,
                })
              }}</template
            ></small
          >
          <p
            v-if="row.file?.error || (!row.file && row.job.error)"
            class="error"
          >
            {{ row.file?.error || row.job.error }}
          </p>
          <button
            v-if="row.retryId || row.retryIds.length"
            class="text-button"
            :disabled="
              row.retryId
                ? retrying.has(row.retryId)
                : row.retryIds.some((id) => retrying.has(id))
            "
            @click="$emit('retry', row.job.id, row.retryId)"
          >
            {{ row.retryId ? t("Повторить") : t("Повторить неудачные") }}
          </button>
          <details
            v-if="
              !row.file &&
              row.job.result &&
              (row.job.result.failures.length ||
                row.job.result.warnings?.length)
            "
          >
            <summary>
              {{ t("Подробности")
              }}<template v-if="row.job.result.failures.length">
                ·
                {{
                  t("Ошибок: {0}", { "0": row.job.result.failures.length })
                }}</template
              >
            </summary>
            <p
              v-for="(failure, index) in row.job.result.failures"
              :key="index"
              class="error"
            >
              {{ failure.name }}: {{ failure.message }}
            </p>
            <p
              v-for="(warning, index) in row.job.result.warnings"
              :key="index"
              class="muted"
            >
              {{ warning }}
            </p>
          </details>
        </div>
      </article>
      <button
        v-if="completed.length > limit"
        class="text-button upload-show-more"
        @click="limit += 150"
      >
        {{ t("Показать ещё") }}
      </button>
    </div>
    <footer v-if="hasFinished">
      <button class="text-button" @click="$emit('clear')">
        {{ t("Убрать завершённые") }}
      </button>
    </footer>
  </section>
</template>
