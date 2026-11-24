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
  let touch:
    | {
        x: number;
        y: number;
        scale: number;
        panX: number;
        panY: number;
        distance: number;
        moved: boolean;
      }
    | undefined;
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
    if (
      event.pointerType === "touch" ||
      scale.value === 1 ||
      event.button !== 0 ||
      !event.isPrimary
    )
      return;
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
    touch = undefined;
    dragging.value = false;
    reposition(1, 0, 0);
  }

  function touchPosition(event: TouchEvent) {
    const first = event.touches[0];
    const second = event.touches[1];
    if (!first) return;
    return second
      ? {
          x: (first.clientX + second.clientX) / 2,
          y: (first.clientY + second.clientY) / 2,
          distance: Math.max(
            1,
            Math.hypot(
              first.clientX - second.clientX,
              first.clientY - second.clientY,
            ),
          ),
        }
      : { x: first.clientX, y: first.clientY, distance: 0 };
  }

  function touchStart(event: TouchEvent) {
    const point = touchPosition(event);
    if (point)
      touch = {
        ...point,
        scale: scale.value,
        panX: x.value,
        panY: y.value,
        moved: !!touch?.moved,
      };
  }

  function touchMove(event: TouchEvent) {
    const point = touchPosition(event);
    const box = viewport.value?.getBoundingClientRect();
    if (!touch || !point || !box) return;
    const next =
      point.distance && touch.distance
        ? clamp((touch.scale * point.distance) / touch.distance, 1, maxScale)
        : touch.scale;
    const ratio = next / touch.scale;
    const tx = box.left + box.width / 2;
    const ty = box.top + box.height / 2;
    if (point.distance || next > 1) {
      touch.moved = true;
      reposition(
        next,
        point.x - tx + (touch.panX - touch.x + tx) * ratio,
        point.y - ty + (touch.panY - touch.y + ty) * ratio,
      );
    }
  }

  function touchEnd(event: TouchEvent) {
    const previous = touch;
    touch = undefined;
    if (!previous || event.type === "touchcancel") return 0;
    if (event.touches.length) {
      touchStart(event);
      if (touch) (touch as { moved: boolean }).moved = true;
      return 0;
    }
    const last = event.changedTouches[0];
    if (previous.moved || previous.scale > 1 || previous.distance || !last)
      return 0;
    const dx = last.clientX - previous.x;
    const dy = last.clientY - previous.y;
    return Math.abs(dx) >= 55 && Math.abs(dx) > Math.abs(dy) * 1.4
      ? dx < 0
        ? 1
        : -1
      : 0;
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
    touchStart,
    touchMove,
    touchEnd,
  };
}
