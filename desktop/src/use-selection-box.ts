import { onBeforeUnmount, onMounted, shallowRef, type Ref } from "vue";

type Point = { x: number; y: number };
type Box = { left: number; top: number; width: number; height: number };
type Gesture = {
  content: HTMLElement;
  pointerId: number;
  origin: Point;
  start: Point;
  pointer: Point;
  additive: boolean;
  moved: boolean;
};

const interactive = [
  ".file-card",
  ".folder-card",
  ".list-heading",
  "button",
  "a",
  "input",
  "select",
  "textarea",
  "[contenteditable]",
].join(", ");

export function useSelectionBox(
  selection: Ref<string[]>,
  enabled: () => boolean,
  committed: () => void,
) {
  const box = shallowRef<Box>();
  const draft = shallowRef<Set<string>>();
  let gesture: Gesture | undefined;
  let frame = 0;

  function start(event: PointerEvent) {
    if (
      gesture ||
      !enabled() ||
      event.button !== 0 ||
      event.pointerType !== "mouse" ||
      !event.isPrimary ||
      !(event.target instanceof Element) ||
      event.target.closest(interactive)
    )
      return;
    event.preventDefault();
    const content = event.currentTarget as HTMLElement;
    const bounds = content.getBoundingClientRect();
    const pointer = { x: event.clientX, y: event.clientY };
    gesture = {
      content,
      pointerId: event.pointerId,
      origin: {
        x: pointer.x - bounds.left + content.scrollLeft,
        y: pointer.y - bounds.top + content.scrollTop,
      },
      start: pointer,
      pointer,
      additive: event.ctrlKey || event.metaKey || event.shiftKey,
      moved: false,
    };
    content.setPointerCapture(event.pointerId);
  }

  function update(current: Gesture, event: PointerEvent) {
    current.pointer = { x: event.clientX, y: event.clientY };
    current.moved ||=
      Math.hypot(
        current.pointer.x - current.start.x,
        current.pointer.y - current.start.y,
      ) >= 5;
  }

  function draw(current: Gesture) {
    const { content } = current;
    const bounds = content.getBoundingClientRect();
    const x =
      Math.min(
        content.clientWidth,
        Math.max(0, current.pointer.x - bounds.left),
      ) + content.scrollLeft;
    const y =
      Math.min(
        content.clientHeight,
        Math.max(0, current.pointer.y - bounds.top),
      ) + content.scrollTop;
    const left = Math.min(x, current.origin.x),
      right = Math.max(x, current.origin.x);
    const top = Math.min(y, current.origin.y),
      bottom = Math.max(y, current.origin.y);
    const width = right - left,
      height = bottom - top;
    const previous = box.value;
    if (
      !previous ||
      left !== previous.left ||
      top !== previous.top ||
      width !== previous.width ||
      height !== previous.height
    )
      box.value = { left, top, width, height };

    const selected = new Set(current.additive ? selection.value : []);
    const offsetX = content.scrollLeft - bounds.left;
    const offsetY = content.scrollTop - bounds.top;
    for (const card of content.querySelectorAll<HTMLElement>(
      ".file-card[data-file-id]",
    )) {
      const rect = card.getBoundingClientRect();
      if (
        left < rect.right + offsetX &&
        right > rect.left + offsetX &&
        top < rect.bottom + offsetY &&
        bottom > rect.top + offsetY
      )
        selected.add(card.dataset.fileId!);
    }
    const previousDraft = draft.value;
    if (
      !previousDraft ||
      selected.size !== previousDraft.size ||
      [...selected].some((id) => !previousDraft.has(id))
    )
      draft.value = selected;
    return selected;
  }

  function animate() {
    frame = 0;
    if (!gesture) return;
    if (!enabled()) {
      cancel();
      return;
    }
    const { content } = gesture;
    const { top } = content.getBoundingClientRect();
    const bottom = top + content.clientHeight;
    const edge = Math.min(48, content.clientHeight / 3);
    const y = gesture.pointer.y;
    const delta =
      y < top + edge ? y - (top + edge) : Math.max(0, y - (bottom - edge));
    if (delta)
      content.scrollBy(
        0,
        Math.sign(delta) * Math.min(20, Math.ceil(Math.abs(delta) / 3)),
      );
    draw(gesture);
    frame = requestAnimationFrame(animate);
  }

  function move(event: PointerEvent) {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    update(gesture, event);
    if (gesture.moved && !frame) frame = requestAnimationFrame(animate);
  }

  function cancel() {
    if (!gesture) return false;
    const { content, pointerId } = gesture;
    gesture = undefined;
    cancelAnimationFrame(frame);
    frame = 0;
    box.value = undefined;
    draft.value = undefined;
    if (content.hasPointerCapture(pointerId))
      content.releasePointerCapture(pointerId);
    return true;
  }

  function end(event: PointerEvent) {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    update(gesture, event);
    if (!enabled()) {
      cancel();
      return;
    }
    const { moved, additive } = gesture;
    if (moved) selection.value = [...draw(gesture)];
    else if (!additive) selection.value = [];
    cancel();
    if (moved || !additive) committed();
  }

  function interrupted(event: PointerEvent) {
    if (gesture?.pointerId === event.pointerId) cancel();
  }
  onMounted(() => window.addEventListener("blur", cancel));
  onBeforeUnmount(() => {
    window.removeEventListener("blur", cancel);
    cancel();
  });
  return { box, draft, start, move, end, interrupted, cancel };
}
