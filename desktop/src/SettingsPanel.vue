<script setup lang="ts">
import { t } from "./i18n";
import { reactive, ref, computed, onMounted, watch } from "vue";
import type {
  ConnectionInput,
  ConnectionProfile,
  Settings,
  ThumbnailStats,
} from "./types";
import { bytes } from "./format";
import { api } from "./api";
import LanguageSelect from "./LanguageSelect.vue";
const props = defineProps<{ settings: Settings; locked?: boolean }>();
const cache = ref<ThumbnailStats>(),
  cacheBusy = ref(false),
  cacheMessage = ref("");
onMounted(async () => {
  if (typeof window.jellyree.thumbnails?.stats === "function")
    cache.value = await api.thumbnails.stats().catch(() => undefined);
});
async function clearThumbnails() {
  cacheBusy.value = true;
  cacheMessage.value = "";
  try {
    cache.value = await api.thumbnails.clear();
    cacheMessage.value = t("Кэш миниатюр очищен.");
  } catch (error) {
    cacheMessage.value = (error as Error).message;
  } finally {
    cacheBusy.value = false;
  }
}
const emit = defineEmits<{
  close: [];
  saved: [settings: Settings];
  selected: [settings: Settings];
  removed: [settings: Settings];
}>();
const creating = ref(!props.settings.configured);
const profileId = ref(props.settings.activeProfileId);
const profiles = computed(() => props.settings.profiles ?? []);
const form = reactive<ConnectionInput>({
  name: "",
  accountId: "",
  databaseId: "",
  bucket: "",
  prefix: "",
  apiToken: "",
  accessKeyId: "",
  secretAccessKey: "",
});
const busy = ref(false),
  error = ref(props.settings.startupError || ""),
  message = ref(""),
  forget = ref(false);
const hasSecrets = computed(
  () =>
    !creating.value &&
    (profileId.value
      ? profiles.value.some(({ id }) => id === profileId.value)
      : props.settings.hasSecrets),
);
const placeholder = computed(() =>
  hasSecrets.value ? t("Сохранено · оставьте пустым, чтобы не менять") : "",
);
function fillForm(profile?: Settings | ConnectionProfile) {
  Object.assign(form, {
    name: profile?.name ?? "",
    accountId: profile?.accountId ?? "",
    databaseId: profile?.databaseId ?? "",
    bucket: profile?.bucket ?? "",
    prefix: profile?.prefix ?? "jellyree",
    apiToken: "",
    accessKeyId: "",
    secretAccessKey: "",
  });
  error.value = "";
  message.value = "";
  forget.value = false;
}
function editConnection(id: string) {
  const profile = profiles.value.find((entry) => entry.id === id);
  creating.value = !profile;
  profileId.value = profile?.id;
  fillForm(profile);
}
watch(
  () => props.settings,
  (settings) => {
    creating.value = !settings.configured;
    profileId.value = settings.activeProfileId;
    fillForm(settings.configured ? settings : undefined);
    error.value = settings.startupError ?? "";
  },
  { immediate: true },
);

async function run(save: boolean) {
  if (busy.value || props.locked) return;
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    const input = {
      ...form,
      profileId: creating.value ? null : profileId.value,
    };
    if (save) {
      const result = await api.settings.save(input);
      emit("saved", result);
    } else {
      await api.settings.test(input);
      message.value = t("R2 и D1 доступны. Можно сохранить подключение.");
    }
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function openConnection() {
  if (!profileId.value || busy.value || props.locked) return;
  busy.value = true;
  error.value = "";
  try {
    emit("selected", await api.settings.select(profileId.value));
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function disconnect() {
  if (busy.value || props.locked) return;
  busy.value = true;
  try {
    emit("removed", await api.settings.clear(profileId.value));
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div
    class="overlay"
    @keydown.esc.stop.prevent="!busy && emit('close')"
    @click.self="!busy && emit('close')"
  >
    <section
      class="dialog settings-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
    >
      <header class="dialog-header">
        <div>
          <span class="eyebrow">{{ t("ВАШЕ ОБЛАКО") }}</span>
          <h2 id="settings-title">{{ t("Подключение Cloudflare") }}</h2>
        </div>
        <button
          class="icon-button"
          :disabled="busy"
          :aria-label="t('Закрыть')"
          @click="emit('close')"
        >
          <i aria-hidden="true" class="ri-close-line"></i>
        </button>
      </header>
      <LanguageSelect :disabled="busy" />
      <p class="muted">
        {{
          t(
            "Файлы в R2, каталог в D1. Приложение работает напрямую с вашим аккаунтом.",
          )
        }}
      </p>
      <div v-if="profiles.length" class="connection-profiles">
        <label>
          {{ t("Подключения") }}
          <select
            :value="profileId ?? ''"
            :disabled="busy || locked"
            @change="editConnection(($event.target as HTMLSelectElement).value)"
          >
            <option v-if="creating" value="">
              {{ t("Новое подключение") }}
            </option>
            <option
              v-for="profile in profiles"
              :key="profile.id"
              :value="profile.id"
            >
              {{ profile.name
              }}{{
                profile.id === settings.activeProfileId
                  ? " · " + t("Активное")
                  : ""
              }}
            </option>
          </select>
        </label>
        <button
          v-if="profileId && profileId !== settings.activeProfileId"
          class="button"
          :disabled="busy || locked"
          @click="openConnection"
        >
          {{ t("Открыть подключение") }}
        </button>
        <button
          class="button"
          :disabled="busy || locked || creating"
          @click="editConnection('')"
        >
          <i aria-hidden="true" class="ri-add-line"></i
          >{{ t("Новое подключение") }}
        </button>
      </div>
      <form @submit.prevent="run(true)">
        <p v-if="locked" class="info-note">
          {{ t("Изменить подключение можно после завершения загрузок.") }}
        </p>
        <fieldset :disabled="busy || locked">
          <label>
            {{ t("Название подключения") }}
            <input
              v-model="form.name"
              maxlength="80"
              :placeholder="form.bucket || t('По имени бакета')"
            />
          </label>
          <label
            >{{ t("ID аккаунта Cloudflare")
            }}<input
              v-model="form.accountId"
              required
              autocomplete="off"
              :placeholder="t('32 символа из панели Cloudflare')"
          /></label>
          <div class="settings-section">
            <i aria-hidden="true" class="ri-database-2-line"></i
            ><strong>{{ t("База данных D1") }}</strong>
          </div>
          <label
            >{{ t("ID базы данных")
            }}<input
              v-model="form.databaseId"
              required
              autocomplete="off"
              :placeholder="t('UUID созданной базы D1')"
          /></label>
          <label
            >{{ t("API-токен Cloudflare")
            }}<input
              v-model="form.apiToken"
              type="password"
              :required="!hasSecrets"
              autocomplete="new-password"
              :placeholder="placeholder"
            /><small>{{
              t("Токен с правом Account → D1 → Edit для этого аккаунта.")
            }}</small></label
          >
          <div class="settings-section">
            <i aria-hidden="true" class="ri-cloud-line"></i
            ><strong>{{ t("Хранилище R2") }}</strong>
          </div>
          <div class="form-columns">
            <label
              >{{ t("Имя bucket")
              }}<input
                v-model="form.bucket"
                required
                placeholder="my-drive" /></label
            ><label
              >{{ t("Префикс объектов")
              }}<input v-model="form.prefix" placeholder="jellyree" /><small>{{
                t("Пустое поле — весь bucket.")
              }}</small></label
            >
          </div>
          <label
            >{{ t("ID ключа доступа R2")
            }}<input
              v-model="form.accessKeyId"
              type="password"
              :required="!hasSecrets"
              autocomplete="new-password"
              :placeholder="placeholder"
          /></label>
          <label
            >{{ t("Секретный ключ R2")
            }}<input
              v-model="form.secretAccessKey"
              type="password"
              :required="!hasSecrets"
              autocomplete="new-password"
              :placeholder="placeholder"
            /><small>{{
              t(
                "Отдельные S3-реквизиты R2 с правом Object Read & Write для выбранного bucket.",
              )
            }}</small></label
          >
        </fieldset>
        <div class="info-note">
          <i aria-hidden="true" class="ri-lock-2-line"></i
          ><span>{{
            t(
              "Ключи хранятся локально с шифрованием ОС. Без системного хранилища — только до закрытия приложения. Таблицы jr_* создаются при сохранении.",
            )
          }}</span>
        </div>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <p v-if="message" class="success" role="status">{{ message }}</p>
        <footer class="dialog-footer">
          <button
            type="button"
            class="button"
            :disabled="busy || locked"
            @click="run(false)"
          >
            {{
              busy ? t("Подключение…") : t("Проверить подключение")
            }}</button><button
            class="button primary"
            :disabled="busy || locked"
          >
            {{ t("Сохранить и открыть") }}
          </button>
        </footer>
      </form>
      <section v-if="cache" class="thumbnail-cache-settings">
        <h3>{{ t("Кэш миниатюр") }}</h3>
        <p class="muted">
          {{
            t("{0} превью · {1} из {2}", {
              "0": cache.count,
              "1": bytes(cache.bytes),
              "2": bytes(cache.maxBytes),
            })
          }}
        </p>
        <p class="muted">
          {{
            t(
              "Превью хранятся на этом устройстве. Старые удаляются автоматически при заполнении кэша.",
            )
          }}
        </p>
        <button
          class="button"
          :disabled="cacheBusy || busy"
          @click="clearThumbnails"
        >
          {{ cacheBusy ? t("Очистка…") : t("Очистить кэш миниатюр") }}
        </button>
        <p v-if="cacheMessage" role="status" class="muted">
          {{ cacheMessage }}
        </p>
      </section>
      <div v-if="hasSecrets" class="disconnect">
        <template v-if="forget"
          ><span>{{
            t("Удалить реквизиты с этого устройства? Файлы в облаке останутся.")
          }}</span
          ><button
            class="text-button danger"
            :disabled="busy || locked"
            @click="disconnect"
          >
            {{ t("Отключить") }}</button
          ><button class="text-button" @click="forget = false">
            {{ t("Отмена") }}
          </button></template
        ><button
          v-else
          class="text-button danger"
          :disabled="busy || locked"
          @click="forget = true"
        >
          {{ t("Забыть подключение на этом устройстве") }}
        </button>
      </div>
    </section>
  </div>
</template>
