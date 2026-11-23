<script setup lang="ts">
import { reactive, ref, computed } from "vue";
import type { Connection, Settings } from "./types";
const props = defineProps<{ settings: Settings }>();
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
    ? "Сохранено · оставьте пустым, чтобы не менять"
    : "",
);
async function run(save: boolean) {
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    const input = { ...form };
    if (save) {
      const result = await window.jellyree.settings.save(input);
      emit("saved", result);
    } else {
      await window.jellyree.settings.test(input);
      message.value = "R2 и D1 доступны. Можно сохранить подключение.";
    }
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function disconnect() {
  busy.value = true;
  try {
    await window.jellyree.settings.clear();
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
          <span class="eyebrow">ВАШЕ ОБЛАКО</span>
          <h2 id="settings-title">Подключение Cloudflare</h2>
        </div>
        <button
          class="icon-button"
          :disabled="busy"
          aria-label="Закрыть"
          @click="emit('close')"
        >
          <i aria-hidden="true" class="ri-close-line"></i>
        </button>
      </header>
      <p class="muted">
        Файлы в R2, каталог в D1. Приложение работает напрямую с вашим
        аккаунтом.
      </p>
      <form @submit.prevent="run(true)">
        <fieldset :disabled="busy">
          <label
            >Cloudflare Account ID<input
              v-model="form.accountId"
              required
              autocomplete="off"
              placeholder="32 символа из панели Cloudflare"
          /></label>
          <div class="settings-section">
            <i aria-hidden="true" class="ri-database-2-line"></i
            ><strong>База данных D1</strong>
          </div>
          <label
            >Database ID<input
              v-model="form.databaseId"
              required
              autocomplete="off"
              placeholder="UUID созданной базы D1"
          /></label>
          <label
            >Cloudflare API Token<input
              v-model="form.apiToken"
              type="password"
              :required="!settings.hasSecrets"
              autocomplete="new-password"
              :placeholder="placeholder"
            /><small
              >Токен с правом Account → D1 → Edit для этого аккаунта.</small
            ></label
          >
          <div class="settings-section">
            <i aria-hidden="true" class="ri-cloud-line"></i
            ><strong>Хранилище R2</strong>
          </div>
          <div class="form-columns">
            <label
              >Bucket<input
                v-model="form.bucket"
                required
                placeholder="my-drive" /></label
            ><label
              >Префикс объектов<input
                v-model="form.prefix"
                placeholder="jellyree"
              /><small>Пустое поле — весь bucket.</small></label
            >
          </div>
          <label
            >R2 Access Key ID<input
              v-model="form.accessKeyId"
              type="password"
              :required="!settings.hasSecrets"
              autocomplete="new-password"
              :placeholder="placeholder"
          /></label>
          <label
            >R2 Secret Access Key<input
              v-model="form.secretAccessKey"
              type="password"
              :required="!settings.hasSecrets"
              autocomplete="new-password"
              :placeholder="placeholder"
            /><small
              >Отдельные S3-реквизиты R2 с правом Object Read & Write для
              выбранного bucket.</small
            ></label
          >
        </fieldset>
        <div class="info-note">
          <i aria-hidden="true" class="ri-lock-2-line"></i
          ><span
            >Ключи хранятся локально с шифрованием ОС. Без системного хранилища
            — только до закрытия приложения. Таблицы <code>jr_*</code> создаются
            при сохранении.</span
          >
        </div>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <p v-if="message" class="success" role="status">{{ message }}</p>
        <footer class="dialog-footer">
          <button
            type="button"
            class="button"
            :disabled="busy"
            @click="run(false)"
          >
            {{
              busy ? "Подключение…" : "Проверить подключение"
            }}</button><button class="button primary" :disabled="busy">
            Сохранить и открыть
          </button>
        </footer>
      </form>
      <div v-if="settings.configured" class="disconnect">
        <template v-if="forget"
          ><span
            >Удалить реквизиты с этого устройства? Файлы в облаке
            останутся.</span
          ><button
            class="text-button danger"
            :disabled="busy"
            @click="disconnect"
          >
            Отключить</button
          ><button class="text-button" @click="forget = false">
            Отмена
          </button></template
        ><button
          v-else
          class="text-button danger"
          :disabled="busy"
          @click="forget = true"
        >
          Забыть подключение на этом устройстве
        </button>
      </div>
    </section>
  </div>
</template>
