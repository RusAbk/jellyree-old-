<script setup lang="ts">
import { t } from "./i18n";
import { reactive, ref, computed } from "vue";
import type { Connection, Settings } from "./types";
import { api } from "./api";
import LanguageSelect from "./LanguageSelect.vue";
const props = defineProps<{ settings: Settings; locked?: boolean }>();
const emit = defineEmits<{
  close: [];
  saved: [settings: Settings];
  disconnected: [];
}>();
const form = reactive<Connection>({
  accountId: props.settings.accountId || "",
  databaseId: props.settings.databaseId || "",
  bucket: props.settings.bucket || "",
  prefix: props.settings.prefix ?? "jellyree",
  apiToken: "",
  accessKeyId: "",
  secretAccessKey: "",
});
const busy = ref(false),
  error = ref(props.settings.startupError || ""),
  message = ref(""),
  forget = ref(false);
const placeholder = computed(() =>
  props.settings.hasSecrets
    ? t("Сохранено · оставьте пустым, чтобы не менять")
    : "",
);
async function run(save: boolean) {
  if (busy.value || props.locked) return;
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    const input = { ...form };
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
async function disconnect() {
  if (busy.value || props.locked) return;
  busy.value = true;
  try {
    await api.settings.clear();
    emit("disconnected");
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
      <form @submit.prevent="run(true)">
        <p v-if="locked" class="info-note">
          {{ t("Изменить подключение можно после завершения загрузок.") }}
        </p>
        <fieldset :disabled="busy || locked">
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
              :required="!settings.hasSecrets"
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
              :required="!settings.hasSecrets"
              autocomplete="new-password"
              :placeholder="placeholder"
          /></label>
          <label
            >{{ t("Секретный ключ R2")
            }}<input
              v-model="form.secretAccessKey"
              type="password"
              :required="!settings.hasSecrets"
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
      <div v-if="settings.configured" class="disconnect">
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
