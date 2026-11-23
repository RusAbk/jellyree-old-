<script setup lang="ts">
import { t } from "./i18n";
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";

export type MenuItem = {
  id: string;
  label: string;
  icon: string;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
};
const props = defineProps<{
  x: number;
  y: number;
  label: string;
  items: MenuItem[];
}>();
const emit = defineEmits<{ choose: [id: string]; close: [] }>();
const root = ref<HTMLElement>();
const position = ref({
  left: "0px",
  top: "0px",
  visibility: "hidden" as "hidden" | "visible",
});
let previousFocus: HTMLElement | null = null;
function outside(event: Event) {
  if (!root.value?.contains(event.target as Node)) emit("close");
}
function scroll(event: Event) {
  if (!root.value?.contains(event.target as Node)) emit("close");
}
function close() {
  emit("close");
}
function keydown(event: KeyboardEvent) {
  const buttons = Array.from(
    root.value?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ||
      [],
  );
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
  let target: number | undefined;
  if (event.key === "ArrowDown") target = (current + 1) % buttons.length;
  if (event.key === "ArrowUp")
    target = (current - 1 + buttons.length) % buttons.length;
  if (event.key === "Home") target = 0;
  if (event.key === "End") target = buttons.length - 1;
  if (event.key === "Escape" || event.key === "Tab") {
    event.preventDefault();
    close();
  }
  if (target !== undefined) {
    event.preventDefault();
    buttons[target]?.focus();
  }
}
onMounted(async () => {
  previousFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  await nextTick();
  if (!root.value) return;
  const bounds = root.value.getBoundingClientRect();
  position.value = {
    left: `${Math.max(8, Math.min(props.x, window.innerWidth - bounds.width - 8))}px`,
    top: `${Math.max(8, Math.min(props.y, window.innerHeight - bounds.height - 8))}px`,
    visibility: "visible",
  };
  await nextTick();
  if (!root.value) return;
  (
    root.value.querySelector<HTMLButtonElement>("button:not(:disabled)") ||
    root.value
  ).focus({ preventScroll: true });
  document.addEventListener("pointerdown", outside, true);
  // Close on user scrolling, not on queued layout/focus scroll events from
  // right-clicking a card that the browser just brought into view.
  window.addEventListener("wheel", scroll, { capture: true, passive: true });
  window.addEventListener("touchmove", scroll, {
    capture: true,
    passive: true,
  });
  window.addEventListener("resize", close);
  window.addEventListener("blur", close);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", outside, true);
  window.removeEventListener("wheel", scroll, true);
  window.removeEventListener("touchmove", scroll, true);
  window.removeEventListener("resize", close);
  window.removeEventListener("blur", close);
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
});
</script>

<template>
  <Teleport to="body">
    <div
      ref="root"
      class="context-menu"
      role="menu"
      tabindex="-1"
      :aria-label="label"
      :style="position"
      @keydown.stop="keydown"
      @contextmenu.prevent.stop
    >
      <template v-for="item in items" :key="item.id">
        <div
          v-if="item.separator"
          class="context-menu-separator"
          role="separator"
        ></div>
        <button
          role="menuitem"
          :disabled="item.disabled"
          :class="{ danger: item.danger }"
          @click="emit('choose', item.id)"
        >
          <i aria-hidden="true" :class="item.icon"></i
          ><span>{{ item.label }}</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>
