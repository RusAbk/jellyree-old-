import { computed, ref, watch, type Ref } from "vue";

const maxScale = 8;
const step = Math.SQRT2;
const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export function usePhotoZoom(stage: Ref<HTMLElement | undefined>) {
  const viewport = ref<HTMLElement>();
  const scale = ref(1);
  const x = ref(0),
    y = ref(0);
  const dragging = ref(false);
  let pointer: number | undefined;
  let startX = 0,
    startY = 0;
  const transform = computed(() =>
    scale.value === 1
      ? undefined
      : `translate(${x.value}px, ${y.value}px) scale(${scale.value})`,
  );

  function reposition(nextScale: number, nextX: number, nextY: number) {
    const box = viewport.value;
    const image = stage.value?.firstElementChild?.getBoundingClientRect();
    const transformScale = stage.value
      ? stage.value.getBoundingClientRect().width / stage.value.offsetWidth
      : 1;
    scale.value = nextScale;
    if (!box || !image || !transformScale || nextScale === 1) {
      x.value = y.value = 0;
      return;
    }
    const ratio = nextScale / transformScale;
    const limitX = Math.max(0, (image.width * ratio - box.clientWidth) / 2);
    const limitY = Math.max(0, (image.height * ratio - box.clientHeight) / 2);
    x.value = clamp(nextX, -limitX, limitX);
    y.value = clamp(nextY, -limitY, limitY);
  }

  function zoomTo(value: number, anchor?: MouseEvent) {
    const next = clamp(value, 1, maxScale);
    const ratio = next / scale.value;
    const box = viewport.value?.getBoundingClientRect();
    const ax = box && anchor ? anchor.clientX - box.left - box.width / 2 : 0;
    const ay = box && anchor ? anchor.clientY - box.top - box.height / 2 : 0;
    reposition(next, ax + (x.value - ax) * ratio, ay + (y.value - ay) * ratio);
  }

  function zoomBy(direction: number) {
    zoomTo(scale.value * step ** direction);
  }

  function wheel(event: WheelEvent) {
    const delta = event.deltaY * (event.deltaMode ? 24 : 1);
    if (delta)
      zoomTo(scale.value * Math.exp(clamp(-delta / 300, -0.6, 0.6)), event);
  }

  function toggle(event: MouseEvent) {
    zoomTo(scale.value === 1 ? 2 : 1, event);
  }

  function start(event: PointerEvent) {
    if (scale.value === 1 || event.button !== 0 || !event.isPrimary) return;
    pointer = event.pointerId;
    startX = event.clientX - x.value;
    startY = event.clientY - y.value;
    dragging.value = true;
    viewport.value?.setPointerCapture(pointer);
  }

  function move(event: PointerEvent) {
    if (pointer === event.pointerId)
      reposition(scale.value, event.clientX - startX, event.clientY - startY);
  }

  function stop(event: PointerEvent) {
    if (pointer !== event.pointerId) return;
    pointer = undefined;
    dragging.value = false;
  }

  function reset() {
    if (pointer !== undefined && viewport.value?.hasPointerCapture(pointer))
      viewport.value.releasePointerCapture(pointer);
    pointer = undefined;
    dragging.value = false;
    reposition(1, 0, 0);
  }

  watch(
    viewport,
    (element, _, onCleanup) => {
      if (!element) return;
      const observer = new ResizeObserver(() =>
        reposition(scale.value, x.value, y.value),
      );
      observer.observe(element);
      onCleanup(() => observer.disconnect());
    },
    { flush: "post" },
  );

  return {
    viewport,
    scale,
    maxScale,
    transform,
    dragging,
    zoomBy,
    wheel,
    toggle,
    start,
    move,
    stop,
    reset,
  };
}
