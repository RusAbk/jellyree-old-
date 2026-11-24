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
  ".page-header",
  ".breadcrumbs",
  ".toolbar-area",
  ".preview-settings",
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
    const pointer = { x: event.clientX, y: event.clientY };
    gesture = {
      content,
      pointerId: event.pointerId,
      origin: { x: pointer.x + window.scrollX, y: pointer.y + window.scrollY },
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
    const bounds = current.content.getBoundingClientRect();
    const x = Math.min(bounds.right, Math.max(bounds.left, current.pointer.x));
    const y = Math.min(bounds.bottom, Math.max(bounds.top, current.pointer.y));
    const originX = current.origin.x - window.scrollX;
    const originY = current.origin.y - window.scrollY;
    const left = Math.min(x, originX),
      right = Math.max(x, originX);
    const top = Math.min(y, originY),
      bottom = Math.max(y, originY);
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
    for (const card of current.content.querySelectorAll<HTMLElement>(
      ".file-card[data-file-id]",
    )) {
      const rect = card.getBoundingClientRect();
      if (
        left < rect.right &&
        right > rect.left &&
        top < rect.bottom &&
        bottom > rect.top
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
    const edge = 48;
    const y = gesture.pointer.y;
    const delta =
      y < edge ? y - edge : Math.max(0, y - (window.innerHeight - edge));
    if (delta)
      window.scrollBy(
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
