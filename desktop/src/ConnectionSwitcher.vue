<script setup lang="ts">
import { computed, ref, useId, watch } from "vue";
import { t } from "./i18n";
import type { ConnectionProfile, Settings } from "./types";

const props = defineProps<{
  settings: Settings;
  disabled: boolean;
  switching: boolean;
  locked: boolean;
}>();
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ select: [id: string]; add: []; settings: [] }>();
const root = ref<HTMLElement>();
const trigger = ref<HTMLButtonElement>();
const panel = ref<HTMLElement>();
const panelId = useId();
const profiles = computed(() => props.settings.profiles ?? []);
const current = computed(() =>
  profiles.value.find(
    (profile) => profile.id === props.settings.activeProfileId,
  ),
);
const active = computed(() => current.value ?? props.settings);
const activeName = computed(
  () => active.value.name || active.value.bucket || t("Облако не подключено"),
);
const alternatives = computed(() =>
  profiles.value.filter(({ id }) => id !== props.settings.activeProfileId),
);

function initials(name: string) {
  return name
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? "")
    .join("")
    .toLocaleUpperCase();
}
function color(key: string) {
  let hue = 0;
  for (const character of key)
    hue = (hue * 31 + character.codePointAt(0)!) % 360;
  return { "--profile-hue": hue };
}
function location({
  bucket,
  prefix,
}: Pick<ConnectionProfile, "bucket" | "prefix"> | Settings) {
  return bucket ? [bucket, prefix].filter(Boolean).join("/") : "";
}
function dismiss(restoreFocus = false) {
  open.value = false;
  if (restoreFocus) trigger.value?.focus({ preventScroll: true });
}
function select(id: string) {
  dismiss(true);
  emit("select", id);
}
function openSettings(create: boolean) {
  dismiss(true);
  if (create) emit("add");
  else emit("settings");
}
function outside(event: PointerEvent) {
  if (!root.value?.contains(event.target as Node)) dismiss();
}
function focusLeft(event: FocusEvent) {
  if (event.relatedTarget && !root.value?.contains(event.relatedTarget as Node))
    dismiss();
}
function keydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    dismiss(true);
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const buttons = Array.from(
    panel.value?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ??
      [],
  );
  if (!buttons.length) return;
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const target =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : event.key === "ArrowDown"
          ? (current + 1) % buttons.length
          : current < 0
            ? buttons.length - 1
            : (current - 1 + buttons.length) % buttons.length;
  event.preventDefault();
  buttons[target]?.focus();
}

watch(
  open,
  (visible, _, onCleanup) => {
    if (!visible) return;
    panel.value?.focus({ preventScroll: true });
    document.addEventListener("pointerdown", outside, true);
    onCleanup(() => document.removeEventListener("pointerdown", outside, true));
  },
  { flush: "post" },
);
</script>

<template>
  <div ref="root" class="connection-switcher" @focusout="focusLeft">
    <button
      ref="trigger"
      class="connection-trigger"
      :disabled="disabled || switching"
      :aria-label="t('Переключить подключение')"
      :aria-expanded="open"
      :aria-controls="open ? panelId : undefined"
      :aria-busy="switching || undefined"
      aria-haspopup="dialog"
      :title="activeName"
      @click="open = !open"
    >
      <span
        class="connection-avatar"
        :style="color(activeName)"
        aria-hidden="true"
      >
        <i v-if="switching" class="ri-loader-4-line spinning"></i>
        <template v-else-if="settings.configured">{{
          initials(activeName)
        }}</template>
        <i v-else class="ri-user-line"></i>
      </span>
      <span v-if="settings.configured" class="connection-trigger-name">{{
        activeName
      }}</span>
      <i class="ri-arrow-down-s-line connection-chevron" aria-hidden="true"></i>
    </button>

    <section
      v-if="open"
      :id="panelId"
      ref="panel"
      class="connection-picker"
      role="dialog"
      tabindex="-1"
      :aria-label="t('Подключения')"
      @keydown.stop="keydown"
    >
      <div
        class="connection-current"
        :aria-current="settings.configured ? 'true' : undefined"
      >
        <span
          class="connection-avatar"
          :style="color(activeName)"
          aria-hidden="true"
        >
          <template v-if="settings.configured">{{
            initials(activeName)
          }}</template>
          <i v-else class="ri-cloud-off-line"></i>
        </span>
        <span class="connection-identity">
          <small v-if="settings.configured">{{
            t("Активное подключение")
          }}</small>
          <strong>{{ activeName }}</strong>
          <small v-if="location(active)" :title="location(active)">{{
            location(active)
          }}</small>
        </span>
        <i
          v-if="settings.configured"
          class="ri-check-line connection-current-check"
          aria-hidden="true"
        ></i>
      </div>
      <p v-if="locked" class="connection-picker-status" role="status">
        {{ t("Изменить подключение можно после завершения загрузок.") }}
      </p>
      <div v-if="alternatives.length" class="connection-list">
        <button
          v-for="profile in alternatives"
          :key="profile.id"
          class="connection-option"
          :disabled="disabled || locked || switching"
          :aria-label="t('Открыть подключение «{0}»', { 0: profile.name })"
          @click="select(profile.id)"
        >
          <span
            class="connection-avatar"
            :style="color(profile.name)"
            aria-hidden="true"
            >{{ initials(profile.name) }}</span
          >
          <span class="connection-identity">
            <strong>{{ profile.name }}</strong>
            <small :title="location(profile)">{{ location(profile) }}</small>
          </span>
          <i class="ri-arrow-right-s-line" aria-hidden="true"></i>
        </button>
      </div>
      <footer class="connection-picker-actions">
        <button
          :disabled="disabled || locked || switching"
          @click="openSettings(true)"
        >
          <i class="ri-add-line" aria-hidden="true"></i
          >{{ t("Добавить подключение") }}
        </button>
        <button :disabled="disabled || switching" @click="openSettings(false)">
          <i class="ri-settings-3-line" aria-hidden="true"></i
          >{{ t("Настройки подключения") }}
        </button>
      </footer>
    </section>
  </div>
</template>
