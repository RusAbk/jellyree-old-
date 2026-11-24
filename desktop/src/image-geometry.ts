export type Point = { x: number; y: number };
export type Rectangle = Point & { width: number; height: number };
export type CropHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export type CropMode = CropHandle | "move" | "new";
export type StretchMode =
  "stretch-new" | "stretch-start" | "stretch-end" | "stretch-move";
export type Band = { start: number; end: number };
const minimum = 0.02;
export const clamp = (value: number, low = 0, high = 1) =>
  Math.max(low, Math.min(high, value));

function rectangle(
  x: number,
  y: number,
  width: number,
  height: number,
): Rectangle {
  width = clamp(width, minimum);
  height = clamp(height, minimum);
  return {
    x: clamp(x, 0, 1 - width),
    y: clamp(y, 0, 1 - height),
    width,
    height,
  };
}

export function dragCrop(
  mode: CropMode,
  original: Rectangle,
  start: Point,
  pointer: Point,
  image: { width: number; height: number },
  aspect?: number,
): Rectangle {
  const { x, y, width, height } = original;
  const dx = pointer.x - start.x,
    dy = pointer.y - start.y;
  if (mode === "move") return rectangle(x + dx, y + dy, width, height);

  const horizontal =
    mode === "new"
      ? dx < 0
        ? -1
        : 1
      : mode.includes("e")
        ? 1
        : mode.includes("w")
          ? -1
          : 0;
  const vertical =
    mode === "new"
      ? dy < 0
        ? -1
        : 1
      : mode.includes("s")
        ? 1
        : mode.includes("n")
          ? -1
          : 0;
  let anchorX =
    mode === "new"
      ? start.x
      : x + (horizontal === -1 ? width : horizontal === 0 ? width / 2 : 0);
  let anchorY =
    mode === "new"
      ? start.y
      : y + (vertical === -1 ? height : vertical === 0 ? height / 2 : 0);
  // Keep the opposite corner/edge fixed. A pointer on the canvas boundary can
  // reach that edge even when the handle was grabbed off its center.
  const edgeX =
    pointer.x <= 0 || pointer.x >= 1 || mode === "new"
      ? pointer.x
      : x + (horizontal === 1 ? width : 0) + dx;
  const edgeY =
    pointer.y <= 0 || pointer.y >= 1 || mode === "new"
      ? pointer.y
      : y + (vertical === 1 ? height : 0) + dy;
  const ratio = aspect ? (aspect * image.height) / image.width : 0;
  const minWidth = ratio ? Math.max(minimum, minimum * ratio) : minimum;
  const minHeight = ratio ? minWidth / ratio : minimum;
  if (ratio && (minWidth > 1 || minHeight > 1)) return original;
  if (mode === "new") {
    anchorX =
      horizontal === 1
        ? clamp(anchorX, 0, 1 - minWidth)
        : clamp(anchorX, minWidth);
    anchorY =
      vertical === 1
        ? clamp(anchorY, 0, 1 - minHeight)
        : clamp(anchorY, minHeight);
  }
  const maxWidth =
    horizontal === 1
      ? 1 - anchorX
      : horizontal === -1
        ? anchorX
        : 2 * Math.min(anchorX, 1 - anchorX);
  const maxHeight =
    vertical === 1
      ? 1 - anchorY
      : vertical === -1
        ? anchorY
        : 2 * Math.min(anchorY, 1 - anchorY);
  let nextWidth = horizontal ? horizontal * (edgeX - anchorX) : width;
  let nextHeight = vertical ? vertical * (edgeY - anchorY) : height;
  if (ratio) {
    const limit = Math.min(maxWidth, maxHeight * ratio);
    if (limit + 1e-8 < minWidth) return original;
    if (!horizontal) nextWidth = nextHeight * ratio;
    else if (vertical) {
      const atLimit =
        (maxWidth <= maxHeight * ratio && nextWidth >= maxWidth) ||
        (maxWidth >= maxHeight * ratio && nextHeight >= maxHeight);
      // Project the pointer onto the aspect-ratio diagonal in image pixels.
      const weight = aspect! ** 2;
      nextWidth = atLimit
        ? limit
        : (nextWidth * weight + nextHeight * ratio) / (weight + 1);
    }
    nextWidth = clamp(nextWidth, minWidth, limit);
    nextHeight = nextWidth / ratio;
  } else {
    if (horizontal) nextWidth = clamp(nextWidth, minimum, maxWidth);
    if (vertical) nextHeight = clamp(nextHeight, minimum, maxHeight);
  }
  return rectangle(
    anchorX - nextWidth * (horizontal === -1 ? 1 : horizontal === 0 ? 0.5 : 0),
    anchorY - nextHeight * (vertical === -1 ? 1 : vertical === 0 ? 0.5 : 0),
    nextWidth,
    nextHeight,
  );
}

export function dragStretch(
  mode: StretchMode,
  original: Band,
  start: number,
  source: number,
): Band {
  if (mode === "stretch-start")
    return {
      start:
        source === 0
          ? 0
          : clamp(original.start + source - start, 0, original.end - minimum),
      end: original.end,
    };
  if (mode === "stretch-end")
    return {
      start: original.start,
      end:
        source === 1
          ? 1
          : clamp(original.end + source - start, original.start + minimum),
    };
  if (mode === "stretch-move") {
    const size = original.end - original.start;
    const left = clamp(original.start + source - start, 0, 1 - size);
    return { start: left, end: Math.min(1, left + size) };
  }
  const left = clamp(Math.min(start, source), 0, 1 - minimum);
  return { start: left, end: clamp(Math.max(start, source), left + minimum) };
}
