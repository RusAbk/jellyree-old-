<script setup lang="ts">
import { t } from "./i18n";
import type { UploadJob } from "./use-upload-jobs";
import { uploadPercent } from "./use-upload-jobs";
import { bytes } from "./format";
defineProps<{ jobs: UploadJob[]; pending: number; hasFinished: boolean }>();
defineEmits<{ close: []; clear: []; conflict: [] }>();
function label(state: UploadJob["state"]) {
  return {
    selecting: t("Выбор файлов…"),
    queued: t("В очереди"),
    preparing: t("Подготовка загрузки…"),
    uploading: t("Загрузка"),
    waiting: t("Нужно решить совпадение имён"),
    complete: t("Загрузка завершена"),
    issues: t("Завершено с замечаниями"),
    failed: t("Ошибка загрузки"),
    canceled: t("Загрузка отменена"),
  }[state];
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
        <strong>{{ t("Загрузки") }}</strong><small v-if="pending">{{
          t("Активных задач: {0}", { "0": pending })
        }}</small
        ><small v-else>{{ t("Все загрузки завершены") }}</small>
      </div>
      <button
        class="icon-button"
        :aria-label="t('Скрыть загрузки')"
        @click="$emit('close')"
      >
        <i aria-hidden="true" class="ri-subtract-line"></i>
      </button>
    </header>
    <div class="upload-jobs">
      <p v-if="!jobs.length" class="muted">{{ t("Загрузок пока нет") }}</p>
      <article
        v-for="job in jobs"
        :key="job.id"
        class="upload-job"
        :data-state="job.state"
      >
        <div class="upload-job-title">
          <i
            aria-hidden="true"
            :class="
              job.folders ? 'ri-folder-upload-line' : 'ri-upload-cloud-2-line'
            "
          ></i
          ><strong>{{
            job.names.length === 1
              ? job.names[0]
              : job.folders
                ? t("Загрузить папку")
                : t("Загрузить файлы")
          }}</strong>
        </div>
        <small>{{
          t("Папка: {0}", { "0": job.destination || t("Мой диск") })
        }}</small>
        <p
          class="upload-job-status"
          :class="{
            error: job.state === 'failed',
            success: job.state === 'complete',
          }"
        >
          {{ label(job.state)
          }}<span
            v-if="
              job.progress?.total &&
              ['uploading', 'waiting'].includes(job.state)
            "
          >
            · {{ job.progress.done }} / {{ job.progress.total }}</span
          >
        </p>
        <template v-if="job.state === 'uploading' && job.progress">
          <div class="upload-current">
            <span>{{ job.progress.name }}</span><span
              >{{ uploadPercent(job.progress) }}%</span
            >
          </div>
          <progress
            :value="uploadPercent(job.progress)"
            max="100"
            :aria-label="t('Прогресс загрузки')"
          ></progress>
          <small v-if="job.progress.totalBytes"
            >{{ bytes(job.progress.loaded || 0) }} /
            {{ bytes(job.progress.totalBytes) }}</small
          >
        </template>
        <button
          v-if="job.state === 'waiting'"
          class="button primary"
          @click="$emit('conflict')"
        >
          {{ t("Разобрать совпадение") }}
        </button>
        <p v-if="job.result" class="upload-result">
          {{
            t("Загружено файлов: {0}. Пропущено: {1}.", {
              "0": job.result.done,
              "1": job.result.skipped || 0,
            })
          }}
        </p>
        <p v-if="job.error" class="error">{{ job.error }}</p>
        <details
          v-if="
            job.result &&
            (job.result.failures.length || job.result.warnings?.length)
          "
        >
          <summary>
            {{ t("Подробности")
            }}<template v-if="job.result.failures.length">
              ·
              {{
                t("Ошибок: {0}", { "0": job.result.failures.length })
              }}</template
            >
          </summary>
          <p
            v-for="(failure, index) in job.result.failures"
            :key="index"
            class="error"
          >
            {{ failure.name }}: {{ failure.message }}
          </p>
          <p
            v-for="(warning, index) in job.result.warnings"
            :key="index"
            class="muted"
          >
            {{ warning }}
          </p>
        </details>
      </article>
    </div>
    <footer v-if="hasFinished">
      <button class="text-button" @click="$emit('clear')">
        {{ t("Убрать завершённые") }}
      </button>
    </footer>
  </section>
</template>
